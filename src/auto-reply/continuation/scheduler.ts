/**
 * Continuation scheduler — chain/cost enforcement and turn scheduling.
 *
 * Handles the post-response decision: should we schedule another turn (work)
 * or dispatch a delegate? Enforces maxChainLength, costCapTokens, and delay
 * clamping. Arms timers for delayed work/delegates.
 *
 * NO generation guard. Delayed work survives channel noise by design.
 * Safety mechanisms: chain depth, token budget, per-turn delegate cap, delay bounds.
 *
 * RFC: docs/design/continue-work-signal-v2.md §3.1–§3.4
 */

import { createSubsystemLogger } from "../../logging/subsystem.js";
import { clampDelayMs } from "./config.js";
import {
  addDelayedContinuationReservation,
  highestDelayedContinuationReservationHop,
} from "./delegate-store.js";
import {
  registerContinuationTimerHandle,
  retainContinuationTimerRef,
  unregisterContinuationTimerHandle,
} from "./state.js";
import type { ChainState, ContinuationRuntimeConfig, ContinuationSignal } from "./types.js";

const log = createSubsystemLogger("continuation/scheduler");

export type { ChainState } from "./types.js";

export type ScheduleWorkResult =
  | { outcome: "scheduled"; timerHandle: ReturnType<typeof setTimeout>; nextChainCount: number }
  | { outcome: "chain-capped" }
  | { outcome: "cost-capped" };

export type ScheduleDelegateResult =
  | { outcome: "scheduled-immediate"; nextChainCount: number }
  | { outcome: "scheduled-delayed"; reservationId: string; nextChainCount: number }
  | { outcome: "chain-capped" }
  | { outcome: "cost-capped" };

/**
 * Check chain and cost caps. Returns null if clear to proceed, or the
 * rejection reason.
 */
export function checkContinuationBudget(params: {
  chainState: ChainState;
  config: ContinuationRuntimeConfig;
  sessionKey: string;
  highestReservationHop?: number;
}): "chain-capped" | "cost-capped" | null {
  const { chainState, config, sessionKey } = params;
  const allocatedChainHop = Math.max(
    chainState.currentChainCount,
    params.highestReservationHop ?? highestDelayedContinuationReservationHop(sessionKey),
  );

  if (allocatedChainHop >= config.maxChainLength) {
    log.info(
      `[continuation] Chain depth ${allocatedChainHop}/${config.maxChainLength} — capped for session ${sessionKey}`,
    );
    return "chain-capped";
  }

  if (config.costCapTokens > 0 && chainState.accumulatedChainTokens > config.costCapTokens) {
    log.info(
      `[continuation] Chain cost ${chainState.accumulatedChainTokens}/${config.costCapTokens} — capped for session ${sessionKey}`,
    );
    return "cost-capped";
  }

  return null;
}

/**
 * Schedule a WORK continuation turn after a delay.
 *
 * Arms a timer that calls `onFire` when the delay elapses. The timer does NOT
 * check generation drift — delayed work survives channel noise.
 */
export function scheduleWorkContinuation(params: {
  signal: ContinuationSignal & { kind: "work" };
  chainState: ChainState;
  config: ContinuationRuntimeConfig;
  sessionKey: string;
  onFire: (
    nextChainCount: number,
    chainStartedAt: number,
    accumulatedTokens: number,
    workReason?: string,
  ) => void;
  workReason?: string;
}): ScheduleWorkResult {
  const { signal, chainState, config, sessionKey, onFire, workReason } = params;

  const budgetCheck = checkContinuationBudget({ chainState, config, sessionKey });
  if (budgetCheck) {
    return { outcome: budgetCheck };
  }

  const nextChainCount =
    Math.max(chainState.currentChainCount, highestDelayedContinuationReservationHop(sessionKey)) +
    1;

  const clampedDelay = clampDelayMs(signal.delayMs, config);

  log.info(
    `[continuation] WORK timer set: delayMs=${clampedDelay} hop=${nextChainCount}/${config.maxChainLength} session=${sessionKey}`,
  );

  retainContinuationTimerRef(sessionKey);
  const timerHandle = setTimeout(() => {
    try {
      log.info(`[continuation] WORK timer fired for session ${sessionKey}`);
      onFire(
        nextChainCount,
        chainState.chainStartedAt,
        chainState.accumulatedChainTokens,
        workReason,
      );
    } catch (err) {
      // The user-supplied onFire callback does enqueueSystemEvent +
      // requestHeartbeatNow from agent-runner.ts; either
      // can throw under bounded-queue / disk conditions. Without this catch
      // the throw propagates to the event loop as an unhandled exception.
      log.warn(
        `[continuation:work-fire-failed] session=${sessionKey} error=${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      unregisterContinuationTimerHandle(sessionKey, timerHandle);
    }
  }, clampedDelay);
  registerContinuationTimerHandle(sessionKey, timerHandle);
  timerHandle.unref();

  return { outcome: "scheduled", timerHandle, nextChainCount };
}

/**
 * Generate a cryptographically random UUID for reservation IDs.
 */
function generateSecureUuid(): string {
  return crypto.randomUUID();
}

/**
 * Schedule a DELEGATE continuation — either immediate or delayed.
 *
 * Immediate delegates are dispatched right away (the caller handles spawn).
 * Delayed delegates are parked as reservations and armed with a timer.
 */
export function scheduleDelegateContinuation(params: {
  signal: ContinuationSignal & { kind: "delegate" };
  chainState: ChainState;
  config: ContinuationRuntimeConfig;
  sessionKey: string;
  onImmediateSpawn: (
    plannedHop: number,
    task: string,
    options?: { silent?: boolean; silentWake?: boolean; startedAt?: number },
  ) => Promise<boolean>;
  onDelayedSpawn: (reservation: {
    plannedHop: number;
    task: string;
    silent?: boolean;
    silentWake?: boolean;
    startedAt?: number;
  }) => Promise<boolean>;
}): ScheduleDelegateResult {
  const { signal, chainState, config, sessionKey } = params;

  const budgetCheck = checkContinuationBudget({ chainState, config, sessionKey });
  if (budgetCheck) {
    return { outcome: budgetCheck };
  }

  const nextChainCount =
    Math.max(chainState.currentChainCount, highestDelayedContinuationReservationHop(sessionKey)) +
    1;

  // TaskFlow enqueue (via addDelayedContinuationReservation / caller's
  // enqueuePendingDelegate) is the source of truth for pending-state; the
  // runner reads it via pendingDelegateCount().

  if (signal.delayMs && signal.delayMs > 0) {
    // Delayed dispatch: park reservation, arm timer.
    const clampedDelay = clampDelayMs(signal.delayMs, config);
    const reservationId = generateSecureUuid();

    addDelayedContinuationReservation(sessionKey, {
      id: reservationId,
      source: "bracket",
      task: signal.task,
      createdAt: chainState.chainStartedAt,
      fireAt: Date.now() + clampedDelay,
      plannedHop: nextChainCount,
      silent: signal.silent,
      silentWake: signal.silentWake,
    });

    log.info(
      `[continuation] DELEGATE timer set: delayMs=${clampedDelay} hop=${nextChainCount}/${config.maxChainLength} session=${sessionKey}`,
    );

    retainContinuationTimerRef(sessionKey);
    const timerHandle = setTimeout(() => {
      try {
        log.info(
          `[continuation] DELEGATE timer fired: hop=${nextChainCount}/${config.maxChainLength} session=${sessionKey}`,
        );
        // `.catch` replaces the previous bare `void` which discarded
        // rejections and caused them to surface as
        // unhandled rejections in the Node event loop.
        params
          .onDelayedSpawn({
            plannedHop: nextChainCount,
            task: signal.task,
            silent: signal.silent,
            silentWake: signal.silentWake,
            startedAt: chainState.chainStartedAt,
          })
          .catch((err) => {
            log.warn(
              `[continuation:delayed-spawn-failed] hop=${nextChainCount}/${config.maxChainLength} session=${sessionKey} error=${err instanceof Error ? err.message : String(err)}`,
            );
          });
      } finally {
        unregisterContinuationTimerHandle(sessionKey, timerHandle);
      }
    }, clampedDelay);
    registerContinuationTimerHandle(sessionKey, timerHandle);
    timerHandle.unref();

    return { outcome: "scheduled-delayed", reservationId, nextChainCount };
  }

  // Immediate dispatch.
  log.info(
    `[continuation] DELEGATE immediate spawn: hop=${nextChainCount}/${config.maxChainLength} session=${sessionKey}`,
  );
  // Same unhandled-rejection concern as the delayed branch. Catch + warn
  // rather than `void` discard.
  params
    .onImmediateSpawn(nextChainCount, signal.task, {
      silent: signal.silent,
      silentWake: signal.silentWake,
      startedAt: chainState.chainStartedAt,
    })
    .catch((err) => {
      log.warn(
        `[continuation:immediate-spawn-failed] hop=${nextChainCount}/${config.maxChainLength} session=${sessionKey} error=${err instanceof Error ? err.message : String(err)}`,
      );
    });

  return { outcome: "scheduled-immediate", nextChainCount };
}
