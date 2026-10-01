import { SESSION_ROSTER_DB_NAME, SESSION_ROSTER_STORE_NAME } from "./session-roster-cache.ts";

export function rosterRequestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.addEventListener("success", () => resolve(request.result));
    request.addEventListener("error", () =>
      reject(request.error ?? new Error("IndexedDB request failed")),
    );
    request.addEventListener("blocked", () => reject(new Error("IndexedDB open was blocked")));
  });
}

export function rosterTransactionDone(transaction: IDBTransaction): Promise<void> {
  const completed = new Promise<void>((resolve, reject) => {
    transaction.addEventListener("complete", () => resolve());
    transaction.addEventListener("error", () =>
      reject(transaction.error ?? new Error("IndexedDB transaction failed")),
    );
    transaction.addEventListener("abort", () =>
      reject(transaction.error ?? new Error("IndexedDB transaction failed")),
    );
  });
  // A failed request can leave its caller before the transaction is awaited.
  void completed.catch(() => undefined);
  return completed;
}

export async function resetSessionRosterDatabase(): Promise<void> {
  try {
    if (globalThis.indexedDB) {
      await new Promise<void>((resolve) => {
        const request = indexedDB.deleteDatabase(SESSION_ROSTER_DB_NAME);
        request.addEventListener("success", () => resolve());
        request.addEventListener("error", () => resolve());
        request.addEventListener("blocked", () => resolve());
      });
    }
  } catch {
    // Storage access can be denied independently of the Gateway connection.
  }
}

export async function openSessionRosterDatabase(): Promise<IDBDatabase | null> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      if (!globalThis.indexedDB) {
        return null;
      }
      const request = indexedDB.open(SESSION_ROSTER_DB_NAME, 1);
      request.addEventListener("upgradeneeded", () => {
        for (const name of Array.from(request.result.objectStoreNames)) {
          request.result.deleteObjectStore(name);
        }
        request.result.createObjectStore(SESSION_ROSTER_STORE_NAME, { keyPath: "scope" });
      });
      const database = await rosterRequestResult(request);
      database.addEventListener("versionchange", () => database.close());
      if (
        database.objectStoreNames.length === 1 &&
        database.objectStoreNames.contains(SESSION_ROSTER_STORE_NAME) &&
        database.transaction(SESSION_ROSTER_STORE_NAME).objectStore(SESSION_ROSTER_STORE_NAME)
          .keyPath === "scope"
      ) {
        return database;
      }
      database.close();
    } catch {
      // Browser caches are optional, including when storage is disabled or unavailable.
    }
    if (attempt === 0) {
      await resetSessionRosterDatabase();
    }
  }
  return null;
}
