// Coordinates gateway restart requests across supported supervisors.
import { abortPendingChannelReloads } from "../gateway/server-reload-generation.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import {
  beginGatewayRestartSignalAdmission,
  rollbackGatewayRestartSignalFence,
  type GatewayRestartSignalAdmissionLease,
} from "../process/gateway-work-admission.js";
import { resolveGatewayRestartDeferralTimeoutMs } from "./restart-budget.js";
import { type GatewayRestartIntent, normalizeRestartIntentReason } from "./restart-intent.js";
import { createGatewayRestartPreparation } from "./restart-preparation.js";
import {
  PendingGatewayRestart,
  formatRestartAudit,
  normalizeGatewayRestartDelayMs,
  type RestartAuditInfo,
  type RestartEmitHooks,
  type GatewayRestartEmitResult,
  type ScheduledRestart,
} from "./restart-request.js";
import { restartGatewayViaSupervisor } from "./restart-supervisor.js";
import type { RestartAttempt } from "./restart.types.js";

export { normalizeSystemdUnit } from "./restart-supervisor.js";
export {
  normalizeGatewayRestartDelayMs,
  type GatewayRestartEmitter,
  type RestartDeferralHandle,
  type ScheduledRestart,
} from "./restart-request.js";

const RESTART_AUTH_GRACE_MS = 5000;
const RESTART_COOLDOWN_MS = 30_000;

const restartLog = createSubsystemLogger("restart");

// Control-flow deadlines (SIGUSR2 grace, deferral caps, restart cooldown) run on
// the monotonic clock: a wall-clock step (NTP correction, VM suspend/resume)
// would otherwise extend authorization grace or fire/skip deferral timeouts.
const monotonicNow = () => performance.now();

let restartAuthorizedCount = 0;
let restartAuthorizedUntil = 0;
let externalRestartAllowed = false;
let preRestartCheck: (() => number) | null = null;
let restartCycleToken = 0;
let emittedRestartToken = 0;
let consumedRestartToken = 0;
let emittedRestartReason: string | undefined;
let emittedRestartIntent: GatewayRestartIntent | undefined;
// null marks "never emitted": a 0 sentinel would collide with the monotonic
// clock origin and impose a phantom cooldown during the first RESTART_COOLDOWN_MS
// of process life.
let lastRestartEmittedAt: number | null = null;
let pendingRestartTimer: ReturnType<typeof setTimeout> | null = null;
let pendingRestartDueAt = 0;
let pendingRestartReason: string | undefined;
let pendingRestartSuccessorOwner: GatewayRestartIntent["successorOwner"];
let pendingRestartRequest: PendingGatewayRestart | undefined;
let pendingRestartSkipDeferral = false;
let pendingRestartPreparing = false;
let pendingRestartSignalAdmission: GatewayRestartSignalAdmissionLease | null = null;
let restartTransientGeneration = 0;
const activeDeferralPolls = new Set<ReturnType<typeof setInterval>>();

const { emitPreparedGatewayRestart, deferGatewayRestartUntilIdle } =
  createGatewayRestartPreparation(
    {
      get restartTransientGeneration() {
        return restartTransientGeneration;
      },
      get pendingRestartRequest() {
        return pendingRestartRequest;
      },
      get pendingRestartReason() {
        return pendingRestartReason;
      },
      get pendingRestartSuccessorOwner() {
        return pendingRestartSuccessorOwner;
      },
      get pendingRestartSignalAdmission() {
        return pendingRestartSignalAdmission;
      },
      set pendingRestartSignalAdmission(lease) {
        pendingRestartSignalAdmission = lease;
      },
    },
    {
      activeDeferralPolls,
      monotonicNow,
      hasUnconsumedRestartSignal,
      clearPendingScheduledRestart,
      shouldPreferRestartReason,
      requestGatewayRestartWithSignalAdmission,
    },
  );

export { deferGatewayRestartUntilIdle };

function shouldPreferRestartReason(next?: string, current?: string): boolean {
  const isUpdateRestart = (reason?: string) => reason === "update.run" || reason === "update.auto";
  return isUpdateRestart(next) && !isUpdateRestart(current);
}

function hasUnconsumedRestartSignal(): boolean {
  return emittedRestartToken > consumedRestartToken;
}

function clearPendingScheduledRestart(): void {
  clearTimeout(pendingRestartTimer ?? undefined);
  pendingRestartTimer = null;
  pendingRestartDueAt = 0;
  pendingRestartReason = undefined;
  pendingRestartSuccessorOwner = undefined;
  pendingRestartRequest = undefined;
  pendingRestartSkipDeferral = false;
  pendingRestartPreparing = false;
}

/** Releases a signal fence when the run loop rejects or fails to handle the signal. */
export function rollbackGatewayRestartSignalAdmission(): boolean {
  const lease = pendingRestartSignalAdmission;
  pendingRestartSignalAdmission = null;
  if (lease?.rollback()) {
    return true;
  }
  // A concurrent emission must never replace a live lease with a dead handle.
  // If that still happens, reopen the reversible fence directly so refused or
  // abandoned signals cannot wedge process admission forever.
  return rollbackGatewayRestartSignalFence();
}

function armPendingRestartTimer(requestedDueAt: number, nowMs: number): void {
  pendingRestartTimer = setTimeout(
    () => {
      const scheduledReason = pendingRestartReason;
      const scheduledSkipDeferral = pendingRestartSkipDeferral;
      const request = pendingRestartRequest;
      pendingRestartTimer = null;
      pendingRestartDueAt = 0;
      pendingRestartReason = undefined;
      pendingRestartSkipDeferral = false;
      pendingRestartPreparing = true;
      const pendingCheck = preRestartCheck;
      if (scheduledSkipDeferral || !pendingCheck) {
        void emitPreparedGatewayRestart(undefined, scheduledReason, undefined, {
          scheduledRequest: request,
        });
        return;
      }
      const deferralTimeoutMs = resolveGatewayRestartDeferralTimeoutMs();
      deferGatewayRestartUntilIdle(
        {
          getPendingCount: pendingCheck,
          maxWaitMs: deferralTimeoutMs,
          reason: scheduledReason,
          timeoutIntent: { force: true, ...(scheduledReason ? { reason: scheduledReason } : {}) },
        },
        request,
      );
    },
    Math.max(0, requestedDueAt - nowMs),
  );
}

function clearActiveDeferralPolls(): void {
  for (const poll of activeDeferralPolls) {
    clearInterval(poll);
  }
  activeDeferralPolls.clear();
}

export function resetGatewayRestartStateForInProcessRestart(): void {
  restartTransientGeneration += 1;
  restartAuthorizedCount = 0;
  restartAuthorizedUntil = 0;
  restartCycleToken = 0;
  emittedRestartToken = 0;
  consumedRestartToken = 0;
  emittedRestartReason = undefined;
  emittedRestartIntent = undefined;
  lastRestartEmittedAt = null;
  clearActiveDeferralPolls();
  clearPendingScheduledRestart();
  rollbackGatewayRestartSignalAdmission();
  // Fence the retiring lifecycle before a successor can create its reload generation.
  abortPendingChannelReloads();
}

/**
 * Register a callback that scheduleGatewayRestart checks before emitting SIGUSR2.
 * The callback should return the number of pending items (0 = safe to restart).
 */
export function setPreRestartDeferralCheck(fn: () => number): void {
  preRestartCheck = fn;
}

/** Emit one authorized restart per cycle; refuse unavailable or duplicate delivery. */
function emitGatewayRestart(reasonOverride?: string, intent?: GatewayRestartIntent): boolean {
  if (hasUnconsumedRestartSignal()) {
    clearActiveDeferralPolls();
    clearPendingScheduledRestart();
    return false;
  }
  clearActiveDeferralPolls();
  clearPendingScheduledRestart();
  const cycleToken = ++restartCycleToken;
  emittedRestartToken = cycleToken;
  emittedRestartReason = reasonOverride ?? intent?.reason ?? pendingRestartReason;
  emittedRestartIntent = intent;
  authorizeGatewayRestart();
  try {
    if (process.listenerCount("SIGUSR2") > 0) {
      // Signal path: let the run-loop's SIGUSR2 handler drive restart.
      // Works on all platforms including Windows when a listener is registered.
      process.emit("SIGUSR2");
    } else if (process.platform === "win32") {
      // On Windows with no SIGUSR2 listener, fall back to task-scheduler handoff.
      // triggerOpenClawRestart() uses schtasks to restart the gateway.
      const result = triggerOpenClawRestart();
      if (!result.ok) {
        // Roll back the cycle marker so future restart requests can still proceed.
        restartLog.warn("Windows scheduled task restart failed, token rolled back");
        return rollBackGatewayRestartEmission();
      }
      consumeGatewayRestartAuthorization();
      markGatewayRestartHandled();
    } else {
      // Embedded Gateways have no run loop; an unhandled SIGUSR2 would kill their host.
      restartLog.warn("Gateway restart unavailable: no restart handler; restart through the host.");
      return rollBackGatewayRestartEmission();
    }
  } catch {
    // Roll back the cycle marker so future restart requests can still proceed.
    return rollBackGatewayRestartEmission();
  }
  lastRestartEmittedAt = monotonicNow();
  return true;
}

/**
 * Emits while holding the signal-to-drain admission fence.
 *
 * The caller must already own root-work admission. Scheduled restarts use the
 * independent-root wrapper below; config reloads run inside their reload root.
 */
function emitGatewayRestartWithSignalAdmission(
  reasonOverride?: string,
  intent?: GatewayRestartIntent,
): boolean {
  let signalAdmission = pendingRestartSignalAdmission;
  if (!signalAdmission) {
    // Orphan fence: pending without a lease and without a delivered signal.
    // Reopen before acquiring so a lost lease cannot block all future emissions.
    if (!hasUnconsumedRestartSignal()) {
      rollbackGatewayRestartSignalFence();
    }
    signalAdmission = beginGatewayRestartSignalAdmission();
    if (!signalAdmission) {
      // Another emission owns the fence, or one-way drain already closed admission.
      return false;
    }
    pendingRestartSignalAdmission = signalAdmission;
  }
  const hadUnconsumedRestartSignal = hasUnconsumedRestartSignal();
  const emitted = emitGatewayRestart(reasonOverride, intent);
  if (!emitted && !hadUnconsumedRestartSignal) {
    rollbackGatewayRestartSignalAdmission();
  }
  return emitted;
}

/** Closed restart result for owners that must distinguish coalescing from delivery failure. */
export function requestGatewayRestartWithSignalAdmission(
  reasonOverride?: string,
  intent?: GatewayRestartIntent,
): GatewayRestartEmitResult {
  const hadUnconsumedRestartSignal = hasUnconsumedRestartSignal();
  if (emitGatewayRestartWithSignalAdmission(reasonOverride, intent)) {
    return { status: "emitted" };
  }
  return { status: hadUnconsumedRestartSignal ? "coalesced" : "failed" };
}

function resetRestartAuthorizationIfExpired(now = monotonicNow()) {
  if (restartAuthorizedCount <= 0 || now <= restartAuthorizedUntil) {
    return;
  }
  restartAuthorizedCount = 0;
  restartAuthorizedUntil = 0;
}

export function setGatewayRestartPolicy(opts?: { allowExternal?: boolean }) {
  externalRestartAllowed = opts?.allowExternal === true;
}

export function isGatewayRestartExternallyAllowed() {
  return externalRestartAllowed;
}

function authorizeGatewayRestart() {
  const expiresAt = monotonicNow() + RESTART_AUTH_GRACE_MS;
  restartAuthorizedCount += 1;
  if (expiresAt > restartAuthorizedUntil) {
    restartAuthorizedUntil = expiresAt;
  }
}

export function consumeGatewayRestartAuthorization(): boolean {
  resetRestartAuthorizationIfExpired();
  if (restartAuthorizedCount <= 0) {
    return false;
  }
  restartAuthorizedCount -= 1;
  if (restartAuthorizedCount <= 0) {
    restartAuthorizedUntil = 0;
  }
  return true;
}

export function peekGatewayRestartReason(): string | undefined {
  return hasUnconsumedRestartSignal() ? emittedRestartReason : undefined;
}

/**
 * Reads and clears only the in-memory intent for the current emitted SIGUSR2 cycle.
 * The restart reason and cycle token are advanced by markGatewayRestartHandled().
 */
export function consumeGatewayRestartIntent(): GatewayRestartIntent | null {
  if (!hasUnconsumedRestartSignal()) {
    return null;
  }
  const intent = emittedRestartIntent ?? null;
  emittedRestartIntent = undefined;
  return intent;
}

/**
 * Mark the currently emitted SIGUSR2 restart cycle as consumed by the run loop.
 * This explicitly advances the cycle state instead of resetting emit guards inside
 * consumeGatewayRestartAuthorization().
 */
export function markGatewayRestartHandled(): void {
  if (hasUnconsumedRestartSignal()) {
    consumedRestartToken = emittedRestartToken;
    emittedRestartReason = undefined;
    emittedRestartIntent = undefined;
  }
  // Accepted handlers first promote the fence to one-way restart drain, so
  // this rollback becomes a no-op there. Rejected or test-only handlers must
  // reopen admission or the next restart/root would wait forever.
  rollbackGatewayRestartSignalAdmission();
}

function rollBackGatewayRestartEmission(): false {
  emittedRestartToken = consumedRestartToken;
  emittedRestartReason = undefined;
  emittedRestartIntent = undefined;
  consumeGatewayRestartAuthorization();
  return false;
}

function canReplacePendingRestartEmitHooks(
  hooks: RestartEmitHooks | undefined,
  sessionKey: string | undefined,
): boolean {
  return (
    !hooks ||
    pendingRestartRequest?.sessionKey === undefined ||
    pendingRestartRequest.sessionKey === sessionKey
  );
}

export function triggerOpenClawRestart(): RestartAttempt {
  if (process.env.VITEST || process.env.NODE_ENV === "test") {
    return { ok: true, method: "supervisor", detail: "test mode" };
  }
  return restartGatewayViaSupervisor();
}

export function scheduleGatewayRestart(opts?: {
  delayMs?: number;
  reason?: string;
  audit?: RestartAuditInfo;
  emitHooks?: RestartEmitHooks;
  preservePendingEmitHooksOnDeferralBypass?: boolean;
  sessionKey?: string;
  skipDeferral?: boolean;
  skipCooldown?: boolean;
  successorOwner?: GatewayRestartIntent["successorOwner"];
}): ScheduledRestart {
  const delayMs = normalizeGatewayRestartDelayMs(opts?.delayMs);
  const reason = normalizeRestartIntentReason(opts?.reason);
  const mode: ScheduledRestart["mode"] =
    process.listenerCount("SIGUSR2") > 0
      ? "emit"
      : process.platform === "win32"
        ? "supervisor"
        : "signal";
  const nowMs = monotonicNow();
  const cooldownMsApplied =
    opts?.skipCooldown === true || lastRestartEmittedAt === null
      ? 0
      : Math.max(0, lastRestartEmittedAt + RESTART_COOLDOWN_MS - nowMs);
  const restartResultBase = {
    ok: true,
    pid: process.pid,
    signal: "SIGUSR2" as const,
    reason,
    mode,
    cooldownMsApplied,
  };
  const requestedDueAt = nowMs + delayMs + cooldownMsApplied;
  const skipDeferral = opts?.skipDeferral === true;
  let nextPendingSessionKey = opts?.sessionKey;
  let nextPendingReason = reason;
  let nextPendingSuccessorOwner = opts?.successorOwner;

  if (hasUnconsumedRestartSignal()) {
    if (shouldPreferRestartReason(reason, emittedRestartReason)) {
      emittedRestartReason = reason;
      if (emittedRestartIntent) {
        // Preserve the already-authorized force bit; only the display/recovery reason is upgraded.
        emittedRestartIntent = { ...emittedRestartIntent, reason };
      }
    }
    if (opts?.successorOwner) {
      emittedRestartIntent = {
        ...emittedRestartIntent,
        ...(emittedRestartReason ? { reason: emittedRestartReason } : {}),
        successorOwner: opts.successorOwner,
      };
    }
    restartLog.warn(
      `restart request coalesced (already in-flight) reason=${reason ?? "unspecified"} ${formatRestartAudit(opts?.audit)}`,
    );
    return {
      ...restartResultBase,
      delayMs: 0,
      coalesced: true,
      // SIGUSR2 already emitted; the new caller's hooks cannot run for this cycle.
      emitHooksQueued: false,
    };
  }

  const requestOwner = (pendingRestartRequest ??= new PendingGatewayRestart());
  const requester = requestOwner.admit(opts?.emitHooks);
  let nextPendingEmitHooks = opts?.emitHooks ? requester : undefined;

  if (pendingRestartTimer || pendingRestartPreparing) {
    const remainingMs = pendingRestartPreparing ? 0 : Math.max(0, pendingRestartDueAt - nowMs);
    // Hookless forced restarts that own no sentinel may preserve an accepted
    // pending hook; update/handoff callers rely on the default clear path.
    const preservePendingHooks =
      opts?.preservePendingEmitHooksOnDeferralBypass === true &&
      opts?.emitHooks === undefined &&
      requestOwner.sessionKey !== undefined;
    if (pendingRestartPreparing && skipDeferral && activeDeferralPolls.size > 0) {
      restartLog.warn(
        `restart request bypassed active deferral reason=${reason ?? "unspecified"} pendingReason=${pendingRestartReason ?? "unspecified"} ${formatRestartAudit(opts?.audit)}`,
      );
      clearActiveDeferralPolls();
      pendingRestartReason = reason;
      pendingRestartSuccessorOwner = opts?.successorOwner ?? pendingRestartSuccessorOwner;
      if (!preservePendingHooks) {
        requestOwner.emitHooks = nextPendingEmitHooks;
        requestOwner.sessionKey = opts?.sessionKey;
      }
      void emitPreparedGatewayRestart(undefined, reason, undefined, {
        scheduledRequest: requestOwner,
      });
      return {
        ...restartResultBase,
        delayMs: 0,
        coalesced: false,
        emitHooksQueued: opts?.emitHooks !== undefined,
      };
    }
    const shouldPullEarlier =
      !pendingRestartPreparing &&
      (requestedDueAt < pendingRestartDueAt || (skipDeferral && !pendingRestartSkipDeferral));
    if (shouldPullEarlier) {
      if (shouldPreferRestartReason(pendingRestartReason, reason)) {
        nextPendingReason = pendingRestartReason;
      }
      nextPendingSuccessorOwner ??= pendingRestartSuccessorOwner;
      if (
        !preservePendingHooks &&
        !canReplacePendingRestartEmitHooks(opts?.emitHooks, opts?.sessionKey)
      ) {
        restartLog.warn(
          `restart continuation dropped: another session owns the pending restart (callerSessionKey=${opts?.sessionKey ?? "unspecified"} pendingSessionKey=${requestOwner.sessionKey ?? "unspecified"})`,
        );
        clearTimeout(pendingRestartTimer ?? undefined);
        pendingRestartTimer = null;
        pendingRestartDueAt = requestedDueAt;
        pendingRestartReason = nextPendingReason;
        pendingRestartSuccessorOwner = nextPendingSuccessorOwner;
        pendingRestartSkipDeferral = pendingRestartSkipDeferral || skipDeferral;
        armPendingRestartTimer(requestedDueAt, nowMs);
        return {
          ...restartResultBase,
          delayMs: Math.max(0, requestedDueAt - nowMs),
          coalesced: true,
          emitHooksQueued: false,
        };
      }
      if (preservePendingHooks) {
        nextPendingEmitHooks = requestOwner.emitHooks;
        nextPendingSessionKey = requestOwner.sessionKey;
      }
      restartLog.warn(
        `restart request rescheduled earlier reason=${reason ?? "unspecified"} pendingReason=${pendingRestartReason ?? "unspecified"} oldDelayMs=${remainingMs} newDelayMs=${Math.max(0, requestedDueAt - nowMs)} ${formatRestartAudit(opts?.audit)}`,
      );
      clearPendingScheduledRestart();
    } else {
      const restartReasonPromoted = shouldPreferRestartReason(reason, pendingRestartReason);
      if (restartReasonPromoted) {
        pendingRestartReason = reason;
      }
      pendingRestartSuccessorOwner = opts?.successorOwner ?? pendingRestartSuccessorOwner;
      pendingRestartSkipDeferral = pendingRestartSkipDeferral || skipDeferral;
      restartLog.warn(
        `restart request coalesced (already scheduled) reason=${reason ?? "unspecified"} pendingReason=${pendingRestartReason ?? "unspecified"} delayMs=${remainingMs} ${formatRestartAudit(opts?.audit)}`,
      );
      const emitHooksQueued =
        opts?.emitHooks !== undefined &&
        canReplacePendingRestartEmitHooks(opts.emitHooks, opts.sessionKey);
      if (
        emitHooksQueued ||
        (!preservePendingHooks &&
          opts?.emitHooks === undefined &&
          (restartReasonPromoted || opts?.successorOwner !== undefined))
      ) {
        requestOwner.emitHooks = nextPendingEmitHooks;
        requestOwner.sessionKey = opts?.emitHooks ? opts.sessionKey : undefined;
      }
      if (opts?.emitHooks && !emitHooksQueued) {
        restartLog.warn(
          `restart continuation dropped: another session owns the pending restart (callerSessionKey=${opts.sessionKey ?? "unspecified"} pendingSessionKey=${requestOwner.sessionKey ?? "unspecified"})`,
        );
      }
      return {
        ...restartResultBase,
        delayMs: remainingMs,
        coalesced: true,
        emitHooksQueued,
      };
    }
  }

  pendingRestartDueAt = requestedDueAt;
  pendingRestartReason = nextPendingReason;
  pendingRestartSuccessorOwner = nextPendingSuccessorOwner;
  pendingRestartRequest = requestOwner;
  requestOwner.emitHooks = nextPendingEmitHooks;
  requestOwner.sessionKey = nextPendingSessionKey;
  pendingRestartSkipDeferral = skipDeferral;
  armPendingRestartTimer(requestedDueAt, nowMs);
  return {
    ...restartResultBase,
    delayMs: Math.max(0, requestedDueAt - nowMs),
    coalesced: false,
    emitHooksQueued: opts?.emitHooks !== undefined,
  };
}
