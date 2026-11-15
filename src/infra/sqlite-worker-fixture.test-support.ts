import path from "node:path";
import { afterEach } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { openSqliteWorkerStore, type SqliteWorkerStore } from "./sqlite-worker-store.js";
import type { FixtureOpenInput, FixtureOperations } from "./sqlite-worker-store.test-support.js";

type Store = SqliteWorkerStore<FixtureOperations>;

export function useSqliteWorkerStoreFixture(prefix: string, beforeClose?: () => void) {
  const stores = new Set<Store>();
  const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
    afterEach(async () => {
      beforeClose?.();
      try {
        await Promise.all([...stores].map((store) => store.close()));
      } finally {
        stores.clear();
        cleanup();
      }
    }),
  );
  return {
    stores,
    tempDirs,
    databasePath: () => path.join(tempDirs.make(prefix), "store.sqlite"),
    open: async (databasePath: string, input?: FixtureOpenInput) => {
      const store = await openSqliteWorkerStore<FixtureOperations>({
        moduleUrl: new URL("./sqlite-worker-store.test-support.ts", import.meta.url),
        databasePath,
        input,
      });
      stores.add(store);
      return store;
    },
  };
}

export function appendWorkerRow(store: Store, value: string, signal?: AbortSignal) {
  return store.execute({ type: "append", input: { value } }, { signal });
}

export function readWorkerRows(store: Store) {
  return store.execute({ type: "read", input: undefined });
}
