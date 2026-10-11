import { isIncognitoSessionKey } from "../../../../src/shared/incognito-session-key.js";
import { requestResult, transactionComplete } from "../../lib/chat/control-ui-database.runtime.ts";
import {
  sidebarSnapshotInvalidationMatches,
  type SessionSnapshotInvalidationReason,
  type SnapshotInvalidation,
} from "./session-snapshot-invalidation-events.ts";

export const CHAT_SNAPSHOT_DB_NAME = "openclaw-chat-snapshots";
export const CHAT_SNAPSHOT_STORE_NAME = "snapshots";
export const CHAT_SNAPSHOT_METADATA_STORE_NAME = "snapshotMetadata";
export const SIDEBAR_SNAPSHOT_STORE_NAME = "sidebarSnapshots";
const CHAT_SNAPSHOT_DB_VERSION = 6;

export function isPersistableChatSnapshotKey(key: string): boolean {
  return key.startsWith("scope:[") && !isIncognitoSessionKey(key.slice(key.indexOf("\u0000") + 1));
}

export function debugSnapshotStore(message: string, error?: unknown): void {
  if (error === undefined) {
    console.debug(`[chat-snapshot-cache] ${message}`);
  } else {
    console.debug(`[chat-snapshot-cache] ${message}`, error);
  }
}

function indexedDbFactory(): IDBFactory | null {
  try {
    return globalThis.indexedDB ?? null;
  } catch (error) {
    debugSnapshotStore("IndexedDB is unavailable", error);
    return null;
  }
}

function openIndexedDb(factory: IDBFactory): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = factory.open(CHAT_SNAPSHOT_DB_NAME, CHAT_SNAPSHOT_DB_VERSION);
    request.addEventListener("upgradeneeded", (event) => {
      const database = request.result;
      // Unscoped derived transcripts have no provable account owner. Never adopt them.
      if (event.oldVersion < 4) {
        for (const name of Array.from(database.objectStoreNames)) {
          database.deleteObjectStore(name);
        }
        database.createObjectStore(CHAT_SNAPSHOT_STORE_NAME, { keyPath: "sessionKey" });
        database.createObjectStore(CHAT_SNAPSHOT_METADATA_STORE_NAME, { keyPath: "sessionKey" });
      }
      if (event.oldVersion < 5) {
        database.createObjectStore(SIDEBAR_SNAPSHOT_STORE_NAME, { keyPath: "sessionKey" });
      } else {
        request.transaction?.objectStore(SIDEBAR_SNAPSHOT_STORE_NAME).clear();
      }
      // The unified projection replaces this disposable cache; retirement never gates startup.
      try {
        factory
          .deleteDatabase("openclaw-session-roster")
          .addEventListener("error", (error) => error.preventDefault());
      } catch {}
    });
    request.addEventListener("success", () => resolve(request.result));
    request.addEventListener("error", () =>
      reject(request.error ?? new Error("IndexedDB open failed")),
    );
    request.addEventListener("blocked", () => reject(new Error("IndexedDB open was blocked")));
  });
}

function deleteIndexedDb(factory: IDBFactory): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      const request = factory.deleteDatabase(CHAT_SNAPSHOT_DB_NAME);
      request.addEventListener("success", () => resolve(true));
      request.addEventListener("error", () => resolve(false));
      request.addEventListener("blocked", () => resolve(false));
    } catch {
      resolve(false);
    }
  });
}

export async function openSessionSnapshotDatabase(): Promise<IDBDatabase | null> {
  const factory = indexedDbFactory();
  if (!factory) {
    return null;
  }
  let database: IDBDatabase;
  try {
    database = await openIndexedDb(factory);
  } catch (error) {
    debugSnapshotStore("resetting cache after IndexedDB open failure", error);
    if (!(await deleteIndexedDb(factory))) {
      return null;
    }
    try {
      database = await openIndexedDb(factory);
    } catch (retryError) {
      debugSnapshotStore("IndexedDB cache remains unavailable", retryError);
      return null;
    }
  }
  database.addEventListener("versionchange", () => database.close());
  if (
    database.objectStoreNames.length === 3 &&
    database.objectStoreNames.contains(CHAT_SNAPSHOT_STORE_NAME) &&
    database.objectStoreNames.contains(CHAT_SNAPSHOT_METADATA_STORE_NAME) &&
    database.objectStoreNames.contains(SIDEBAR_SNAPSHOT_STORE_NAME)
  ) {
    return database;
  }
  database.close();
  debugSnapshotStore("resetting cache after IndexedDB schema mismatch");
  if (!(await deleteIndexedDb(factory))) {
    return null;
  }
  try {
    const fresh = await openIndexedDb(factory);
    fresh.addEventListener("versionchange", () => fresh.close());
    return fresh;
  } catch (error) {
    debugSnapshotStore("IndexedDB cache reset failed", error);
    return null;
  }
}

export async function readStoredChatSnapshotRecord(sessionKey: string): Promise<unknown> {
  const database = await openSessionSnapshotDatabase();
  if (!database) {
    return undefined;
  }
  try {
    if (!isPersistableChatSnapshotKey(sessionKey)) {
      return undefined;
    }
    const transaction = database.transaction(CHAT_SNAPSHOT_STORE_NAME, "readonly");
    const [value] = await Promise.all([
      requestResult(transaction.objectStore(CHAT_SNAPSHOT_STORE_NAME).get(sessionKey)),
      transactionComplete(transaction),
    ]);
    return value;
  } catch (error) {
    debugSnapshotStore("resetting cache after IndexedDB read failure", error);
    await resetSessionSnapshotDatabase(database);
    return undefined;
  } finally {
    database.close();
  }
}

export async function resetSessionSnapshotDatabase(database?: IDBDatabase | null): Promise<void> {
  database?.close();
  const factory = indexedDbFactory();
  if (factory && !(await deleteIndexedDb(factory))) {
    debugSnapshotStore("IndexedDB cache reset was blocked");
  }
}

export async function deleteSessionSnapshotEntries(
  key: string,
  match: "key" | "prefix",
  reason?: SessionSnapshotInvalidationReason,
): Promise<void> {
  const byPrefix = match === "prefix";
  const invalidation: SnapshotInvalidation = byPrefix
    ? { scopePrefix: key }
    : { sessionKey: key, reason };
  const database = await openSessionSnapshotDatabase();
  if (!database) {
    return;
  }
  try {
    await new Promise<void>((resolve) => {
      const names = [
        CHAT_SNAPSHOT_STORE_NAME,
        CHAT_SNAPSHOT_METADATA_STORE_NAME,
        SIDEBAR_SNAPSHOT_STORE_NAME,
      ];
      const transaction = database.transaction(names, "readwrite");
      for (const event of ["complete", "error", "abort"]) {
        transaction.addEventListener(event, () => resolve(), byPrefix ? { once: true } : undefined);
      }
      for (const name of names) {
        const store = transaction.objectStore(name);
        if (!byPrefix && name !== SIDEBAR_SNAPSHOT_STORE_NAME) {
          store.delete(key);
          continue;
        }
        const request = store.openKeyCursor();
        request.onsuccess = () => {
          const cursor = request.result;
          if (!cursor) {
            return;
          }
          if (
            typeof cursor.primaryKey === "string" &&
            (name === SIDEBAR_SNAPSHOT_STORE_NAME
              ? sidebarSnapshotInvalidationMatches(cursor.primaryKey, invalidation)
              : cursor.primaryKey.startsWith(key))
          ) {
            store.delete(cursor.primaryKey);
          }
          cursor.continue();
        };
      }
    });
  } catch (error) {
    // Scope clearing reports setup failures; single-record invalidation is best effort.
    if (byPrefix) {
      throw error;
    }
  } finally {
    database.close();
  }
}
