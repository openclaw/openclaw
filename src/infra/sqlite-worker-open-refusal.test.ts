import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { Worker } from "node:worker_threads";
import { expect, it, vi } from "vitest";
import { drainGlobalSingletonLifecycleState } from "../shared/global-singleton.js";
import {
  useSqliteWorkerStoreFixture,
  appendWorkerRow as append,
  readWorkerRows as read,
} from "./sqlite-worker-fixture.test-support.js";
import { createSqliteWorkerOperationAdmission } from "./sqlite-worker-operation-admission.js";
import {
  closeUnclaimedSharedStateSqliteWorkers,
  hasUnclaimedSharedStateSqliteCleanup,
  openAgentDatabaseSqliteWorkerStore,
} from "./sqlite-worker-store.js";
import type { FixtureOperations } from "./sqlite-worker-store.test-support.js";
import * as coordinatorOwner from "./state-database-coordinator.js";

vi.mock("node:os", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:os")>()),
  availableParallelism: () => 32,
}));

const { stores, databasePath, open } = useSqliteWorkerStoreFixture(
  "openclaw-sqlite-worker-open-refusal-",
);

it.skipIf(Boolean(process.versions.bun))(
  "retains pending Gateway cleanup after a pre-factory refusal without retiring pooled siblings",
  async () => {
    const file = databasePath();
    const root = path.dirname(file);
    const seeded = await open(file);
    await seeded.close();
    const siblings = [];
    for (let index = 0; index < 4; index++) {
      const store = await open(databasePath());
      siblings.push({ store, receipt: await append(store, "before refusal") });
    }
    const gateway = coordinatorOwner.acquireGatewayLifecycleCoordinator({
      databasePath: file,
      runtimeDirectory: root,
    });
    const refused = new Error("Fixture opening authority revoked");
    const cleanupError = new Error("Fixture Gateway release failed before native cleanup");
    const createDelegate = coordinatorOwner.tryCreateGatewaySchemaFenceDelegate;
    let retained: ReturnType<typeof createDelegate>;
    const release = vi.fn(() => {
      if (release.mock.calls.length === 1) {
        throw cleanupError;
      }
      retained?.release();
    });
    const delegation = vi
      .spyOn(coordinatorOwner, "tryCreateGatewaySchemaFenceDelegate")
      .mockImplementationOnce((params) => {
        retained = createDelegate(params);
        assert(retained, "Fixture Gateway delegate was not acquired");
        const original = retained;
        return {
          port: original.port,
          get closed() {
            return original.closed;
          },
          release,
        };
      });
    const markerPath = path.join(root, "factory-entered");
    const reopen = async () => {
      const store = await openAgentDatabaseSqliteWorkerStore<FixtureOperations>(
        {
          moduleUrl: new URL("./sqlite-worker-store.test-support.ts", import.meta.url),
          databasePath: file,
          existingOnly: true,
          input: { type: "observe", markerPath },
        },
        {
          stateContext: {
            environment: { OPENCLAW_STATE_DIR: root },
            coordinatorRuntime: { directory: root, keepAlive: false },
          },
          assertCurrent() {},
          createAdmission: () => ({
            nativeLocations: [file],
            admission: createSqliteWorkerOperationAdmission((request) => {
              expect(request).toEqual({ stage: "open", facts: { type: "observe", markerPath } });
              throw refused;
            }),
          }),
        },
      );
      if (store) {
        stores.add(store);
      }
      return store;
    };
    const requests = vi.spyOn(Worker.prototype, "postMessage");
    try {
      await expect(reopen()).rejects.toMatchObject({ errors: [refused, cleanupError] });
      const opening = requests.mock.calls.findIndex(
        ([request]) => request.type === "open" && request.databasePath === file,
      );
      const targetWorker = requests.mock.contexts[opening];
      assert(targetWorker instanceof Worker, "Expected the refused request's native Worker");
      expect(siblings.map(({ receipt }) => receipt.threadId)).toContain(targetWorker.threadId);
      await expect(readFile(markerPath)).rejects.toMatchObject({ code: "ENOENT" });
      expect(retained?.closed).toBe(false);
      expect(hasUnclaimedSharedStateSqliteCleanup(file)).toBe(true);
      await expect(reopen()).rejects.toThrow("cleanup is pending");
      expect(release).toHaveBeenCalledOnce();
      await closeUnclaimedSharedStateSqliteWorkers(file);
      expect(retained?.closed).toBe(true);
      expect(release).toHaveBeenCalledTimes(2);
      expect(hasUnclaimedSharedStateSqliteCleanup(file)).toBe(false);
      for (const { store, receipt } of siblings) {
        expect(await append(store, "after cleanup")).toEqual({ ...receipt, writes: 2 });
        expect(await read(store)).toEqual(["before refusal", "after cleanup"]);
      }
    } finally {
      requests.mockRestore();
      delegation.mockRestore();
      // Global drainage also finds the regressed actor whose pending marker was omitted.
      try {
        await drainGlobalSingletonLifecycleState();
      } finally {
        gateway.release();
      }
    }
  },
);
