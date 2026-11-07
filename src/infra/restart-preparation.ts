// Prepares deferred restart emission while preserving the coordinator's live state.
import { resolveTimerTimeoutMs } from "@openclaw/normalization-core/number-coercion";
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
import type { GatewayRestartIntent } from "./restart-intent.js";
import {
  GatewayRestartRequest,
  type PendingGatewayRestart,
  type RestartDeferralHandle,
  type RestartDeferralHooks,
  type RestartEmitHooks,
  type GatewayRestartEmitResult,
  type GatewayRestartEmitter,
} from "./restart-request.js";

const DEFAULT_DEFERRAL_POLL_MS = 500;
const DEFAULT_DEFERRAL_STILL_PENDING_WARN_MS = 30_000;
const restartLog = createSubsystemLogger("restart");

type RestartPreparationState = {
  readonly restartTransientGeneration: number;
  readonly pendingRestartRequest: PendingGatewayRestart | undefined;
  readonly pendingRestartReason: string | undefined;
  readonly pendingRestartSuccessorOwner: GatewayRestartIntent["successorOwner"];
  pendingRestartSignalAdmission: GatewayRestartSignalAdmissionLease | null;
};

// State remains owned by restart.ts; getters preserve live reads after every await.
export function createGatewayRestartPreparation(
  state: RestartPreparationState,
  {
    activeDeferralPolls,
    monotonicNow,
    hasUnconsumedRestartSignal,
    clearPendingScheduledRestart,
    shouldPreferRestartReason,
    requestGatewayRestartWithSignalAdmission,
  }: {
    activeDeferralPolls: Set<ReturnType<typeof setInterval>>;
    monotonicNow: () => number;
    hasUnconsumedRestartSignal: () => boolean;
    clearPendingScheduledRestart: () => void;
    shouldPreferRestartReason: (next?: string, current?: string) => boolean;
    requestGatewayRestartWithSignalAdmission: GatewayRestartEmitter;
  },
) {
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
    caller: GatewayRestartRequest | undefined,
    reasonOverride?: string,
    intent?: GatewayRestartIntent,
    transientGeneration = state.restartTransientGeneration,
    canEmit: () => boolean = () => true,
    scheduledRequest?: PendingGatewayRestart,
  ): Promise<GatewayRestartEmitResult | null> {
    const hooks = caller?.hooks;
    const isCurrent = () => transientGeneration === state.restartTransientGeneration && canEmit();
    if (!isCurrent()) {
      return null;
    }

    // Caller preflight runs before the parked drain: the drain loop's tail
    // re-read then also captures hooks accepted (emitHooksQueued: true) while
    // this await was in flight, leaving no async window before emission where
    // parked continuations could be silently dropped.
    let callerPrepared = false;
    if (hooks && caller?.isCurrent()) {
      try {
        await hooks.beforeEmit?.();
        callerPrepared = true;
      } catch (err) {
        restartLog.warn(`restart preparation failed: ${String(err)}`);
      }
      if (!isCurrent()) {
        if (callerPrepared) {
          await rejectPreparedRestartHook(hooks);
        }
        return null;
      }
      if (callerPrepared && !caller.isCurrent()) {
        await rejectPreparedRestartHook(hooks);
        callerPrepared = false;
      }
    }

    // Drain parked emit hooks even when the caller supplies its own. Reload
    // deferral can win the emission race; without this drain the gateway-tool
    // sentinel/continuation is never written and session ownership goes stale.
    // Keep the pending session key until the slot is fully consumed so
    // different-session coalesces during preparation still hit the #86742 guard.
    // Timing note: with an empty slot this stays await-free; mid-flight intent
    // and deferral consumers observe hookless emission at original latency.
    let nextParked = state.pendingRestartRequest?.takeEmitHooks();
    let preparedParked: GatewayRestartRequest | undefined;
    const rejectCallerOnBail = async () => {
      if (hooks && callerPrepared) {
        await rejectPreparedRestartHook(hooks);
      }
    };
    for (;;) {
      if (!isCurrent()) {
        await rejectPreparedRestartHook(preparedParked?.hooks);
        await rejectCallerOnBail();
        return null;
      }
      if (nextParked) {
        if (preparedParked) {
          await rejectPreparedRestartHook(preparedParked.hooks);
          preparedParked = undefined;
          if (!isCurrent()) {
            await rejectCallerOnBail();
            return null;
          }
        }
        if (nextParked.isCurrent()) {
          try {
            await nextParked.hooks?.beforeEmit?.();
            preparedParked = nextParked;
          } catch (err) {
            restartLog.warn(`restart preparation failed: ${String(err)}`);
          }
        }
        nextParked = state.pendingRestartRequest?.takeEmitHooks();
        continue;
      }
      if (preparedParked && !preparedParked.isCurrent()) {
        await rejectPreparedRestartHook(preparedParked.hooks);
        preparedParked = undefined;
      } else if (caller && callerPrepared && !caller.isCurrent()) {
        await rejectPreparedRestartHook(hooks);
        callerPrepared = false;
      } else {
        break;
      }
      // Cleanup can admit another coalesced requester; drain that slot before emission too.
      nextParked = state.pendingRestartRequest?.takeEmitHooks();
    }

    // Non-emitted outcomes roll back every successfully prepared acknowledgement.
    const preparedHooksList = [preparedParked?.hooks, callerPrepared ? hooks : undefined].filter(
      (prepared): prepared is RestartEmitHooks => prepared !== undefined,
    );
    // With caller hooks, emission stays the caller's (or falls back to the core
    // signal path if its preparation failed); parked hooks never own emission
    // when a caller is present.
    const emitOwner =
      hooks && callerPrepared
        ? hooks
        : (hooks && caller?.isCurrent()) ||
            (state.pendingRestartSuccessorOwner &&
              state.pendingRestartRequest?.sessionKey === undefined)
          ? undefined
          : preparedParked?.hooks;

    // Slot settled and no awaits remain before emission — release ownership for
    // every emission attempt, not only hookless ones, so a later session can
    // claim continuation hooks for the next restart cycle.
    if (state.pendingRestartRequest) {
      state.pendingRestartRequest.sessionKey = undefined;
    }

    if (!isCurrent()) {
      await rejectPreparedRestartHooks(preparedHooksList);
      return null;
    }
    if (
      !caller?.isCurrent() &&
      !scheduledRequest?.isCurrent() &&
      !state.pendingRestartRequest?.isCurrent()
    ) {
      restartLog.warn("scheduled restart cancelled: requester authority changed");
      clearPendingScheduledRestart();
      await rejectPreparedRestartHooks(preparedHooksList);
      return { status: "failed" };
    }

    // A managed update can coalesce while beforeEmit awaits. Promote that reason
    // at the last possible moment so the run loop performs a process exit.
    const preferredReason = shouldPreferRestartReason(state.pendingRestartReason, reasonOverride)
      ? state.pendingRestartReason
      : undefined;
    const resolvedReason = preferredReason ?? reasonOverride;
    const successorOwner = state.pendingRestartSuccessorOwner ?? intent?.successorOwner;
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
    options: {
      finalIdleCheck?: () => boolean;
      setFenceRollback?: (rollback: (() => void) | null) => void;
      signal?: AbortSignal;
      scheduledRequest?: PendingGatewayRestart;
    } = {},
  ): Promise<boolean> {
    const { finalIdleCheck, setFenceRollback, signal, scheduledRequest } = options;
    const transientGeneration = state.restartTransientGeneration;
    const caller = scheduledRequest ? undefined : new GatewayRestartRequest(hooks);
    try {
      // A delayed restart can become due after host suspension prepared. Independent
      // root admission makes the transition atomic: due restarts block preparation,
      // while a prepared suspension defers emission until it resumes.
      return await runWithGatewayIndependentRootWorkAdmission(
        async () => {
          if (signal?.aborted || transientGeneration !== state.restartTransientGeneration) {
            return false;
          }
          // SIGUSR2 already queued: coalesce. Run loop owns reopen-or-drain.
          if (hasUnconsumedRestartSignal()) {
            return false;
          }
          // Single live lease, multiple attempts may share it (deferred prepare →
          // concurrent emit / retry). Never invent a dead stand-in lease.
          let signalAdmission = state.pendingRestartSignalAdmission;
          let ownsFenceLease = false;
          if (!signalAdmission) {
            // Orphan fence: pending without a lease and without a delivered signal.
            rollbackGatewayRestartSignalFence();
            signalAdmission = beginGatewayRestartSignalAdmission();
            if (!signalAdmission) {
              return false;
            }
            state.pendingRestartSignalAdmission = signalAdmission;
            ownsFenceLease = true;
          }
          let fenceActive = true;
          let keepFenceForRunLoop = false;
          const rollbackFence = () => {
            // A concurrent emitter may queue SIGUSR2 on this shared lease while we
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
            if (state.pendingRestartSignalAdmission === signalAdmission) {
              state.pendingRestartSignalAdmission = null;
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
              caller,
              reasonOverride,
              intent,
              transientGeneration,
              () => fenceActive && !signal?.aborted,
              scheduledRequest,
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
  function deferGatewayRestartUntilIdle(
    opts: {
      getPendingCount: () => number;
      hooks?: RestartDeferralHooks;
      emitHooks?: RestartEmitHooks;
      pollMs?: number;
      maxWaitMs?: number;
      reason?: string;
      timeoutIntent?: GatewayRestartIntent;
      /**
       * Caller preparation for each attempt. It can wait on locks whose holders
       * need root admission, so it runs as its own root before the attempt takes
       * the restart-signal fence, never under it.
       */
      prepareEmission?: () => Promise<void>;
    },
    scheduledRequest?: PendingGatewayRestart,
  ): RestartDeferralHandle {
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
    let preparation: { controller: AbortController; startedAt: number } | null = null;
    let prepared = false;
    let poll: ReturnType<typeof setInterval> | null = null;
    const stopPoll = () => {
      if (poll) {
        clearInterval(poll);
        activeDeferralPolls.delete(poll);
        poll = null;
      }
    };
    const cancelAttempt = () => {
      preparation?.controller.abort();
      preparation = null;
      prepared = false;
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
    const isIdleOutsideCaller = () => {
      const current = readPendingCount();
      return (
        current !== undefined &&
        current <= 0 &&
        getActiveGatewayRootWorkCount({ excludeCurrent: true }) === 0
      );
    };
    const attemptEmission = (timedOut: boolean) => {
      if (cancelled || activeAttempt || preparation) {
        return;
      }
      if (opts.prepareEmission && !prepared) {
        const prepareEmission = opts.prepareEmission;
        const controller = new AbortController();
        const current = { controller, startedAt: monotonicNow() };
        preparation = current;
        // Same idle rule as the fenced attempt below, checked from this root.
        void runWithGatewayIndependentRootWorkAdmission(
          async () => {
            if (!timedOut && !isIdleOutsideCaller()) {
              return false;
            }
            await prepareEmission();
            return true;
          },
          "restart:prepare",
          controller.signal,
        ).then(
          (ready) => {
            if (preparation !== current) {
              return;
            }
            preparation = null;
            prepared = ready;
            if (ready) {
              inspectPending();
            }
          },
          (err: unknown) => {
            if (preparation !== current) {
              return;
            }
            preparation = null;
            opts.hooks?.onCheckError?.(err);
          },
        );
        return;
      }
      // Each prepared result serves one fenced attempt; retries prepare again.
      prepared = false;
      const attempt: EmissionAttempt = {
        controller: new AbortController(),
        startedAt: monotonicNow(),
        rollbackFence: null,
      };
      activeAttempt = attempt;
      void emitPreparedGatewayRestart(
        opts.emitHooks,
        opts.reason,
        timedOut ? { ...opts.timeoutIntent, drainBudgetExhausted: true } : undefined,
        {
          finalIdleCheck: timedOut
            ? undefined
            : () => {
                const current = readPendingCount();
                return current !== undefined && current <= 0;
              },
          setFenceRollback: (rollback) => {
            if (activeAttempt === attempt) {
              attempt.rollbackFence = rollback;
            } else {
              // Cancellation can precede admission; never abandon a late-owned fence.
              rollback?.();
            }
          },
          signal: attempt.controller.signal,
          scheduledRequest,
        },
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
      const timedOut = maxWaitMs !== undefined && elapsedMs >= maxWaitMs;
      if (timedOut) {
        if (!timeoutNotified) {
          timeoutNotified = true;
          opts.hooks?.onTimeout?.(lastKnownPending, elapsedMs);
        }
        // Preparation gets a full configured budget, not merely one poll interval.
        // A stuck forced retry is subject to the same bound as the initial attempt.
        const startedWork = activeAttempt ?? preparation;
        if (startedWork && now - startedWork.startedAt >= maxWaitMs) {
          cancelAttempt();
        }
        attemptEmission(true);
      } else if (current !== undefined && current <= 0 && !preparation) {
        attemptEmission(false);
        return;
      } else if (current !== undefined && current > 0) {
        // New work can outlive a prepared result; prepare again once idle.
        prepared = false;
      }
      // Preparation can hold the deferral after idle or the deadline; keep reporting it.
      const waiting = preparation !== null || (!timedOut && current !== undefined && current > 0);
      if (waiting && current !== undefined && now >= nextStillPendingAt) {
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

  return { emitPreparedGatewayRestart, deferGatewayRestartUntilIdle };
}
