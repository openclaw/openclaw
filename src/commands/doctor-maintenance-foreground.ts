import { TICK_INTERVAL_MS } from "../gateway/server-constants.js";
import { acquireWithWait } from "../infra/acquire-with-wait.js";
import { readGatewayOwnerLease } from "../infra/gateway-owner-lease.js";
import {
  GATEWAY_SERVICE_STOP_TIMEOUT_MS,
  GATEWAY_SHUTDOWN_RESERVE_MS,
} from "../infra/gateway-shutdown-budget.js";
import { resolveGatewayRestartDeferralTimeoutMs } from "../infra/restart-budget.js";
import {
  acquireGatewayMaintenanceCoordinator,
  StateDatabaseCoordinatorContentionError,
} from "../infra/state-database-coordinator.js";
import { readStateLeaseProcessOwnerStatus } from "../infra/state-lease-process-owner.js";
import type { RuntimeEnv } from "../runtime.js";
import { openDoctorStateSchemaReadAdmission } from "../state/openclaw-state-db-doctor-schema.js";
import { sleep } from "../utils/sleep.js";
import type { DoctorOptions } from "./doctor-prompter.js";
import { isDoctorUpdateRepairMode, resolveDoctorRepairMode } from "./doctor-repair-mode.js";

export async function acquireDoctorGatewayMaintenanceCoordinator(
  databasePath: string,
  env: NodeJS.ProcessEnv,
  params: {
    options: DoctorOptions;
    runtime: RuntimeEnv;
    assertCurrent?: () => void;
    deadlineMs?: number;
  },
) {
  const updateRepair = isDoctorUpdateRepairMode(resolveDoctorRepairMode(params.options));
  let foreground: ReturnType<typeof readGatewayOwnerLease>;
  let ownerlessDeadlineMs: number | undefined;
  return await acquireWithWait({
    acquire: () => {
      params.assertCurrent?.();
      return acquireGatewayMaintenanceCoordinator({ databasePath, busyTimeoutMs: 0 });
    },
    shouldRetry: (error) => {
      // A delegated updater may reach Doctor before its replaced foreground
      // Gateway observes the new installation and finishes releasing state.
      if (
        !updateRepair ||
        !params.assertCurrent ||
        !(error instanceof StateDatabaseCoordinatorContentionError) ||
        error.family !== "gateway-lifecycle"
      ) {
        return false;
      }
      params.assertCurrent();
      const current = readGatewayOwnerLease({
        env,
        current: true,
        openStateSchemaReadAdmission: openDoctorStateSchemaReadAdmission,
      });
      if (!foreground) {
        if (!current) {
          // Lease deletion precedes asynchronous lock-file cleanup. A late
          // arrival gets the shutdown reserve, never a fresh drain allowance.
          if (ownerlessDeadlineMs === undefined) {
            ownerlessDeadlineMs = performance.now() + GATEWAY_SHUTDOWN_RESERVE_MS;
            params.runtime.log("Waiting for Gateway state ownership cleanup to finish.");
          }
          return performance.now() < ownerlessDeadlineMs;
        }
        if (ownerlessDeadlineMs !== undefined) {
          return false;
        }
        if (current.state !== "live" || current.mode !== "foreground") {
          return false;
        }
        foreground = current;
        params.runtime.log("Waiting for the previous foreground Gateway to release state.");
      } else if (
        current &&
        (current.owner !== foreground.owner ||
          current.pid !== foreground.pid ||
          current.startedAt !== foreground.startedAt ||
          current.host !== foreground.host ||
          current.mode !== "foreground")
      ) {
        return false;
      }
      // The owner removes its row just before releasing the physical lock.
      // A dead predecessor cannot explain a lock still held by another process.
      return readStateLeaseProcessOwnerStatus(foreground) === "live";
    },
    // Installation replacement is an unsupervised restart: detection, drain,
    // then server close and process exit each retain their owner's allowance.
    deadlineMs: Math.min(
      params.deadlineMs ?? Infinity,
      performance.now() +
        TICK_INTERVAL_MS +
        resolveGatewayRestartDeferralTimeoutMs() +
        GATEWAY_SERVICE_STOP_TIMEOUT_MS,
    ),
    pollIntervalMs: 100,
    maxPollIntervalMs: 1_000,
    sleep: (ms) =>
      sleep(
        ownerlessDeadlineMs === undefined
          ? ms
          : Math.min(ms, Math.max(0, ownerlessDeadlineMs - performance.now())),
      ),
  });
}
