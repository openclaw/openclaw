import { TICK_INTERVAL_MS } from "../gateway/server-constants.js";
import { acquireWithWait } from "../infra/acquire-with-wait.js";
import { acquireGatewayLock, GatewayLockError } from "../infra/gateway-lock.js";
import { GATEWAY_SERVICE_STOP_TIMEOUT_MS } from "../infra/gateway-shutdown-budget.js";
import { GatewayStateOwnerContentionError } from "../infra/gateway-state-owner.js";
import { resolveGatewayRestartDeferralTimeoutMs } from "../infra/restart-budget.js";
import type { RuntimeEnv } from "../runtime.js";
import { sleep } from "../utils/sleep.js";
import type { DoctorOptions } from "./doctor-prompter.js";
import { isDoctorUpdateRepairMode, resolveDoctorRepairMode } from "./doctor-repair-mode.js";

export async function acquireDoctorGatewayMaintenanceOwner(
  databasePath: string,
  env: NodeJS.ProcessEnv,
  params: {
    options: DoctorOptions;
    runtime: RuntimeEnv;
    assertCurrent?: () => void;
    deadlineMs?: number;
    relocatedMaintenanceOwner?: NonNullable<Awaited<ReturnType<typeof acquireGatewayLock>>>;
  },
) {
  const updateRepair = isDoctorUpdateRepairMode(resolveDoctorRepairMode(params.options));
  let waiting = false;
  return await acquireWithWait({
    acquire: async () => {
      try {
        const owner = await acquireGatewayLock({
          env,
          role: "sqlite-maintenance",
          allowInTests: true,
          lifecycleDeadlineMs: params.deadlineMs,
          assertCurrent: params.assertCurrent,
          onWait: params.runtime.log,
          relocatedMaintenanceOwner: params.relocatedMaintenanceOwner,
        });
        if (!owner) {
          throw new Error(`Doctor could not acquire maintenance ownership for ${databasePath}`);
        }
        return owner;
      } catch (error) {
        if (
          error instanceof GatewayLockError &&
          error.cause instanceof GatewayStateOwnerContentionError
        ) {
          throw error.cause;
        }
        throw error;
      }
    },
    shouldRetry: (error) => {
      // A delegated updater may reach Doctor before its replaced foreground
      // Gateway observes the new installation and finishes releasing state.
      if (
        !updateRepair ||
        !params.assertCurrent ||
        !(error instanceof GatewayStateOwnerContentionError)
      ) {
        return false;
      }
      params.assertCurrent();
      if (!waiting) {
        waiting = true;
        params.runtime.log("Waiting for the previous foreground Gateway to release state.");
      }
      // The physical lock decides ownership. A replacement owner may make us
      // wait until the same bounded deadline, but cannot grant unsafe access.
      return true;
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
    sleep,
  });
}
