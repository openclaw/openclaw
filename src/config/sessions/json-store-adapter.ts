import {
  listSessionStoreRecordEntries,
  type SessionStoreAdapter,
  type SessionStoreListOptions,
  type SessionStoreMutationOptions,
  type SessionStoreRecord,
} from "./storage-adapter.js";
import {
  loadSessionStore,
  readSessionEntry,
  saveSessionStore,
  updateSessionStore,
} from "./store.js";

export const jsonSessionStoreAdapter: SessionStoreAdapter = {
  kind: "json",
  async loadStore(storePath: string): Promise<SessionStoreRecord> {
    return loadSessionStore(storePath);
  },
  async readEntry(storePath: string, sessionKey: string) {
    return readSessionEntry(storePath, sessionKey) as SessionStoreRecord[string] | undefined;
  },
  async listEntries(storePath: string, options?: SessionStoreListOptions) {
    return listSessionStoreRecordEntries(loadSessionStore(storePath), options);
  },
  async saveStore(
    storePath: string,
    store: SessionStoreRecord,
    options?: SessionStoreMutationOptions,
  ): Promise<void> {
    await saveSessionStore(storePath, store, options);
  },
  async writeEntries(storePath: string, entries, options?: SessionStoreMutationOptions) {
    if (entries.length === 0) {
      return;
    }
    await updateSessionStore(
      storePath,
      (store) => {
        for (const [sessionKey, entry] of entries) {
          store[sessionKey] = structuredClone(entry);
        }
      },
      options,
    );
  },
  async deleteEntries(storePath: string, sessionKeys, options?: SessionStoreMutationOptions) {
    if (sessionKeys.length === 0) {
      return;
    }
    await updateSessionStore(
      storePath,
      (store) => {
        for (const sessionKey of sessionKeys) {
          delete store[sessionKey];
        }
      },
      options,
    );
  },
  async updateStore<T>(
    storePath: string,
    mutator: (store: SessionStoreRecord) => T | Promise<T>,
    options?: SessionStoreMutationOptions,
  ): Promise<T> {
    return await updateSessionStore(storePath, mutator, options);
  },
};
