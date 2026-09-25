import assert from "node:assert/strict";
import path from "node:path";
import { afterEach } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createSqliteWorkerOperationAdmission } from "./sqlite-worker-operation-admission.js";
import {
  openSqliteWorkerStore,
  openAgentDatabaseSqliteWorkerStore,
  openSharedStateSqliteWorkerStore,
  type SqliteWorkerStore,
} from "./sqlite-worker-store.js";
import type { FixtureOpenInput, FixtureOperations } from "./sqlite-worker-store.test-support.js";
import * as coordinatorOwner from "./state-database-coordinator.js";

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
    openWithGateway: async (file: string, owner: "agent" | "shared" = "shared") => {
      const root = path.dirname(file);
      const gateway = coordinatorOwner.acquireGatewayLifecycleCoordinator({
        databasePath: file,
        runtimeDirectory: root,
      });
      try {
        const options = {
          moduleUrl: new URL("./sqlite-worker-store.test-support.ts", import.meta.url),
          databasePath: file,
          input: undefined,
        };
        const stateContext = {
          environment: { OPENCLAW_STATE_DIR: root },
          coordinatorRuntime: { directory: root, keepAlive: false as const },
        };
        const store =
          owner === "agent"
            ? await openAgentDatabaseSqliteWorkerStore<FixtureOperations>(options, {
                stateContext,
                stateDatabasePath: file,
                assertCurrent() {},
                createAdmission: () => ({
                  nativeLocations: [file],
                  admission: createSqliteWorkerOperationAdmission((_request, grant) => {
                    grant();
                  }),
                }),
              })
            : await openSharedStateSqliteWorkerStore<FixtureOperations>(options, stateContext);
        assert(store, "Fixture shared-state worker did not open");
        stores.add(store);
        return { store, gateway };
      } catch (error) {
        gateway.release();
        throw error;
      }
    },
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
