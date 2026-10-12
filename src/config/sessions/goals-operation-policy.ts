import { sha256Hex } from "@openclaw/normalization-core/node-crypto";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  SessionGoalOperationError,
  type SessionGoalOperation,
  type SessionGoalOperationResult,
  type SessionTranscriptTurnMutation,
} from "./goals-operations.types.js";
import {
  SessionGoalTransitionError,
  buildCreatedSessionGoal,
  buildUpdatedSessionGoalObjective,
  buildUpdatedSessionGoalStatus,
} from "./goals-transitions.js";
import type { SessionEntry, SessionGoal } from "./types.js";

export const OPERATION_VALIDITY_MS = 24 * 60 * 60 * 1000;
const OPERATION_FUTURE_SKEW_MS = 5 * 60 * 1000;
export const MAX_SESSION_RECEIPTS = 4096;

export function assertSessionGoalOperationTime(operation: SessionGoalOperation, now: number): void {
  if (
    !Number.isSafeInteger(operation.issuedAtMs) ||
    operation.issuedAtMs > now + OPERATION_FUTURE_SKEW_MS
  ) {
    throw new SessionGoalOperationError(
      "invalid",
      "Goal operation time is invalid; refresh and try again.",
    );
  }
  // Reject the original timestamp even after pruning its receipt: an expired retry must never
  // recreate a cleared Goal. Clients retain the operation identity unchanged on retry.
  if (operation.issuedAtMs + OPERATION_VALIDITY_MS <= now) {
    throw new SessionGoalOperationError(
      "expired",
      "Goal operation expired; review the current Goal before trying again.",
    );
  }
}

export function operationFingerprint(operation: SessionGoalOperation): string {
  return sha256Hex(
    JSON.stringify([
      operation.issuedAtMs,
      operation.requestFingerprint,
      operation.action,
      "goalId" in operation ? operation.goalId : null,
      "objective" in operation ? operation.objective : null,
      "tokenBudget" in operation ? operation.tokenBudget : null,
      "note" in operation ? operation.note : null,
    ]),
  );
}

/** Apply the same policy used by text commands to the fresh row inside the commit section. */
export function applySessionGoalOperation(
  entry: SessionEntry,
  operation: SessionGoalOperation,
  now: number,
): SessionGoal | undefined {
  try {
    if (operation.action === "start") {
      return buildCreatedSessionGoal(entry, operation, now);
    }
    if (!entry.goal || entry.goal.id !== operation.goalId) {
      throw new SessionGoalOperationError(
        "goal-rebound",
        "Goal changed or was cleared; refresh before trying again.",
      );
    }
    if (operation.action === "clear") {
      return undefined;
    }
    if (operation.action === "edit") {
      return buildUpdatedSessionGoalObjective(entry, operation.objective, now);
    }
    return buildUpdatedSessionGoalStatus(
      entry,
      {
        status:
          operation.action === "resume"
            ? "active"
            : operation.action === "pause"
              ? "paused"
              : operation.action === "block"
                ? "blocked"
                : "complete",
        note: operation.note,
      },
      now,
    );
  } catch (error) {
    if (error instanceof SessionGoalTransitionError) {
      throw new SessionGoalOperationError("invalid", error.message);
    }
    throw error;
  }
}

export function prepareSessionTurnGoalMessage(
  message: unknown,
  mutation: SessionTranscriptTurnMutation | undefined,
  goalId: string | undefined,
): unknown {
  if (!mutation || !goalId || !isRecord(message) || message.role !== "user") {
    return message;
  }
  return {
    ...message,
    __openclaw: {
      ...(isRecord(message["__openclaw"]) ? message["__openclaw"] : {}),
      intent: {
        kind: mutation.operation.action === "start" ? "session-goal-start" : "session-goal-resume",
        version: 1,
        goalId,
        operationId: mutation.operation.operationId,
      },
    },
  };
}

export function createSessionGoalOperationResult(
  sessionId: string,
  operation: SessionGoalOperation,
  goal: SessionGoal | undefined,
  runId?: string,
): SessionGoalOperationResult {
  const goalId = goal?.id ?? ("goalId" in operation ? operation.goalId : undefined);
  if (!goalId) {
    throw new Error("Goal creation did not produce a Goal identity.");
  }
  const result: SessionGoalOperationResult = {
    operationId: operation.operationId,
    action: operation.action,
    sessionId,
    goalId,
    status: runId ? "started" : operation.action === "clear" ? "cleared" : "updated",
    ...(goal ? { goal } : {}),
    ...(runId ? { runId } : {}),
  };
  return result;
}
