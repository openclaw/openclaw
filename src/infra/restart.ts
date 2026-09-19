// Coordinates gateway restart requests across supported supervisors.
import { resolveTimerTimeoutMs } from "@openclaw/normalization-core/number-coercion";
import { abortPendingChannelReloads } from "../gateway/server-reload-generation.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import {
  beginGatewayRestartSignalAdmission,
  getActiveGatewayRootWorkCount,
  isGatewayRestartDraining,
  rollbackGatewayRestartSignalFence,
  runWithGatewayIndependentRootWorkAdmission,
  type GatewayRestartSignalAdmissionLease,
} from "../process/gateway-work-admission.js";
import { formatErrorMessage } from "./errors.js";
import { type GatewayRestartIntent, normalizeRestartIntentReason } from "./restart-intent.js";
import { restartGatewayViaSupervisor } from "./restart-supervisor.js";
import type { RestartAttempt } from "./restart.types.js";

export { normalizeSystemdUnit } from "./restart-supervisor.js";

const SIGUSR1_AUTH_GRACE_MS = 5000;
const DEFAULT_DEFERRAL_POLL_MS = 500;
const DEFAULT_DEFERRAL_STILL_PENDING_WARN_MS = 30_000;
const DEFAULT_RESTART_DEFERRAL_TIMEOUT_MS = 300_000;
const RESTART_COOLDOWN_MS = 30_000;

const restartLog = createSubsystemLogger("restart");

// Control-flow deadlines (SIGUSR1 grace, deferral caps, restart cooldown) run on
// the monotonic clock: a wall-clock step (NTP correction, VM suspend/resume)
// would otherwise extend authorization grace or fire/skip deferral timeouts.
const monotonicNow = () => performance.now();

let sigusr1AuthorizedCount = 0;
let sigusr1AuthorizedUntil = 0;
let sigusr1ExternalAllowed = false;
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
let pendingRestartEmitHooks: RestartEmitHooks | undefined;
let pendingRestartSessionKey: string | undefined;
let pendingRestartSkipDeferral = false;
let pendingRestartPreparing = false;
let pendingRestartSignalAdmission: GatewayRestartSignalAdmissionLease | null = null;
let restartTransientGeneration = 0;
const activeDeferralPolls = new Set<ReturnType<typeof setInterval>>();

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
  pendingRestartEmitHooks = undefined;
  pendingRestartSessionKey = undefined;
  pendingRestartSkipDeferral = false;
  pendingRestartPreparing = false;
}

function clearPendingRestartSignalAdmission(): boolean {
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

/** Releases a signal fence when the run loop rejects or fails to handle the signal. */
export function rollbackGatewayRestartSignalAdmission(): boolean {
  return clearPendingRestartSignalAdmission();
}

function armPendingRestartTimer(requestedDueAt: number, nowMs: number): void {
  pendingRestartTimer = setTimeout(
    () => {
      const scheduledReason = pendingRestartReason;
      const scheduledSkipDeferral = pendingRestartSkipDeferral;
      pendingRestartTimer = null;
      pendingRestartDueAt = 0;
      pendingRestartReason = undefined;
      pendingRestartSkipDeferral = false;
      pendingRestartPreparing = true;
      const pendingCheck = preRestartCheck;
      if (scheduledSkipDeferral || !pendingCheck) {
        void emitPreparedGatewayRestart(undefined, scheduledReason);
        return;
      }
      const deferralTimeoutMs = resolveGatewayRestartDeferralTimeoutMs();
      deferGatewayRestartUntilIdle({
        getPendingCount: pendingCheck,
        maxWaitMs: deferralTimeoutMs,
        reason: scheduledReason,
        timeoutIntent: { force: true, ...(scheduledReason ? { reason: scheduledReason } : {}) },
      });
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

function clearGatewayRestartTransientState(): void {
  restartTransientGeneration += 1;
  sigusr1AuthorizedCount = 0;
  sigusr1AuthorizedUntil = 0;
  restartCycleToken = 0;
  emittedRestartToken = 0;
  consumedRestartToken = 0;
  emittedRestartReason = undefined;
  emittedRestartIntent = undefined;
  lastRestartEmittedAt = null;
  clearActiveDeferralPolls();
  clearPendingScheduledRestart();
  clearPendingRestartSignalAdmission();
}

export function resetGatewayRestartStateForInProcessRestart(): void {
  clearGatewayRestartTransientState();
  // Fence the retiring lifecycle before a successor can create its reload generation.
  abortPendingChannelReloads();
}

type RestartAuditInfo = {
  actor?: string;
  deviceId?: string;
  clientIp?: string;
  changedPaths?: string[];
};

function summarizeChangedPaths(paths: string[] | undefined, maxPaths = 6): string | null {
  if (!Array.isArray(paths) || paths.length === 0) {
    return null;
  }
  if (paths.length <= maxPaths) {
    return paths.join(",");
  }
  const head = paths.slice(0, maxPaths).join(",");
  return `${head},+${paths.length - maxPaths} more`;
}

function formatRestartAudit(audit: RestartAuditInfo | undefined): string {
  const actor = typeof audit?.actor === "string" && audit.actor.trim() ? audit.actor.trim() : null;
  const deviceId =
    typeof audit?.deviceId === "string" && audit.deviceId.trim() ? audit.deviceId.trim() : null;
  const clientIp =
    typeof audit?.clientIp === "string" && audit.clientIp.trim() ? audit.clientIp.trim() : null;
  const changed = summarizeChangedPaths(audit?.changedPaths);
  const fields = [
    actor && `actor=${actor}`,
    deviceId && `device=${deviceId}`,
    clientIp && `ip=${clientIp}`,
    changed && `changedPaths=${changed}`,
  ].filter(Boolean);
  return fields.length > 0 ? fields.join(" ") : "actor=<unknown>";
}

/**
 * Register a callback that scheduleGatewaySigusr1Restart checks before emitting SIGUSR1.
 * The callback should return the number of pending items (0 = safe to restart).
 */
export function setPreRestartDeferralCheck(fn: () => number): void {
  preRestartCheck = fn;
}

/**
 * Emit an authorized SIGUSR1 gateway restart, guarded against duplicate emissions.
 * Returns true if SIGUSR1 was emitted, false if a restart was already emitted.
 * Runtime callers use emitGatewayRestartWithSignalAdmission so the signal-to-drain
 * handoff stays fenced; this lower-level primitive remains available to tests.
 */
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
  authorizeGatewaySigusr1Restart();
  try {
    if (process.listenerCount("SIGUSR1") > 0) {
      // Signal path: let the run-loop's SIGUSR1 handler drive restart.
      // Works on all platforms including Windows when a listener is registered.
      process.emit("SIGUSR1");
    } else if (process.platform === "win32") {
      // On Windows with no SIGUSR1 listener, fall back to task-scheduler handoff.
      // triggerOpenClawRestart() uses schtasks to restart the gateway.
      const result = triggerOpenClawRestart();
      if (!result.ok) {
        // Roll back the cycle marker so future restart requests can still proceed.
        rollBackGatewayRestartEmission();
        restartLog.warn("Windows scheduled task restart failed, token rolled back");
        return false;
      }
      consumeGatewaySigusr1RestartAuthorization();
      markGatewaySigusr1RestartHandled();
    } else {
      // Unix without listener: send signal directly.
      process.kill(process.pid, "SIGUSR1");
    }
  } catch {
    // Roll back the cycle marker so future restart requests can still proceed.
    rollBackGatewayRestartEmission();
    return false;
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
    clearPendingRestartSignalAdmission();
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

function resetSigusr1AuthorizationIfExpired(now = monotonicNow()) {
  if (sigusr1AuthorizedCount <= 0 || now <= sigusr1AuthorizedUntil) {
    return;
  }
  sigusr1AuthorizedCount = 0;
  sigusr1AuthorizedUntil = 0;
}

export function setGatewaySigusr1RestartPolicy(opts?: { allowExternal?: boolean }) {
  sigusr1ExternalAllowed = opts?.allowExternal === true;
}

export function isGatewaySigusr1RestartExternallyAllowed() {
  return sigusr1ExternalAllowed;
}

function authorizeGatewaySigusr1Restart() {
  const expiresAt = monotonicNow() + SIGUSR1_AUTH_GRACE_MS;
  sigusr1AuthorizedCount += 1;
  if (expiresAt > sigusr1AuthorizedUntil) {
    sigusr1AuthorizedUntil = expiresAt;
  }
}

export function consumeGatewaySigusr1RestartAuthorization(): boolean {
  resetSigusr1AuthorizationIfExpired();
  if (sigusr1AuthorizedCount <= 0) {
    return false;
  }
  sigusr1AuthorizedCount -= 1;
  if (sigusr1AuthorizedCount <= 0) {
    sigusr1AuthorizedUntil = 0;
  }
  return true;
}

export function peekGatewaySigusr1RestartReason(): string | undefined {
  return hasUnconsumedRestartSignal() ? emittedRestartReason : undefined;
}

/**
 * Reads and clears only the in-memory intent for the current emitted SIGUSR1 cycle.
 * The restart reason and cycle token are advanced by markGatewaySigusr1RestartHandled().
 */
export function consumeGatewaySigusr1RestartIntent(): GatewayRestartIntent | null {
  if (!hasUnconsumedRestartSignal()) {
    return null;
  }
  const intent = emittedRestartIntent ?? null;
  emittedRestartIntent = undefined;
  return intent;
}

/**
 * Mark the currently emitted SIGUSR1 restart cycle as consumed by the run loop.
 * This explicitly advances the cycle state instead of resetting emit guards inside
 * consumeGatewaySigusr1RestartAuthorization().
 */
export function markGatewaySigusr1RestartHandled(): void {
  if (hasUnconsumedRestartSignal()) {
    consumedRestartToken = emittedRestartToken;
    emittedRestartReason = undefined;
    emittedRestartIntent = undefined;
  }
  // Accepted handlers first promote the fence to one-way restart drain, so
  // this rollback becomes a no-op there. Rejected or test-only handlers must
  // reopen admission or the next restart/root would wait forever.
  clearPendingRestartSignalAdmission();
}

function rollBackGatewayRestartEmission(): void {
  emittedRestartToken = consumedRestartToken;
  emittedRestartReason = undefined;
  emittedRestartIntent = undefined;
  consumeGatewaySigusr1RestartAuthorization();
}

type RestartDeferralHooks = {
  onDeferring?: (pending: number) => void;
  onStillPending?: (pending: number, elapsedMs: number) => void;
  onReady?: () => void;
  onTimeout?: (pending: number | undefined, elapsedMs: number) => void;
  onCheckError?: (err: unknown) => void;
};

type RestartEmitHooks = {
  beforeEmit?: () => Promise<void>;
  afterEmitRejected?: () => Promise<void>;
  afterEmitFailed?: () => Promise<void>;
  emitRestart?: GatewayRestartEmitter;
};

export type RestartDeferralHandle = {
  cancel: () => void;
};

export type GatewayRestartEmitter = (
  reasonOverride?: string,
  intent?: GatewayRestartIntent,
) => GatewayRestartEmitResult;

type GatewayRestartEmitResult =
  | { status: "emitted" }
  | { status: "coalesced" }
  | { status: "failed" };

export function resolveGatewayRestartDeferralTimeoutMs(): number;
export function resolveGatewayRestartDeferralTimeoutMs(timeoutMs: unknown): number | undefined;
export function resolveGatewayRestartDeferralTimeoutMs(timeoutMs?: unknown): number | undefined {
  if (typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs)) {
    return DEFAULT_RESTART_DEFERRAL_TIMEOUT_MS;
  }
  return timeoutMs > 0 ? Math.floor(timeoutMs) : undefined;
}

function canReplacePendingRestartEmitHooks(
  hooks: RestartEmitHooks | undefined,
  sessionKey: string | undefined,
): boolean {
  return (
    !hooks || pendingRestartSessionKey === undefined || pendingRestartSessionKey === sessionKey
  );
}

async function rejectPreparedRestartHook(hooks: RestartEmitHooks | undefined): Promise<void> {
  try {
    await hooks?.afterEmitRejected?.();
  } catch (err) {
    warnRestartEmitHookFailure("afterEmitRejected", err);
  }
}

async function rejectPreparedRestartHooks(hooksList: readonly RestartEmitHooks[]): Promise<void> {
  for (const hooks of hooksList) {
    await rejectPreparedRestartHook(hooks);
  }
}

function warnRestartEmitHookFailure(
  hook: "afterEmitRejected" | "afterEmitFailed",
  err: unknown,
): void {
  // Hook diagnostics are best-effort; formatting or logging must never skip later cleanup.
  let error = "Unknown error";
  try {
    error = formatErrorMessage(err);
  } catch {}
  try {
    restartLog.warn("restart hook callback failed; restart will continue", {
      hook,
      error,
    });
  } catch {}
}

// Single-flight: only emitPreparedGatewayRestart calls this, after synchronously
// taking the restart-signal admission fence. A concurrent emission attempt blocks
// in tryBeginGatewayIndependentRootWorkAdmission (restartSignalPending), so two
// bodies never interleave and a detached parked hook cannot be bypassed mid-await.
async function emitPreparedGatewayRestartUnderAdmission(
  hooks?: RestartEmitHooks,
  reasonOverride?: string,
  intent?: GatewayRestartIntent,
  transientGeneration = restartTransientGeneration,
  canEmit: () => boolean = () => true,
): Promise<GatewayRestartEmitResult | null> {
  const isCurrent = () => transientGeneration === restartTransientGeneration && canEmit();
  if (!isCurrent()) {
    return null;
  }

  // Caller preflight runs before the parked drain: the drain loop's tail
  // re-read then also captures hooks accepted (emitHooksQueued: true) while
  // this await was in flight, leaving no async window before emission where
  // parked continuations could be silently dropped.
  let callerPrepared = false;
  if (hooks) {
    try {
      await hooks.beforeEmit?.();
      callerPrepared = true;
    } catch (err) {
      restartLog.warn(
        `restart preparation failed; restart will continue without it: ${String(err)}`,
      );
    }
    if (!isCurrent()) {
      if (callerPrepared) {
        await rejectPreparedRestartHook(hooks);
      }
      return null;
    }
  }

  // Drain parked emit hooks even when the caller supplies its own. Reload
  // deferral can win the emission race; without this drain the gateway-tool
  // sentinel/continuation is never written and session ownership goes stale.
  // Keep pendingRestartSessionKey until the slot is fully consumed so
  // different-session coalesces during preparation still hit the #86742 guard.
  // Timing note: with an empty slot this stays await-free; mid-flight intent
  // and deferral consumers observe hookless emission at original latency.
  let nextParked = pendingRestartEmitHooks;
  pendingRestartEmitHooks = undefined;
  let preparedParked: RestartEmitHooks | undefined;
  const rejectCallerOnBail = async () => {
    if (hooks && callerPrepared) {
      await rejectPreparedRestartHook(hooks);
    }
  };
  while (nextParked) {
    if (preparedParked) {
      await rejectPreparedRestartHook(preparedParked);
      preparedParked = undefined;
      if (!isCurrent()) {
        await rejectCallerOnBail();
        return null;
      }
    }
    try {
      await nextParked.beforeEmit?.();
      preparedParked = nextParked;
    } catch (err) {
      restartLog.warn(
        `restart preparation failed; restart will continue without it: ${String(err)}`,
      );
    }
    if (!isCurrent()) {
      await rejectPreparedRestartHook(preparedParked);
      await rejectCallerOnBail();
      return null;
    }
    nextParked = pendingRestartEmitHooks;
    pendingRestartEmitHooks = undefined;
  }

  // Track every successfully prepared hook set (parked + caller) so non-emitted
  // outcomes can roll back both the gateway-tool sentinel and reload preflight.
  const preparedHooksList: RestartEmitHooks[] = preparedParked ? [preparedParked] : [];
  if (hooks && callerPrepared) {
    preparedHooksList.push(hooks);
  }
  // With caller hooks, emission stays the caller's (or falls back to the core
  // signal path if its preparation failed); parked hooks never own emission
  // when a caller is present.
  const emitOwner =
    hooks && callerPrepared
      ? hooks
      : hooks || (pendingRestartSuccessorOwner && pendingRestartSessionKey === undefined)
        ? undefined
        : preparedParked;

  // Slot settled and no awaits remain before emission — release ownership for
  // every emission attempt, not only hookless ones, so a later session can
  // claim continuation hooks for the next restart cycle.
  pendingRestartSessionKey = undefined;

  if (!isCurrent()) {
    await rejectPreparedRestartHooks(preparedHooksList);
    return null;
  }

  // A managed update can coalesce while beforeEmit awaits. Promote that reason
  // at the last possible moment so the run loop performs a process exit.
  const preferredReason = shouldPreferRestartReason(pendingRestartReason, reasonOverride)
    ? pendingRestartReason
    : undefined;
  const resolvedReason = preferredReason ?? reasonOverride;
  const successorOwner = pendingRestartSuccessorOwner ?? intent?.successorOwner;
  const resolvedIntent =
    preferredReason || successorOwner
      ? {
          ...intent,
          ...(resolvedReason ? { reason: resolvedReason } : {}),
          ...(successorOwner ? { successorOwner } : {}),
        }
      : intent;
  const emitResult = emitOwner?.emitRestart
    ? emitOwner.emitRestart(resolvedReason, resolvedIntent)
    : requestGatewayRestartWithSignalAdmission(resolvedReason, resolvedIntent);
  if (emitResult.status !== "emitted") {
    await rejectPreparedRestartHooks(preparedHooksList);
  }
  if (emitResult.status === "failed") {
    // Isolate each failure callback: one throwing hook set must not skip the
    // other's cleanup or reject this fire-and-forget emission promise.
    for (const prepared of preparedHooksList) {
      try {
        await prepared.afterEmitFailed?.();
      } catch (err) {
        warnRestartEmitHookFailure("afterEmitFailed", err);
      }
    }
  }
  return emitResult;
}

async function emitPreparedGatewayRestart(
  hooks?: RestartEmitHooks,
  reasonOverride?: string,
  intent?: GatewayRestartIntent,
  finalIdleCheck?: () => boolean,
  setFenceRollback?: (rollback: (() => void) | null) => void,
  signal?: AbortSignal,
): Promise<boolean> {
  const transientGeneration = restartTransientGeneration;
  try {
    // A delayed restart can become due after host suspension prepared. Independent
    // root admission makes the transition atomic: due restarts block preparation,
    // while a prepared suspension defers emission until it resumes.
    return await runWithGatewayIndependentRootWorkAdmission(
      async () => {
        if (signal?.aborted || transientGeneration !== restartTransientGeneration) {
          return false;
        }
        // SIGUSR1 already queued: coalesce. Run loop owns reopen-or-drain.
        if (hasUnconsumedRestartSignal()) {
          return false;
        }
        // Single live lease, multiple attempts may share it (deferred prepare →
        // concurrent emit / retry). Never invent a dead stand-in lease.
        let signalAdmission = pendingRestartSignalAdmission;
        let ownsFenceLease = false;
        if (!signalAdmission) {
          // Orphan fence: pending without a lease and without a delivered signal.
          rollbackGatewayRestartSignalFence();
          signalAdmission = beginGatewayRestartSignalAdmission();
          if (!signalAdmission) {
            return false;
          }
          pendingRestartSignalAdmission = signalAdmission;
          ownsFenceLease = true;
        }
        let fenceActive = true;
        let keepFenceForRunLoop = false;
        const rollbackFence = () => {
          // A concurrent emitter may queue SIGUSR1 on this shared lease while we
          // await beforeEmit. Cancel/finally must not reopen over an in-flight
          // signal — the run loop owns reopen-or-drain from here.
          if (keepFenceForRunLoop || hasUnconsumedRestartSignal()) {
            return;
          }
          // Adopters share the lease with a still-active prepare/deferral owner.
          // Only the creator may reopen on abandon; stop this attempt's canEmit.
          if (!ownsFenceLease) {
            fenceActive = false;
            return;
          }
          fenceActive = false;
          signalAdmission.rollback();
          if (pendingRestartSignalAdmission === signalAdmission) {
            pendingRestartSignalAdmission = null;
          }
        };
        setFenceRollback?.(rollbackFence);
        try {
          const isIdle = finalIdleCheck
            ? finalIdleCheck() && getActiveGatewayRootWorkCount({ excludeCurrent: true }) === 0
            : true;
          if (!isIdle) {
            return false;
          }
          const emitResult = await emitPreparedGatewayRestartUnderAdmission(
            hooks,
            reasonOverride,
            intent,
            transientGeneration,
            () => fenceActive && !signal?.aborted,
          );
          if (
            emitResult &&
            (emitResult.status === "emitted" ||
              (emitResult.status === "coalesced" && hasUnconsumedRestartSignal()))
          ) {
            // Delivered or already-in-flight signal: run loop owns reopen-or-drain.
            keepFenceForRunLoop = true;
            return true;
          }
          return emitResult !== null;
        } finally {
          // Creator non-delivery reopens; adopters leave the live prepare lease.
          if (!keepFenceForRunLoop) {
            rollbackFence();
          }
          setFenceRollback?.(null);
        }
      },
      "restart:delayed",
      signal,
    );
  } catch (err) {
    if (signal?.aborted) {
      return false;
    }
    if (!isGatewayRestartDraining()) {
      throw err;
    }
    return true;
  }
}

/**
 * Poll pending work until it drains, then emit one restart signal.
 * A positive maxWaitMs keeps the old capped behavior for explicit configs.
 * Shared by both the direct RPC restart path and the config watcher path.
 */
export function deferGatewayRestartUntilIdle(opts: {
  getPendingCount: () => number;
  hooks?: RestartDeferralHooks;
  emitHooks?: RestartEmitHooks;
  pollMs?: number;
  maxWaitMs?: number;
  reason?: string;
  timeoutIntent?: GatewayRestartIntent;
}): RestartDeferralHandle {
  const pollMs = resolveTimerTimeoutMs(opts.pollMs, DEFAULT_DEFERRAL_POLL_MS, 10);
  const maxWaitMs =
    typeof opts.maxWaitMs === "number" && Number.isFinite(opts.maxWaitMs) && opts.maxWaitMs > 0
      ? Math.max(pollMs, Math.floor(opts.maxWaitMs))
      : undefined;

  type EmissionAttempt = {
    controller: AbortController;
    startedAt: number;
    rollbackFence: (() => void) | null;
  };
  let cancelled = false;
  let activeAttempt: EmissionAttempt | null = null;
  let poll: ReturnType<typeof setInterval> | null = null;
  const stopPoll = () => {
    if (poll) {
      clearInterval(poll);
      activeDeferralPolls.delete(poll);
      poll = null;
    }
  };
  const cancelAttempt = () => {
    const attempt = activeAttempt;
    activeAttempt = null;
    // Retire admission waiters as well as a fence already acquired by preparation.
    attempt?.controller.abort();
    attempt?.rollbackFence?.();
  };
  const handle = {
    cancel: () => {
      cancelled = true;
      cancelAttempt();
      stopPoll();
    },
  };
  const startedAt = monotonicNow();
  let nextStillPendingAt = startedAt + DEFAULT_DEFERRAL_STILL_PENDING_WARN_MS;
  let timeoutNotified = false;
  let lastKnownPending: number | undefined;
  const readPendingCount = (): number | undefined => {
    try {
      lastKnownPending = opts.getPendingCount();
      return lastKnownPending;
    } catch (err) {
      // Failed inspection is unknown, not evidence that live work has drained.
      opts.hooks?.onCheckError?.(err);
      return undefined;
    }
  };
  const attemptEmission = (timedOut: boolean) => {
    if (cancelled || activeAttempt) {
      return;
    }
    const attempt: EmissionAttempt = {
      controller: new AbortController(),
      startedAt: monotonicNow(),
      rollbackFence: null,
    };
    activeAttempt = attempt;
    void emitPreparedGatewayRestart(
      opts.emitHooks,
      opts.reason,
      timedOut ? opts.timeoutIntent : undefined,
      timedOut
        ? undefined
        : () => {
            const current = readPendingCount();
            return current !== undefined && current <= 0;
          },
      (rollback) => {
        if (activeAttempt === attempt) {
          attempt.rollbackFence = rollback;
        } else {
          // Cancellation can precede admission; never abandon a late-owned fence.
          rollback?.();
        }
      },
      attempt.controller.signal,
    )
      .then((attempted) => {
        if (activeAttempt !== attempt) {
          return;
        }
        activeAttempt = null;
        if (!attempted) {
          return;
        }
        stopPoll();
        if (!timedOut) {
          opts.hooks?.onReady?.();
        }
      })
      .catch((err: unknown) => {
        if (activeAttempt !== attempt) {
          return;
        }
        cancelAttempt();
        // Retry through the same checks and deadline, never an unchecked emission.
        opts.hooks?.onCheckError?.(err);
      });
  };
  const inspectPending = () => {
    if (cancelled) {
      return;
    }
    const current = readPendingCount();
    const now = monotonicNow();
    const elapsedMs = now - startedAt;
    if (maxWaitMs !== undefined && elapsedMs >= maxWaitMs) {
      if (!timeoutNotified) {
        timeoutNotified = true;
        opts.hooks?.onTimeout?.(lastKnownPending, elapsedMs);
      }
      // Preparation gets a full configured budget, not merely one poll interval.
      // A stuck forced retry is subject to the same bound as the initial attempt.
      if (activeAttempt && now - activeAttempt.startedAt >= maxWaitMs) {
        cancelAttempt();
      }
      attemptEmission(true);
      return;
    }
    if (current !== undefined && current <= 0) {
      attemptEmission(false);
      return;
    }
    if (current !== undefined && current > 0 && now >= nextStillPendingAt) {
      opts.hooks?.onStillPending?.(current, elapsedMs);
      nextStillPendingAt = now + DEFAULT_DEFERRAL_STILL_PENDING_WARN_MS;
    }
  };
  const pending = readPendingCount();
  if (pending !== undefined && pending > 0) {
    opts.hooks?.onDeferring?.(pending);
  }
  poll = setInterval(inspectPending, pollMs);
  activeDeferralPolls.add(poll);
  if (pending !== undefined && pending <= 0) {
    attemptEmission(false);
  }
  return handle;
}

export function triggerOpenClawRestart(): RestartAttempt {
  if (process.env.VITEST || process.env.NODE_ENV === "test") {
    return { ok: true, method: "supervisor", detail: "test mode" };
  }
  return restartGatewayViaSupervisor();
}

export type ScheduledRestart = {
  ok: boolean;
  pid: number;
  signal: "SIGUSR1";
  delayMs: number;
  reason?: string;
  mode: "emit" | "signal" | "supervisor";
  coalesced: boolean;
  cooldownMsApplied: number;
  // True iff the caller's emitHooks own the pending restart slot. Coalesced
  // requests from a different sessionKey are rejected to protect the existing
  // session's continuation (#86742).
  emitHooksQueued: boolean;
};

export function normalizeGatewayRestartDelayMs(delayMs?: number): number {
  return typeof delayMs === "number" && Number.isFinite(delayMs)
    ? Math.min(Math.max(Math.floor(delayMs), 0), 60_000)
    : 2000;
}

export function scheduleGatewaySigusr1Restart(opts?: {
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
    process.listenerCount("SIGUSR1") > 0
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
    signal: "SIGUSR1" as const,
    reason,
    mode,
    cooldownMsApplied,
  };
  const requestedDueAt = nowMs + delayMs + cooldownMsApplied;
  const skipDeferral = opts?.skipDeferral === true;
  let nextPendingEmitHooks = opts?.emitHooks;
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
      // SIGUSR1 already emitted; the new caller's hooks cannot run for this cycle.
      emitHooksQueued: false,
    };
  }

  if (pendingRestartTimer || pendingRestartPreparing) {
    const remainingMs = pendingRestartPreparing ? 0 : Math.max(0, pendingRestartDueAt - nowMs);
    // Hookless forced restarts that own no sentinel may preserve an accepted
    // pending hook; update/handoff callers rely on the default clear path.
    const preservePendingHooks =
      opts?.preservePendingEmitHooksOnDeferralBypass === true &&
      opts?.emitHooks === undefined &&
      pendingRestartSessionKey !== undefined;
    if (pendingRestartPreparing && skipDeferral && activeDeferralPolls.size > 0) {
      restartLog.warn(
        `restart request bypassed active deferral reason=${reason ?? "unspecified"} pendingReason=${pendingRestartReason ?? "unspecified"} ${formatRestartAudit(opts?.audit)}`,
      );
      clearActiveDeferralPolls();
      pendingRestartReason = reason;
      pendingRestartSuccessorOwner = opts?.successorOwner ?? pendingRestartSuccessorOwner;
      if (!preservePendingHooks) {
        pendingRestartEmitHooks = opts?.emitHooks;
        pendingRestartSessionKey = opts?.sessionKey;
      }
      void emitPreparedGatewayRestart(undefined, reason);
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
          `restart continuation dropped: another session owns the pending restart (callerSessionKey=${opts?.sessionKey ?? "unspecified"} pendingSessionKey=${pendingRestartSessionKey ?? "unspecified"})`,
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
        nextPendingEmitHooks = pendingRestartEmitHooks;
        nextPendingSessionKey = pendingRestartSessionKey;
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
        pendingRestartEmitHooks = opts?.emitHooks;
        pendingRestartSessionKey = opts?.emitHooks ? opts.sessionKey : undefined;
      }
      if (opts?.emitHooks && !emitHooksQueued) {
        restartLog.warn(
          `restart continuation dropped: another session owns the pending restart (callerSessionKey=${opts.sessionKey ?? "unspecified"} pendingSessionKey=${pendingRestartSessionKey ?? "unspecified"})`,
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
  pendingRestartEmitHooks = nextPendingEmitHooks;
  pendingRestartSessionKey = nextPendingSessionKey;
  pendingRestartSkipDeferral = skipDeferral;
  armPendingRestartTimer(requestedDueAt, nowMs);
  return {
    ...restartResultBase,
    delayMs: Math.max(0, requestedDueAt - nowMs),
    coalesced: false,
    emitHooksQueued: opts?.emitHooks !== undefined,
  };
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
