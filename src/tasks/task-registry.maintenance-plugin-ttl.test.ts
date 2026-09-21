import { setTimeout as sleep } from "node:timers/promises";
import { deserialize } from "node:v8";
import { Worker } from "node:worker_threads";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred, withTestTimeout } from "../../test/helpers/promise.js";
import { executeSqliteQuerySync } from "../infra/kysely-sync.js";
import * as workerAdmission from "../infra/sqlite-worker-operation-admission.js";
import * as pluginState from "../plugin-state/plugin-state-store.js";
import { getPluginStateKysely } from "../plugin-state/plugin-state-store.kernel.js";
import { seedPluginStateEntriesForTests } from "../plugin-state/plugin-state-store.test-helpers.js";
import { withExistingOpenClawStateDatabaseReadOnly } from "../state/openclaw-state-db-readonly.js";
import { closeOpenClawStateDatabaseAsync } from "../state/openclaw-state-db.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { holdStateDatabaseCoordinator } from "../test-utils/state-database-contention.js";
import * as acpCleanup from "./task-registry-acp-cleanup.js";
import {
  resetTaskRegistryMaintenanceRuntimeForTests,
  runTaskRegistryMaintenance,
} from "./task-registry.maintenance.js";
import { configureTaskRegistryRuntime, getTaskRegistryStore } from "./task-registry.store.js";
import { resetTaskRegistryForTests } from "./task-runtime.test-helpers.js";

afterEach(() => {
  vi.restoreAllMocks();
  resetTaskRegistryMaintenanceRuntimeForTests();
  resetTaskRegistryForTests({ persist: false });
  pluginState.resetPluginStateStoreForTests({ closeDatabase: false });
});

describe("task maintenance plugin expiry", () => {
  it.each([
    "current",
    "replaced while waiting",
    "replaced at transaction",
    "replaced at commit",
  ] as const)("awaits responsive expiry with the task owner %s", async (owner) => {
    await withOpenClawTestState({ layout: "state-only" }, async () => {
      resetTaskRegistryForTests({ persist: false });
      const openingMessages = vi.spyOn(Worker.prototype, "postMessage");
      await runTaskRegistryMaintenance();
      const context = captureOpenClawStateWorkerContext();
      const openIndex = openingMessages.mock.calls.findIndex(([message]) => {
        const request = asOptionalRecord(message);
        return request?.type === "open" && request.databasePath === context.admission.databasePath;
      });
      const worker = openingMessages.mock.contexts[openIndex];
      openingMessages.mockRestore();
      if (!(worker instanceof Worker)) {
        throw new Error("Maintenance did not open its shared-state worker");
      }
      const originalStore = getTaskRegistryStore();
      const scope = { pluginId: "maintenance-proof", namespace: "expiry" };
      const now = Date.now();
      const expiresWhileHeldAt = now + 1_000;
      seedPluginStateEntriesForTests([
        { ...scope, key: "ttl:expired", value: "expired", expiresAt: now - 1 },
        {
          ...scope,
          key: "ttl:expires-while-held",
          value: "live before admission",
          expiresAt: expiresWhileHeldAt,
        },
        { ...scope, key: "ttl:permanent", value: { keep: true } },
        {
          ...scope,
          key: "ttl:future",
          value: "keep until tomorrow",
          expiresAt: now + 86_400_000,
        },
      ]);
      const readRows = () =>
        withExistingOpenClawStateDatabaseReadOnly(
          ({ db }) =>
            executeSqliteQuerySync(
              db,
              getPluginStateKysely(db)
                .selectFrom("plugin_state_entries")
                .selectAll()
                .orderBy("plugin_id", "asc")
                .orderBy("namespace", "asc")
                .orderBy("entry_key", "asc"),
            ).rows,
        ) ?? [];
      const before = readRows();
      expect(before).toHaveLength(4);
      let holder: ReturnType<typeof holdStateDatabaseCoordinator> | undefined;
      const actualCleanup = acpCleanup.cleanupOrphanedParentOwnedAcpSessions;
      const cleanupObserver = vi
        .spyOn(acpCleanup, "cleanupOrphanedParentOwnedAcpSessions")
        .mockImplementationOnce(async (...args) => {
          await actualCleanup(...args);
          holder = holdStateDatabaseCoordinator(
            context.admission.databasePath,
            context.coordinatorRuntime,
            5_000,
          );
          await holder.ready;
        });
      const timerObserved = createDeferred<number>();
      const requestPosted = createDeferred();
      let sweepRequestPosted = false;
      const nativeStages: Array<"transaction" | "commit"> = [];
      let timer: ReturnType<typeof setTimeout> | undefined;
      let liveAtSweepEntry = false;
      let sweep: Promise<number> | undefined;
      let maintenance: ReturnType<typeof runTaskRegistryMaintenance> | undefined;
      let maintenanceSettled = false;
      const actualSweep = pluginState.sweepExpiredPluginStateEntries;
      const sweepObserver = vi
        .spyOn(pluginState, "sweepExpiredPluginStateEntries")
        .mockImplementation((...args) => {
          const held = holder;
          if (!held) {
            throw new Error("Expiry entered before the post-cleanup coordinator hold");
          }
          liveAtSweepEntry = Date.now() < expiresWhileHeldAt;
          timer = setTimeout(() => {
            timer = undefined;
            timerObserved.resolve(Atomics.load(held.released, 0));
          }, 0);
          const result = actualSweep(...args);
          sweep = Promise.resolve(result);
          void sweep.catch(() => undefined);
          return result;
        });
      const postMessage = worker.postMessage.bind(worker);
      const postObserver = vi
        .spyOn(worker, "postMessage")
        .mockImplementation((message, transferList) => {
          const request = asOptionalRecord(message);
          if (
            request?.type === "execute" &&
            request.input instanceof Uint8Array &&
            asOptionalRecord(deserialize(request.input))?.type === "pluginState.sweep"
          ) {
            sweepRequestPosted = true;
            requestPosted.resolve();
          }
          return postMessage(message, transferList);
        });
      const createAdmission = workerAdmission.createSqliteWorkerOperationAdmission;
      const admissionObserver = vi
        .spyOn(workerAdmission, "createSqliteWorkerOperationAdmission")
        .mockImplementation((admit) =>
          createAdmission((request, grant) => {
            if (
              sweepRequestPosted &&
              (request.stage === "transaction" || request.stage === "commit")
            ) {
              nativeStages.push(request.stage);
              if (owner === `replaced at ${request.stage}`) {
                configureTaskRegistryRuntime({ store: { ...originalStore } });
              }
            }
            admit(request, grant);
          }),
        );
      try {
        maintenance = runTaskRegistryMaintenance();
        void maintenance.then(
          () => {
            maintenanceSettled = true;
          },
          () => {
            maintenanceSettled = true;
          },
        );
        expect(
          await withTestTimeout(timerObserved.promise, 10_000, "Maintenance did not enter expiry"),
        ).toBe(0);
        const held = holder;
        if (!held) {
          throw new Error("Maintenance did not reach the post-cleanup coordinator hold");
        }
        expect(maintenanceSettled).toBe(false);
        await withTestTimeout(
          requestPosted.promise,
          5_000,
          "Expiry request was not posted to its worker",
        );
        expect(Atomics.load(held.released, 0)).toBe(0);
        expect(maintenanceSettled).toBe(false);
        if (owner === "replaced while waiting") {
          configureTaskRegistryRuntime({ store: { ...originalStore } });
        } else {
          expect(liveAtSweepEntry).toBe(true);
          while (Date.now() <= expiresWhileHeldAt) {
            await sleep(Math.max(1, expiresWhileHeldAt - Date.now() + 1));
          }
          expect(Atomics.load(held.released, 0)).toBe(0);
          expect(maintenanceSettled).toBe(false);
        }
        held.release();
        await expect(held.joined).resolves.toBe(0);
        if (owner === "current") {
          await expect(maintenance).resolves.toEqual({
            reconciled: 0,
            recovered: 0,
            cleanupStamped: 0,
            pruned: 0,
          });
          await expect(sweep).resolves.toBe(2);
          expect(readRows()).toStrictEqual(
            before.filter(
              (row) => row.entry_key === "ttl:permanent" || row.entry_key === "ttl:future",
            ),
          );
        } else {
          await expect(maintenance).rejects.toThrow(
            "Task registry read owner is no longer current",
          );
          expect(readRows()).toStrictEqual(before);
        }
        expect(nativeStages).toEqual(
          owner === "replaced while waiting"
            ? []
            : owner === "replaced at transaction"
              ? ["transaction"]
              : ["transaction", "commit"],
        );
      } finally {
        holder?.release();
        if (timer !== undefined) {
          clearTimeout(timer);
        }
        await Promise.allSettled([maintenance]);
        holder?.release();
        await Promise.allSettled([sweep, holder?.joined]);
        if (timer !== undefined) {
          clearTimeout(timer);
        }
        admissionObserver.mockRestore();
        postObserver.mockRestore();
        sweepObserver.mockRestore();
        cleanupObserver.mockRestore();
        configureTaskRegistryRuntime({ store: originalStore });
        await closeOpenClawStateDatabaseAsync();
      }
    });
  });
});
