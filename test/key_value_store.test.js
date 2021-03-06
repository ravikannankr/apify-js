import sinon from 'sinon';
import path from 'path';
import { ENV_VARS, KEY_VALUE_STORE_KEYS } from 'apify-shared/consts';
import { KeyValueStoreLocal, KeyValueStore, maybeStringify, getFileNameRegexp, LOCAL_STORAGE_SUBDIR } from '../build/key_value_store';
import * as utils from '../build/utils';
import * as Apify from '../build/index';
import { expectDirEmpty, expectDirNonEmpty } from './_helper';
import LocalStorageDirEmulator from './local_storage_dir_emulator';

const { apifyClient } = utils;

describe('KeyValueStore', () => {
    let localStorageEmulator;
    let localStorageDir;

    beforeAll(async () => {
        apifyClient.setOptions({ token: 'xxx' });
        localStorageEmulator = new LocalStorageDirEmulator();
        await localStorageEmulator.init();
        localStorageDir = localStorageEmulator.localStorageDir; // eslint-disable-line
    });

    afterAll(async () => {
        apifyClient.setOptions({ token: undefined });
        await localStorageEmulator.destroy();
    });

    beforeEach(async () => {
        await localStorageEmulator.clean();
    });

    describe('maybeStringify()', () => {
        test('should work', () => {
            expect(maybeStringify({ foo: 'bar' }, { contentType: null })).toBe('{\n  "foo": "bar"\n}');
            expect(maybeStringify({ foo: 'bar' }, { contentType: undefined })).toBe('{\n  "foo": "bar"\n}');

            expect(maybeStringify('xxx', { contentType: undefined })).toBe('"xxx"');
            expect(maybeStringify('xxx', { contentType: 'something' })).toBe('xxx');

            const obj = {};
            obj.self = obj;
            expect(() => maybeStringify(obj, { contentType: null })).toThrowError(
                'The "value" parameter cannot be stringified to JSON: Converting circular structure to JSON',
            );
        });
    });

    describe('getFileNameRegexp()', () => {
        test('should work', () => {
            const key = 'hel.lo';
            const filenames = [
                'hel.lo.txt', // valid
                'hel.lo.hello.txt',
                'hel.lo.mp3', // valid
                'hel.lo....',
                'hel.lo.hello', // valid
                'hello.hel.lo',
                'hel.lo.',
                '.hel.lo',
                'hel.lo',
                'helXlo.bin',
            ];
            const matched = filenames.reduce((count, name) => (getFileNameRegexp(key).test(name) ? ++count : count), 0);
            expect(matched).toBe(3);
        });
    });

    describe('local', () => {
        test('should work', async () => {
            const store = new KeyValueStoreLocal('my-store-id', localStorageDir);
            const store2 = new KeyValueStoreLocal('another-store-id', localStorageDir);
            const buffer = Buffer.from('some text value');

            await store.setValue('key-obj', { foo: 'bar' });
            await store.setValue('key-string', 'xxxx', { contentType: 'text/plain' });
            await store.setValue('key-buffer', buffer, { contentType: 'image/jpeg' });
            await store2.setValue('key-obj', { foo: 'hotel' });
            await store2.setValue('key-string', 'yyyy', { contentType: 'text/plain' });
            await store2.setValue('key-ctype', buffer, { contentType: 'video/mp4' });
            await store2.setValue('key-badctype', buffer, { contentType: 'nonexistent/content-type' });

            // Try to read store2/key-string.
            expect(await store2.getValue('key-string')).toBe('yyyy');

            // Try to delete store2/key-string with an error.
            try {
                await store2.setValue('key-string', null, { contentType: 'text/plain' });
                throw new Error('This should throw!!!');
            } catch (err) {
                expect(err).toBeInstanceOf(Error);
                expect(err.message).not.toMatch('This should throw!!!');
            }

            // Check that it still exists.
            expect(await store2.getValue('key-string')).toBe('yyyy');

            // Try to delete store2/key-string again.
            await store2.setValue('key-string', null);

            // Check that it doesn't exist.
            expect(await store2.getValue('key-string')).toBe(null);

            expect(await store.getValue('key-obj')).toEqual({ foo: 'bar' });
            expect(await store.getValue('key-string')).toBe('xxxx');
            expect(await store.getValue('key-buffer')).toEqual(buffer);
            expect(await store.getValue('key-nonexist')).toBe(null);
            expect(await store2.getValue('key-obj')).toEqual({ foo: 'hotel' });
            expect(await store2.getValue('key-ctype')).toEqual(buffer);
            expect(await store2.getValue('key-badctype')).toEqual(buffer);

            // Drop works.
            const storeDir = path.join(localStorageDir, LOCAL_STORAGE_SUBDIR, 'my-store-id');
            expectDirNonEmpty(storeDir);
            await store.drop();
            expectDirEmpty(storeDir);
        });

        test('deprecated delete() still works', async () => {
            const kvs = new KeyValueStoreLocal('to-delete', localStorageDir);
            await kvs.setValue('dummy', { foo: 'bar' });

            const kvsDir = path.join(localStorageDir, LOCAL_STORAGE_SUBDIR, 'to-delete');
            expectDirNonEmpty(kvsDir);
            await kvs.delete();
            expectDirEmpty(kvsDir);
        });
    });

    describe('remote', () => {
        test('works', async () => {
            const store = new KeyValueStore('some-id-1');
            const mock = sinon.mock(apifyClient.keyValueStores);
            const record = { foo: 'bar' };
            const recordStr = JSON.stringify(record, null, 2);

            // Set.
            mock.expects('putRecord')
                .once()
                .withArgs({
                    storeId: 'some-id-1',
                    key: 'key-1',
                    body: recordStr,
                    contentType: 'application/json; charset=utf-8',
                })
                .returns(Promise.resolve(null));
            await store.setValue('key-1', record);

            // Get.
            mock.expects('getRecord')
                .once()
                .withArgs({
                    storeId: 'some-id-1',
                    key: 'key-1',
                })
                .returns(Promise.resolve({ body: record, contentType: 'application/json; charset=utf-8' }));
            const response = await store.getValue('key-1');
            expect(response).toEqual(record);

            // Delete.
            mock.expects('deleteRecord')
                .once()
                .withArgs({
                    storeId: 'some-id-1',
                    key: 'key-1',
                })
                .returns(Promise.resolve(null));
            await store.setValue('key-1', null);

            // Drop.
            mock.expects('deleteStore')
                .once()
                .withArgs({
                    storeId: 'some-id-1',
                })
                .returns(Promise.resolve());
            await store.drop();

            mock.verify();
            mock.restore();
        });

        test('deprecated delete() still works', async () => {
            const mock = sinon.mock(apifyClient.keyValueStores);
            const kvs = new KeyValueStore('some-id', 'some-name');
            mock.expects('deleteStore')
                .once()
                .withArgs({ storeId: 'some-id' })
                .resolves();

            await kvs.drop();

            mock.verify();
        });
    });

    describe('Apify.openKeyValueStore', () => {
        test('should work', async () => {
            const mock = sinon.mock(utils);

            process.env[ENV_VARS.LOCAL_STORAGE_DIR] = localStorageDir;

            mock.expects('openLocalStorage').once();
            await Apify.openKeyValueStore();

            mock.expects('openLocalStorage').once();
            Apify.openKeyValueStore('xxx');
            mock.expects('openRemoteStorage').once();
            Apify.openKeyValueStore('xxx', { forceCloud: true });

            delete process.env[ENV_VARS.LOCAL_STORAGE_DIR];
            process.env[ENV_VARS.TOKEN] = 'xxx';

            mock.expects('openRemoteStorage').once();
            await Apify.openKeyValueStore();

            delete process.env[ENV_VARS.TOKEN];

            mock.verify();
            mock.restore();
        });
    });

    describe('getValue', () => {
        test('throws on invalid args', async () => {
            process.env[ENV_VARS.DEFAULT_KEY_VALUE_STORE_ID] = '1234';
            process.env[ENV_VARS.LOCAL_STORAGE_DIR] = localStorageDir;
            await expect(Apify.getValue()).rejects.toThrow('Parameter "key" of type String must be provided');
            await expect(Apify.getValue({})).rejects.toThrow('Parameter "key" of type String must be provided');
            await expect(Apify.getValue('')).rejects.toThrow('The "key" parameter cannot be empty');
            await expect(Apify.getValue(null)).rejects.toThrow('Parameter "key" of type String must be provided');
            delete process.env[ENV_VARS.LOCAL_STORAGE_DIR];
        });

        test(
            'throws if APIFY_DEFAULT_KEY_VALUE_STORE_ID env var is not defined and we use cloud storage',
            async () => {
                delete process.env[ENV_VARS.LOCAL_STORAGE_DIR];
                delete process.env[ENV_VARS.DEFAULT_KEY_VALUE_STORE_ID];
                process.env[ENV_VARS.TOKEN] = 'xxx';

                const errMsg = 'The \'APIFY_DEFAULT_KEY_VALUE_STORE_ID\' environment variable is not defined';
                await expect(Apify.getValue('KEY')).rejects.toThrow(errMsg);

                delete process.env[ENV_VARS.TOKEN];
            },
        );
    });

    describe('setValue', () => {
        test('throws on invalid args', async () => {
            process.env[ENV_VARS.DEFAULT_KEY_VALUE_STORE_ID] = '12345';
            process.env[ENV_VARS.LOCAL_STORAGE_DIR] = localStorageDir;

            await expect(Apify.setValue()).rejects.toThrow('Parameter "key" of type String must be provided');
            await expect(Apify.setValue('', null)).rejects.toThrow('The "key" parameter cannot be empty');
            await expect(Apify.setValue('', 'some value')).rejects.toThrow('The "key" parameter cannot be empty');
            await expect(Apify.setValue({}, 'some value')).rejects.toThrow('Parameter "key" of type String must be provided');
            await expect(Apify.setValue(123, 'some value')).rejects.toThrow('Parameter "key" of type String must be provided');

            const valueErrMsg = 'The "value" parameter must be a String or Buffer when "options.contentType" is specified';
            await expect(Apify.setValue('key', {}, { contentType: 'image/png' })).rejects.toThrow(valueErrMsg);
            await expect(Apify.setValue('key', 12345, { contentType: 'image/png' })).rejects.toThrow(valueErrMsg);
            await expect(Apify.setValue('key', () => {}, { contentType: 'image/png' })).rejects.toThrow(valueErrMsg);

            const optsErrMsg = 'Parameter "options" of type Object must be provided';
            await expect(Apify.setValue('key', {}, 123)).rejects.toThrow(optsErrMsg);
            await expect(Apify.setValue('key', {}, 'bla/bla')).rejects.toThrow(optsErrMsg);
            await expect(Apify.setValue('key', {}, true)).rejects.toThrow(optsErrMsg);

            const circularObj = {};
            circularObj.xxx = circularObj;
            const circularErrMsg = 'The "value" parameter cannot be stringified to JSON: Converting circular structure to JSON';
            const undefinedErrMsg = 'The "value" parameter was stringified to JSON and returned undefined. '
                + 'Make sure you\'re not trying to stringify an undefined value.';
            await expect(Apify.setValue('key', circularObj)).rejects.toThrow(circularErrMsg);
            await expect(Apify.setValue('key', undefined)).rejects.toThrow(undefinedErrMsg);
            await expect(Apify.setValue('key')).rejects.toThrow(undefinedErrMsg);

            const contTypeRedundantErrMsg = 'The "options.contentType" parameter must not be used when removing the record';
            await expect(Apify.setValue('key', null, { contentType: 'image/png' })).rejects.toThrow(contTypeRedundantErrMsg);
            await expect(Apify.setValue('key', null, { contentType: '' })).rejects.toThrow(contTypeRedundantErrMsg);
            await expect(Apify.setValue('key', null, { contentType: {} }))
                .rejects.toThrow('Parameter "options.contentType" of type String | Null | Undefined must be provided');

            const contTypeStringErrMsg = 'Parameter "options.contentType" of type String | Null | Undefined must be provided';
            await expect(Apify.setValue('key', 'value', { contentType: 123 })).rejects.toThrow(contTypeStringErrMsg);
            await expect(Apify.setValue('key', 'value', { contentType: {} })).rejects.toThrow(contTypeStringErrMsg);
            await expect(Apify.setValue('key', 'value', { contentType: new Date() })).rejects.toThrow(contTypeStringErrMsg);
            await expect(Apify.setValue('key', 'value', { contentType: '' }))
                .rejects.toThrow('Parameter options.contentType cannot be empty string.');

            delete process.env[ENV_VARS.LOCAL_STORAGE_DIR];
        });

        test('throws on invalid key', async () => {
            const store = new KeyValueStoreLocal('my-store-id', localStorageDir);
            const INVALID_CHARACTERS = '?|\\/"*<>%:';
            let counter = 0;

            for (const char of INVALID_CHARACTERS) { // eslint-disable-line
                try {
                    await store.setValue(`my_id_${char}`, 'value');
                } catch (err) {
                    if (err.message.match('The "key" parameter must be at most 256 characters')) counter++;
                }
            }

            expect(counter).toEqual(INVALID_CHARACTERS.length);

            // TODO: This throws "ENAMETOOLONG: name too long, unlink" !!!
            // await store.setValue('X'.repeat(256), 'value');

            // test max length
            try {
                await store.setValue('X'.repeat(257), 'value');
            } catch (err) {
                if (err.message.match('The "key" parameter must be at most 256 characters')) counter++;
            }
        });

        test(
            'throws if APIFY_DEFAULT_KEY_VALUE_STORE_ID env var is not defined and we use cloud storage',
            async () => {
                delete process.env[ENV_VARS.DEFAULT_KEY_VALUE_STORE_ID];
                delete process.env[ENV_VARS.LOCAL_STORAGE_DIR];
                process.env[ENV_VARS.TOKEN] = 'xxx';

                const errMsg = 'The \'APIFY_DEFAULT_KEY_VALUE_STORE_ID\' environment variable is not defined';
                await expect(Apify.setValue('KEY', {})).rejects.toThrow(errMsg);

                delete process.env[ENV_VARS.TOKEN];
            },
        );

        test('correctly adds charset to content type', async () => {
            const store = new KeyValueStore('some-id-1');
            const mock = sinon.mock(apifyClient.keyValueStores);

            mock.expects('putRecord')
                .once()
                .withArgs({
                    storeId: 'some-id-1',
                    key: 'key-1',
                    body: 'xxxx',
                    contentType: 'text/plain; charset=utf-8',
                })
                .returns(Promise.resolve(null));
            await store.setValue('key-1', 'xxxx', { contentType: 'text/plain' });
            mock.verify();
            mock.restore();
        });

        test('correctly passes object values as JSON', async () => {
            const store = new KeyValueStore('some-id-1', 'some-name-1');
            const mock = sinon.mock(apifyClient.keyValueStores);
            const record = { foo: 'bar' };
            const recordStr = JSON.stringify(record, null, 2);

            mock.expects('putRecord')
                .once()
                .withArgs({
                    storeId: 'some-id-1',
                    key: 'key-1',
                    body: recordStr,
                    contentType: 'application/json; charset=utf-8',
                })
                .returns(Promise.resolve(null));
            await store.setValue('key-1', record);
            mock.verify();
            mock.restore();
        });

        test('correctly passes raw string values', async () => {
            const store = new KeyValueStore('some-id-1', 'some-name-1');
            const mock = sinon.mock(apifyClient.keyValueStores);

            mock.expects('putRecord')
                .once()
                .withArgs({
                    storeId: 'some-id-1',
                    key: 'key-1',
                    body: 'xxxx',
                    contentType: 'text/plain; charset=utf-8',
                })
                .returns(Promise.resolve(null));
            await store.setValue('key-1', 'xxxx', { contentType: 'text/plain; charset=utf-8' });
            mock.verify();
            mock.restore();
        });

        test('correctly passes raw Buffer values', async () => {
            const store = new KeyValueStore('some-id-1', 'some-name-1');
            const mock = sinon.mock(apifyClient.keyValueStores);
            const value = Buffer.from('some text value');

            mock.expects('putRecord')
                .once()
                .withArgs({
                    storeId: 'some-id-1',
                    key: 'key-1',
                    body: value,
                    contentType: 'image/jpeg; charset=something',
                })
                .returns(Promise.resolve(null));
            await store.setValue('key-1', value, { contentType: 'image/jpeg; charset=something' });
            mock.verify();
            mock.restore();
        });
    });


    describe('getPublicUrl', () => {
        test('should return the local url of a file', () => {
            process.env[ENV_VARS.LOCAL_STORAGE_DIR] = localStorageDir;
            const store = new KeyValueStoreLocal('my-store-id', localStorageDir);
            expect(store.getPublicUrl('file.txt')).toBe(`file://${store.localStoragePath}/file.txt`);
            delete process.env[ENV_VARS.LOCAL_STORAGE_DIR];
        });

        test('should return the url of a file in apify cloud', async () => {
            process.env[ENV_VARS.TOKEN] = 'xxx';
            const publicUrl = 'https://api.apify.com/v2/key-value-stores';
            const store = new KeyValueStore('my-store-id');

            expect(store.getPublicUrl('file')).toBe(`${publicUrl}/my-store-id/records/file`);
            delete process.env[ENV_VARS.TOKEN];
        });
    });

    describe('forEachKey', () => {
        test('should work remotely', async () => {
            const storeId = 'some-id-1';
            const store = new KeyValueStore(storeId, 'some-name-1');
            const mock = sinon.mock(apifyClient.keyValueStores);

            mock.expects('listKeys')
                .once()
                .withArgs({
                    storeId,
                    exclusiveStartKey: 'key0',
                })
                .resolves({
                    isTruncated: true,
                    nextExclusiveStartKey: 'key2',
                    items: [
                        { key: 'key1', size: 1 },
                        { key: 'key2', size: 2 },
                    ],
                });
            mock.expects('listKeys')
                .once()
                .withArgs({
                    storeId,
                    exclusiveStartKey: 'key2',
                })
                .resolves({
                    isTruncated: true,
                    nextExclusiveStartKey: 'key4',
                    items: [
                        { key: 'key3', size: 3 },
                        { key: 'key4', size: 4 },
                    ],
                });
            mock.expects('listKeys')
                .once()
                .withArgs({
                    storeId,
                    exclusiveStartKey: 'key4',
                })
                .resolves({
                    isTruncated: false,
                    nextExclusiveStartKey: null,
                    items: [{ key: 'key5', size: 5 }],
                });

            const results = [];
            await store.forEachKey(async (key, index, info) => {
                results.push([key, index, info]);
            }, { exclusiveStartKey: 'key0' });

            expect(results).toHaveLength(5);
            results.forEach((r, i) => {
                expect(r[2]).toEqual({ size: i + 1 });
                expect(r[1]).toEqual(i);
                expect(r[0]).toEqual(`key${i + 1}`);
            });

            mock.verify();
        });

        test('should work locally', async () => {
            const storeId = 'some-id-1';
            const store = new KeyValueStoreLocal(storeId, localStorageDir);

            for (let i = 0; i < 10; i++) {
                await store.setValue(`key${i}`, {});
            }

            const results = [];
            await store.forEachKey((key, index, info) => {
                results.push([key, index, info]);
            }, { exclusiveStartKey: 'key3' });

            expect(results).toHaveLength(6);
            results.forEach((r, i) => {
                expect(r[2]).toEqual({ size: 2 });
                expect(r[1]).toEqual(i);
                expect(r[0]).toEqual(`key${i + 4}`);
            });

            // Drop works.
            const storeDir = path.join(localStorageDir, LOCAL_STORAGE_SUBDIR, storeId);
            expectDirNonEmpty(storeDir);
            await store.drop();
            expectDirEmpty(storeDir);
        });
    });

    describe('getInput', () => {
        test('should work', async () => {
            process.env[ENV_VARS.LOCAL_STORAGE_DIR] = localStorageDir;
            const defaultStore = await Apify.openKeyValueStore();
            // Uses default value.
            const oldGet = defaultStore.getValue;
            defaultStore.getValue = async key => expect(key).toEqual(KEY_VALUE_STORE_KEYS.INPUT);
            await Apify.getInput();

            // Uses value from env var.
            process.env[ENV_VARS.INPUT_KEY] = 'some-value';
            defaultStore.getValue = async key => expect(key).toBe('some-value');
            await Apify.getInput();

            delete process.env[ENV_VARS.LOCAL_STORAGE_DIR];
            delete process.env[ENV_VARS.INPUT_KEY];

            defaultStore.getValue = oldGet;
        });
    });
});
