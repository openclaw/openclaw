import type { ReplyOperation } from "./session-controller.contracts.js";
import { notify } from "./session-controller.lifecycle-state.js";
import {
  getAttachedBackend,
  isCurrentSessionControllerOperation,
  isReplyOperationAbortable,
  type SessionControllerEntry,
} from "./session-controller.state.js";
import { captureSessionControllerStop, stopSession } from "./session-controller.stop.js";
import { lifecycleAdmissionByOperation } from "./session-controller.storage.js";
import type {
  SessionWatchdogEffect,
  SessionWatchdogEffectResult,
} from "./session-controller.watchdog.js";

type ReplyOperationRecoveryContext = {
  readOperation: () => ReplyOperation;
  readOwner: () => SessionControllerEntry;
  hasEnded: () => boolean;
  isOwnerSettled: () => boolean;
  executionCleanups: ReadonlySet<() => Promise<void>>;
  revokeTerminalProducerFences: (
    isCurrent: () => boolean,
    options?: { persistTerminal?: true },
  ) => Promise<{ failures: unknown[]; fenced: boolean }>;
  preserveCleanupOutcome: () => void;
  settleResult: () => void;
  clearState: () => void;
  closeWatchdog: () => void;
  detachUpstreamAbort: () => void;
  settleOwner: () => void;
};

/** Recovery acts on the operation's live custody; all state changes stay with that owner. */
export function createReplyOperationRecovery(context: ReplyOperationRecoveryContext) {
  const cleanupAndFenceOwner = async (params: {
    cleanups: Iterable<() => Promise<void>>;
    failures: unknown[];
    canFence: () => boolean;
    persistTerminal?: true;
  }): Promise<boolean> => {
    const operation = context.readOperation();
    for (const cleanupOwner of params.cleanups) {
      // Stop may close the attempt synchronously; captured cleanup custody survives it.
      if (context.isOwnerSettled()) {
        break;
      }
      try {
        await cleanupOwner();
      } catch (error) {
        params.failures.push(error);
      }
    }
    const canFence = () =>
      params.canFence() &&
      !context.isOwnerSettled() &&
      context.hasEnded() &&
      context.readOwner().active === operation;
    let retired = false;
    if (canFence()) {
      const { failures, fenced } = await context.revokeTerminalProducerFences(canFence, {
        persistTerminal: params.persistTerminal,
      });
      params.failures.push(...failures);
      if (fenced && canFence()) {
        // Revoked writers cannot commit; raw producer cleanup remains independently retained.
        context.settleResult();
        context.clearState();
        context.settleOwner();
        retired = true;
      }
    }
    if (params.failures.length) {
      throw new AggregateError(params.failures, "Watchdog cleanup remains blocked");
    }
    return retired;
  };

  const forceCleanup = async (
    isAttemptCurrent: () => boolean,
    cleanup?: () => Promise<void>,
  ): Promise<boolean> => {
    const operation = context.readOperation();
    const owner = context.readOwner();
    const backend = getAttachedBackend(operation);
    const sessionKey = operation.key;
    const sessionId = operation.sessionId;
    const isCurrent = () =>
      isAttemptCurrent() &&
      context.readOwner() === owner &&
      isCurrentSessionControllerOperation(operation) &&
      operation.key === sessionKey &&
      operation.sessionId === sessionId &&
      getAttachedBackend(operation) === backend;
    if (!isCurrent() || !context.hasEnded()) {
      return false;
    }
    return await cleanupAndFenceOwner({
      cleanups: new Set([...context.executionCleanups, ...(cleanup ? [cleanup] : [])]),
      failures: [],
      canFence: isCurrent,
      persistTerminal: true,
    });
  };

  const retireAdmissionAfterFencing = async (
    isAttemptCurrent: () => boolean = () => true,
  ): Promise<boolean> => {
    const operation = context.readOperation();
    const capturedOwner = context.readOwner();
    const sessionKey = operation.key;
    const sessionId = operation.sessionId;
    const agentId = operation.agentId;
    const backend = getAttachedBackend(operation);
    const admittedLease = lifecycleAdmissionByOperation.get(operation)?.lease;
    const canRetire = () =>
      isAttemptCurrent() &&
      context.readOwner() === capturedOwner &&
      operation.key === sessionKey &&
      operation.sessionId === sessionId &&
      operation.agentId === agentId &&
      isCurrentSessionControllerOperation(operation) &&
      !operation.result &&
      getAttachedBackend(operation) === backend &&
      lifecycleAdmissionByOperation.get(operation)?.lease === admittedLease &&
      ![...(context.readOwner().lifecycle?.effects ?? [])].some(
        (effect) =>
          effect.ref !== admittedLease &&
          (effect.phase === "validating" ||
            effect.phase === "writer" ||
            effect.phase === "acquired"),
      );
    if (!canRetire()) {
      return false;
    }
    const { fenced, failures } = await context.revokeTerminalProducerFences(canRetire);
    if (failures.length) {
      throw failures.length === 1
        ? failures[0]
        : new AggregateError(failures, "Session admission writer fencing failed");
    }
    if (!fenced || !canRetire()) {
      return false;
    }
    // Clear only admission. The raw execution and its error remain owned until complete().
    context.clearState();
    context.closeWatchdog();
    if (capturedOwner.lifecycle) {
      notify(capturedOwner);
    } else {
      capturedOwner.mailbox?.wake();
    }
    return true;
  };

  const expireOwner = async (
    effect: SessionWatchdogEffect,
    cleanup: boolean,
  ): Promise<SessionWatchdogEffectResult> => {
    const operation = context.readOperation();
    if (!effect.isCurrent()) {
      return context.isOwnerSettled() ? "settled" : "resumed";
    }
    if (await effect.recoverExecutionDeadline?.()) {
      return "resumed";
    }
    if (!effect.isCurrent()) {
      return context.isOwnerSettled() ? "settled" : "resumed";
    }
    const backend = getAttachedBackend(operation);
    const sessionId = operation.sessionId;
    const sessionKey = operation.key;
    const isCurrent = () =>
      effect.isCurrent() &&
      operation.sessionId === sessionId &&
      operation.key === sessionKey &&
      getAttachedBackend(operation) === backend;
    const assertCurrent = () => {
      if (!isCurrent()) {
        throw new Error("Watchdog owner retired before recovery");
      }
    };
    const { recoverTerminalSessionPlacementTurn } =
      await import("../agents/session-placement-admission.js");
    if (!isCurrent()) {
      return context.isOwnerSettled() ? "settled" : "resumed";
    }
    let workerFailure: string | undefined;
    try {
      workerFailure = await recoverTerminalSessionPlacementTurn(
        { sessionId, sessionKey, operation },
        assertCurrent,
      );
    } catch (error) {
      if (!isCurrent()) {
        return context.isOwnerSettled() ? "settled" : "resumed";
      }
      throw error;
    }
    if (!isCurrent()) {
      return context.isOwnerSettled() ? "settled" : "resumed";
    }
    if (workerFailure !== undefined) {
      if (context.isOwnerSettled()) {
        return "settled";
      }
      // Preserve the failure in watchdog diagnostics; its producer still owns cleanup.
      throw new Error(workerFailure);
    }
    const cleanups = [...context.executionCleanups];
    const failures: unknown[] = [];
    try {
      if (
        !cleanup &&
        effect.reason === "semantic_stall" &&
        isReplyOperationAbortable(operation) &&
        backend?.recoverStalledModelCall
      ) {
        assertCurrent();
        if (backend.recoverStalledModelCall()) {
          return "model_recovery";
        }
      }
      assertCurrent();
      if (cleanup) {
        // After committed output, only this captured owner may retire native resources.
        context.preserveCleanupOutcome();
        context.detachUpstreamAbort();
        backend?.cancel("superseded");
      } else {
        stopSession({
          capture: captureSessionControllerStop({ operations: [operation] }),
          source: "watchdog",
          assertCurrent,
        });
      }
    } catch (error) {
      failures.push(error);
    }
    await cleanupAndFenceOwner({ cleanups, failures, canFence: () => cleanup });
    return context.isOwnerSettled() ? "settled" : "blocked";
  };

  return { retireAdmissionAfterFencing, expireOwner, forceCleanup };
}
