import { listen } from "../reactive/listener.ts";

const DATABASE_NAME = "openclaw-control-ui";
const DATABASE_VERSION = 2;
const STORE_NAME = "composerDrafts";
const OWNER_INDEX = "ownerKey";
let databasePromise: Promise<IDBDatabase> | null = null;
const once = { once: true };

// Callers may observe the same handle independently; listeners stay additive.
export function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    listen(request, "success", () => resolve(request.result), once);
    listen(
      request,
      "error",
      () => reject(request.error ?? new Error("IndexedDB request failed")),
      once,
    );
  });
}

export function transactionComplete(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    listen(transaction, "complete", () => resolve(), once);
    const failed = (event: Event) =>
      reject(
        transaction.error ??
          new Error(`IndexedDB transaction ${event.type === "abort" ? "aborted" : "failed"}`),
      );
    listen(transaction, "abort", failed, once);
    listen(transaction, "error", failed, once);
  });
}

export function openControlUiDatabase(): Promise<IDBDatabase> {
  if (databasePromise) {
    return databasePromise;
  }
  if (typeof indexedDB === "undefined") {
    return Promise.reject(new Error("IndexedDB is unavailable"));
  }
  const opening = new Promise<IDBDatabase>((resolve, reject) => {
    const release = () => {
      if (databasePromise === opening) {
        databasePromise = null;
      }
    };
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    listen(
      request,
      "upgradeneeded",
      () => {
        const database = request.result;
        if (!database.objectStoreNames.contains("outboxPayloads")) {
          database.createObjectStore("outboxPayloads", { keyPath: "key" });
        }
        const store = database.objectStoreNames.contains(STORE_NAME)
          ? request.transaction?.objectStore(STORE_NAME)
          : database.createObjectStore(STORE_NAME, { keyPath: "key" });
        if (store && !store.indexNames.contains(OWNER_INDEX)) {
          store.createIndex(OWNER_INDEX, OWNER_INDEX, { unique: false });
        }
      },
      once,
    );
    let blocked = false;
    listen(
      request,
      "success",
      () => {
        const database = request.result;
        if (blocked) {
          database.close();
          release();
          return;
        }
        // Browser-forced closure does not emit versionchange; never reuse its dead handle.
        listen(database, "close", release, once);
        listen(database, "versionchange", () => {
          database.close();
          release();
        });
        resolve(database);
      },
      once,
    );
    listen(
      request,
      "error",
      () => {
        release();
        reject(request.error ?? new Error("IndexedDB open failed"));
      },
      once,
    );
    listen(
      request,
      "blocked",
      () => {
        // Keep the rejected promise until this open finishes. A second open
        // queues behind it and would otherwise wait forever without a blocked event.
        blocked = true;
        reject(new Error("IndexedDB upgrade was blocked"));
      },
      once,
    );
  });
  databasePromise = opening;
  return opening;
}
