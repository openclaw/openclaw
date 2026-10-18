import { isIncognitoSessionKey } from "../../../../src/shared/incognito-session-key.js";
import { requestResult, transactionComplete } from "../../lib/chat/control-ui-database.runtime.ts";
import { listen } from "../../lib/reactive/listener.ts";
import {
  sidebarSnapshotInvalidationMatches,
  type SessionSnapshotInvalidationReason,
  type SnapshotInvalidation,
} from "./session-snapshot-invalidation-events.ts";

export const CHAT_SNAPSHOT_DB_NAME = "openclaw-chat-snapshots";
export const CHAT_SNAPSHOT_STORE_NAME = "snapshots";
export const CHAT_SNAPSHOT_METADATA_STORE_NAME = "snapshotMetadata";
export const SIDEBAR_SNAPSHOT_STORE_NAME = "sidebarSnapshots";
const CHAT_SNAPSHOT_DB_VERSION = 8;

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

// IndexedDB requests own their one-shot listeners; database listeners end when callers close it.
// Persistence stays independent of any Solid view's lifetime.
function openIndexedDb(factory: IDBFactory): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = factory.open(CHAT_SNAPSHOT_DB_NAME, CHAT_SNAPSHOT_DB_VERSION);
    const listeners = new AbortController();
    const options = { signal: listeners.signal };
    request.addEventListener(
      "upgradeneeded",
      (event) => {
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
        } else if (event.oldVersion < 7) {
          request.transaction?.objectStore(SIDEBAR_SNAPSHOT_STORE_NAME).clear();
        }
        if (event.oldVersion >= 4 && event.oldVersion < 8) {
          // Retire unbounded transcripts without reading them onto the main thread.
          request.transaction?.objectStore(CHAT_SNAPSHOT_STORE_NAME).clear();
          request.transaction?.objectStore(CHAT_SNAPSHOT_METADATA_STORE_NAME).clear();
        }
        // The unified projection replaces this disposable cache; retirement never gates startup.
        try {
          listen(
            factory.deleteDatabase("openclaw-session-roster"),
            "error",
            (error) => error.preventDefault(),
            { once: true },
          );
        } catch {}
      },
      options,
    );
    listen(
      request,
      "success",
      () => {
        listeners.abort();
        resolve(request.result);
      },
      options,
    );
    listen(
      request,
      "error",
      () => {
        listeners.abort();
        reject(request.error ?? new Error("IndexedDB open failed"));
      },
      options,
    );
    listen(request, "blocked", () => reject(new Error("IndexedDB open was blocked")), options);
  });
}

function deleteIndexedDb(factory: IDBFactory): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      const request = factory.deleteDatabase(CHAT_SNAPSHOT_DB_NAME);
      listen(request, "success", () => resolve(true), { once: true });
      listen(request, "error", () => resolve(false), { once: true });
      listen(request, "blocked", () => resolve(false), { once: true });
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
  try {
    const database = await openIndexedDb(factory);
    listen(database, "versionchange", () => database.close(), { once: true });
    return database;
  } catch (error) {
    debugSnapshotStore("IndexedDB cache is unavailable", error);
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
    await new Promise<void>((resolve, reject) => {
      const names = [
        CHAT_SNAPSHOT_STORE_NAME,
        CHAT_SNAPSHOT_METADATA_STORE_NAME,
        SIDEBAR_SNAPSHOT_STORE_NAME,
      ];
      const transaction = database.transaction(names, "readwrite");
      void transactionComplete(transaction).then(resolve, reject);
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
    // Scope clearing reports failures; single-record invalidation is best effort.
    if (byPrefix) {
      throw error;
    }
  } finally {
    database.close();
  }
}
