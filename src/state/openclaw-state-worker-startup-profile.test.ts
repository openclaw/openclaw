import { isMainThread } from "node:worker_threads";
import { expect, it } from "vitest";
import { createSnapshot } from "../config/mutate.test-support.js";
import { installGatewayDatabaseEngine } from "../gateway/server-database-engine.js";
import { resetDatabaseEngineSelectionForTest } from "../infra/database-engine/context.test-support.js";
import { readGatewayLockProcessNamespace } from "../infra/gateway-lock-payload.js";
import {
  initializeGatewayResourceProfile,
  withGatewayStartupResourceProfile,
} from "../infra/gateway-resource-profile.js";
import { acquireGatewayStateOwner } from "../infra/gateway-state-owner.js";
import { getTrackedWorkerPoolSnapshot } from "../infra/worker-cpu.js";
import { resetGlobalSingletonLifecycleState } from "../shared/global-singleton.js";
import { closeStateDatabaseForTest } from "../test-utils/database-cleanup.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { writeConfigMachineStateAsync } from "./config-machine-state-async.js";
import { readConfigMachineState } from "./config-machine-state.js";
import { openOpenClawStateDatabase } from "./openclaw-state-db.js";
import { captureOpenClawStateWorkerContext } from "./openclaw-state-worker-context.js";

it.each(["lean", "standard"] as const)(
  "carries configured %s placement through the normal detached shared-state opener",
  async (profile) => {
    expect(isMainThread).toBe(true);
    await withOpenClawTestState({ prepareProfileCatalog: false }, async (state) => {
      resetDatabaseEngineSelectionForTest();
      const database = openOpenClawStateDatabase();
      const lease = acquireGatewayStateOwner({
        databasePath: database.path,
        payload: {
          pid: process.pid,
          processNamespace: readGatewayLockProcessNamespace(),
          createdAt: new Date().toISOString(),
          configPath: state.configPath,
          role: "gateway",
        },
      });
      try {
        initializeGatewayResourceProfile({ profile: profile === "lean" ? "standard" : "lean" });
        await withGatewayStartupResourceProfile(async () => {
          await installGatewayDatabaseEngine(
            createSnapshot({
              sourceConfig: { gateway: { resources: { profile } } },
            }),
          );
          // Maintenance intentionally preserves async context; exercise the ordinary owner.
          expect(captureOpenClawStateWorkerContext().maintenanceScope).toBeUndefined();
          await writeConfigMachineStateAsync("synthetic.startup-profile", { profile });
          expect(readConfigMachineState("synthetic.startup-profile")).toEqual({ profile });
          const census = getTrackedWorkerPoolSnapshot().workerCensus;
          expect(census.filter((row) => row.kind === "sqlite-store.worker.js")).toHaveLength(
            profile === "lean" ? 0 : 1,
          );
          expect(census.filter((row) => row.kind === "shared-worker-host.worker.js")).toHaveLength(
            profile === "lean" ? 1 : 0,
          );
        });
      } finally {
        await closeStateDatabaseForTest();
        lease.release();
        resetDatabaseEngineSelectionForTest();
        await resetGlobalSingletonLifecycleState(Symbol.for("openclaw.gatewayResourceProfile"));
      }
      expect(
        getTrackedWorkerPoolSnapshot().workerCensus.filter(
          (row) =>
            row.kind === "sqlite-store.worker.js" || row.kind === "shared-worker-host.worker.js",
        ),
      ).toEqual([]);
    });
  },
);
