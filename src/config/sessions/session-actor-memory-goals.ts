import {
  applySessionGoalOperation,
  assertSessionGoalOperationTime,
  createSessionGoalOperationResult,
  MAX_SESSION_RECEIPTS,
  OPERATION_VALIDITY_MS,
  operationFingerprint,
} from "./goals-operation-policy.js";
import {
  SessionGoalOperationError,
  type SessionGoalManagementCommit,
  type SessionGoalManagementInput,
  type SessionGoalOperation,
  type SessionTranscriptTurnMutation,
} from "./goals-operations.types.js";
import type { SessionActorMemoryState } from "./session-actor-memory-state.js";
import { mergeSessionEntry, type SessionGoal } from "./types.js";

/** The actor commits these receipts with the Goal and its accepted transcript turn. */
export function createSessionActorMemoryGoals(options: {
  state: SessionActorMemoryState;
  agentId: string;
  path: string;
}) {
  const { state, agentId, path } = options;
  const readReceipt = (sessionId: string, operation: SessionGoalOperation) => {
    assertSessionGoalOperationTime(operation, Date.now());
    const receipt = state.goalReceipts.get(operation.operationId);
    if (!receipt) {
      return undefined;
    }
    if (receipt.fingerprint !== operationFingerprint(operation)) {
      throw new SessionGoalOperationError(
        "operation-conflict",
        "Goal operation ID was already used for a different request.",
      );
    }
    if (receipt.result.sessionId !== sessionId) {
      throw new SessionGoalOperationError(
        "session-rebound",
        "Session changed after this Goal operation; refresh before trying again.",
      );
    }
    return structuredClone(receipt.result);
  };
  const commitReceipt = (
    sessionId: string,
    operation: SessionGoalOperation,
    goal: SessionGoal | undefined,
    runId?: string,
  ) => {
    const now = Date.now();
    assertSessionGoalOperationTime(operation, now);
    for (const [id, receipt] of state.goalReceipts) {
      if (receipt.expiresAt <= now) {
        state.goalReceipts.delete(id);
      }
    }
    if (state.goalReceipts.size >= MAX_SESSION_RECEIPTS) {
      throw new SessionGoalOperationError(
        "capacity",
        "Too many recent Goal operations; wait for older requests to expire before trying again.",
      );
    }
    const result = createSessionGoalOperationResult(sessionId, operation, goal, runId);
    state.goalReceipts.set(operation.operationId, {
      fingerprint: operationFingerprint(operation),
      expiresAt: operation.issuedAtMs + OPERATION_VALIDITY_MS,
      result: structuredClone(result),
    });
    return structuredClone(result);
  };
  return {
    readReceipt,
    commitReceipt,
    assertRouting(predicate: SessionTranscriptTurnMutation["routingPredicate"]) {
      // Acquisition binds the target; later config routing changes do not redirect accepted work.
      if (
        predicate &&
        (predicate.agentId !== agentId ||
          predicate.storePath !== path ||
          predicate.canonicalKey !== state.hot.target.sessionKey)
      ) {
        throw new Error("Session routing changed before Goal admission; refresh and retry.");
      }
    },
    mutate(input: SessionGoalManagementInput): SessionGoalManagementCommit {
      if (input.sessionKey !== state.hot.target.sessionKey) {
        throw new SessionGoalOperationError(
          "session-rebound",
          "Goal operation does not target this session actor.",
        );
      }
      const previous = state.hot.entry;
      const replay = readReceipt(input.expectedSessionId, input.operation);
      if (!previous || previous.sessionId !== input.expectedSessionId) {
        throw new SessionGoalOperationError(
          "session-rebound",
          "Session changed; refresh before changing its Goal.",
        );
      }
      if (replay) {
        return { result: replay, replayed: true };
      }
      const goal = applySessionGoalOperation(previous, input.operation, Date.now());
      const sessionEntry = mergeSessionEntry(previous, { goal });
      const result = commitReceipt(input.expectedSessionId, input.operation, goal);
      state.hot.entry = sessionEntry;
      return {
        result,
        replayed: false,
        sessionEntry: structuredClone(sessionEntry),
        previous: structuredClone(previous),
      };
    },
  };
}
