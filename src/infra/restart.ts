// Public restart contract; preparation-only options stay in the internal runtime.
import type { GatewayRestartIntent } from "./restart-intent.js";
import type {
  PendingGatewayRestart,
  RestartDeferralHandle,
  RestartDeferralHooks,
  RestartEmitHooks,
} from "./restart-request.js";
import { deferGatewayRestartUntilIdle as deferRestartUntilIdle } from "./restart-runtime.js";

export {
  consumeGatewayRestartAuthorization,
  consumeGatewayRestartIntent,
  isGatewayRestartExternallyAllowed,
  markGatewayRestartHandled,
  normalizeGatewayRestartDelayMs,
  normalizeSystemdUnit,
  peekGatewayRestartReason,
  requestGatewayRestartWithSignalAdmission,
  resetGatewayRestartStateForInProcessRestart,
  rollbackGatewayRestartSignalAdmission,
  scheduleGatewayRestart,
  setGatewayRestartPolicy,
  setPreRestartDeferralCheck,
  triggerOpenClawRestart,
  type GatewayRestartEmitter,
  type RestartDeferralHandle,
  type ScheduledRestart,
} from "./restart-runtime.js";

/** Poll pending work until it drains, then emit one restart signal. */
export function deferGatewayRestartUntilIdle(
  opts: {
    getPendingCount: () => number;
    hooks?: RestartDeferralHooks;
    emitHooks?: RestartEmitHooks;
    pollMs?: number;
    maxWaitMs?: number;
    reason?: string;
    timeoutIntent?: GatewayRestartIntent;
  },
  scheduledRequest?: PendingGatewayRestart,
): RestartDeferralHandle {
  return deferRestartUntilIdle(opts, scheduledRequest);
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
