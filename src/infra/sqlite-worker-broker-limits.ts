export const SQLITE_WORKER_DEFAULT_MAX_STORES = 64;
export const SQLITE_WORKER_MAX_STORES_LIMIT = 16_384;

let publishedMaxStores = SQLITE_WORKER_DEFAULT_MAX_STORES;

export function assertSqliteWorkerMaxStores(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > SQLITE_WORKER_MAX_STORES_LIMIT) {
    throw new RangeError(
      "SQLite worker store limit must be an integer between 1 and " +
        String(SQLITE_WORKER_MAX_STORES_LIMIT),
    );
  }
  return value;
}

/** Publish the store budget resolved from the active runtime configuration. */
export function setSqliteWorkerMaxStores(value: number): void {
  publishedMaxStores = assertSqliteWorkerMaxStores(value);
}

/** Read the published store budget; the broker is process-global, so this is too. */
export function currentSqliteWorkerMaxStores(): number {
  return publishedMaxStores;
}
