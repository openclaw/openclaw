import { GatewayProtocolRequestTimeoutError } from "@openclaw/gateway-client/browser";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { SessionsGoalMutationResult } from "../../../../packages/gateway-protocol/src/schema/sessions-goal.js";
import { GatewayRequestError } from "../../api/gateway-connect-errors.ts";
import type { SessionGoal } from "../../api/types.ts";
import { t } from "../../i18n/index.ts";
import { goalOperationExpired } from "../../lib/chat/goal-operation-storage.ts";
import { formatUiError } from "../../lib/format-error.ts";
import type { SessionRowObservation } from "../../lib/sessions/session-capability.ts";
import {
  areUiSessionKeysEquivalent,
  resolveUiConversationIdentity,
} from "../../lib/sessions/session-key.ts";
import {
  mutateChatGoal,
  rejectGoalOperation,
  type GoalOperation,
  type GoalOperationTarget,
} from "./chat-goals.ts";
import { setChatError } from "./chat-history-state.ts";
import type { ChatHost } from "./chat-send-contract.ts";
import { adoptStartedChatRun } from "./run-lifecycle.ts";

const GOAL_REQUEST_TIMEOUT_MS = 30_000;
const rejectedGoalReasons = new Set([
  "expired",
  "operation-conflict",
  "session-rebound",
  "session-busy",
  "goal-rebound",
  "capacity",
  "invalid",
]);

function rejectedGoalReason(error: unknown): string | undefined {
  const details =
    error instanceof GatewayRequestError && isRecord(error.details) ? error.details : null;
  const reason = details?.reason;
  if (
    typeof reason === "string" &&
    ((details?.code === "GOAL_OPERATION_REJECTED" && rejectedGoalReasons.has(reason)) ||
      // Resume can be rejected by chat pre-admission before a turn is reserved.
      (reason.startsWith("goal-") && rejectedGoalReasons.has(reason.slice(5))))
  ) {
    return reason;
  }
  return undefined;
}

export async function executeChatGoalOperation(
  host: ChatHost,
  target: GoalOperationTarget,
  operation: GoalOperation,
  targetIsCurrent: () => boolean,
  operationIsCurrent: () => boolean,
  rowAgentId: string | undefined,
): Promise<boolean> {
  const { sessionKey, agentId, sessionId, signature, storageKey, storage, operations } = target;
  const client = target.client;
  if (!targetIsCurrent() || !operationIsCurrent()) {
    return false;
  }
  const reconcileCurrentGoal = async (recoveryOperation: GoalOperation): Promise<boolean> => {
    const sessions = host.sessions;
    const connection = sessions.captureConnectionScope();
    const rowTarget = resolveUiConversationIdentity(host, sessionKey);
    if (!connection || !rowTarget.agentId) {
      return false;
    }
    const ownsRecovery = () =>
      targetIsCurrent() &&
      host.sessions === sessions &&
      sessions.isConnectionScopeCurrent(connection) &&
      operationIsCurrent() &&
      recoveryOperation === operation;
    let observation: SessionRowObservation | undefined;
    try {
      if (!ownsRecovery()) {
        return false;
      }
      const outcome = await sessions.reconcileMutation(agentId);
      if (!ownsRecovery()) {
        return false;
      }
      // A refreshed roster can omit this target through filtering, archives or pagination.
      // Its exact descriptor and the row owner's request generation must both be current.
      observation = sessions.observeRow(
        { key: rowTarget.sessionKey, agentId: rowTarget.agentId },
        () => {},
        // Goal events can omit descriptor fields; opt into their checked-read invalidation.
        { onInvalidate: () => {} },
      );
      const reconcile = observation.captureReconcile();
      const described = await sessions.describe(
        { key: sessionKey, ...(agentId ? { agentId } : {}) },
        { client, refresh: true, timeoutMs: GOAL_REQUEST_TIMEOUT_MS },
      );
      if (!ownsRecovery()) {
        return false;
      }
      const row = described.session;
      if (
        !row ||
        !areUiSessionKeysEquivalent(row.key, rowTarget.sessionKey) ||
        (sessionId && row.sessionId !== sessionId)
      ) {
        return false;
      }
      const reconciled = reconcile(row);
      if (
        !ownsRecovery() ||
        reconciled.status !== "current" ||
        !reconciled.row ||
        (sessionId && reconciled.row.sessionId !== sessionId)
      ) {
        return false;
      }
      if (outcome.status !== "refreshed") {
        if (outcome.status === "failed") {
          setChatError(host, outcome.error);
        }
        return false;
      }
      return true;
    } finally {
      observation?.dispose();
    }
  };
  if (operation?.retired) {
    // Expired/invalid identities cannot be replayed. Refresh before letting the operator
    // make a new decision; never transform a saved request into a fresh mutation.
    const marker = JSON.stringify(operation.retired);
    try {
      if (!(await reconcileCurrentGoal(operation))) {
        return false;
      }
      // A different consumer may already have retired this marker and saved a new intent.
      if (storage && storage.getItem(storageKey) !== marker) {
        return false;
      }
      storage?.removeItem(storageKey);
      operations.delete(signature);
      setChatError(host, null);
      return true;
    } catch (error) {
      if (targetIsCurrent()) {
        setChatError(host, formatUiError(error));
      }
      return false;
    }
  }
  const params = operation.params;
  if (!params) {
    return false;
  }
  const settleSavedOperation = (retired?: "expired") => {
    const saved: unknown = JSON.parse(storage?.getItem(storageKey) ?? "null");
    if (isRecord(saved) && saved.operationId === params.operationId) {
      if (retired) {
        storage?.setItem(storageKey, JSON.stringify(retired));
      } else {
        storage?.removeItem(storageKey);
      }
    }
  };
  try {
    const request = () =>
      client.request<SessionsGoalMutationResult>(
        "action" in params ? "sessions.goal.update" : "sessions.goal.clear",
        params,
        { timeoutMs: GOAL_REQUEST_TIMEOUT_MS },
      );
    let result: SessionsGoalMutationResult;
    try {
      result = await request();
    } catch (error) {
      if (
        !("action" in params && params.action === "resume") ||
        !targetIsCurrent() ||
        rejectedGoalReason(error) !== undefined ||
        !(
          error instanceof GatewayProtocolRequestTimeoutError ||
          (error instanceof GatewayRequestError && error.code === "UNAVAILABLE")
        )
      ) {
        throw error;
      }
      // Reconcile a lost ACK within this explicit Resume, preserving its durable identity.
      // Rendering or restoring a saved request never starts this retry.
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 1_000);
      });
      if (!targetIsCurrent() || !operationIsCurrent() || goalOperationExpired(params.issuedAtMs)) {
        throw error;
      }
      result = await request();
    }
    // Receipts describe the original decision. Keep recovery until the current goal is read.
    if (result.replayed && !(await reconcileCurrentGoal(operation))) {
      return false;
    }
    operations.delete(signature);
    // The successful response already settled the operation, even if storage cleanup fails.
    try {
      settleSavedOperation();
    } catch {
      // A retained receipt is safe to reconcile on a later explicit retry.
    }
    if (targetIsCurrent()) {
      if (result.replayed) {
        return true;
      }
      const row = host.sessionsResult?.sessions.find(
        (entry) =>
          areUiSessionKeysEquivalent(entry.key, sessionKey) &&
          entry.sessionId === sessionId &&
          (entry.agentId === undefined || entry.agentId === rowAgentId),
      );
      // A newer event or a replacement goal wins over a delayed mutation response.
      if (
        row?.goal?.id === params.goalId &&
        (!result.goal || result.goal.updatedAt >= row.goal.updatedAt)
      ) {
        if (rowAgentId && sessionId) {
          host.sessions.patchRowLocal(
            row.key,
            { goal: result.goal },
            { agentId: rowAgentId, sessionId },
          );
        }
        if (result.status === "started" && result.runId) {
          adoptStartedChatRun(host, result.runId, Date.now());
          operations.recordStartedExecution(params.goalId, result.runId, targetIsCurrent);
        }
      }
    }
    return true;
  } catch (error) {
    // UNAVAILABLE can follow a commit. A definitive rejection may retire the intent,
    // but receipt expiry still requires observing the current Goal before a new decision.
    const reason = rejectedGoalReason(error);
    const rejected = reason !== undefined;
    if (rejected) {
      const retired = reason === "expired" || reason === "goal-expired" ? "expired" : undefined;
      if (retired) {
        // The server's receipt clock wins: expiry cannot prove the original outcome.
        operations.expire(operation);
      } else {
        operations.delete(signature);
      }
      try {
        settleSavedOperation(retired);
      } catch {
        // Do not replace an unavailable durable record with a new operation identity.
      }
    }
    if (targetIsCurrent()) {
      setChatError(
        host,
        rejected
          ? formatUiError(error)
          : `${t("chat.goals.outcomeUnknown")} ${formatUiError(error)}`,
      );
    }
    return false;
  }
}

export async function confirmChatGoalReplacement(
  host: ChatHost,
  objective: string,
  capture: {
    goalId: string;
    previousObjective: string;
    status: SessionGoal["status"];
    updatedAt: number;
    expectedRunId: string | undefined;
    scopeIsCurrent: () => boolean;
    currentGoal: () => SessionGoal | undefined;
    unavailable: () => string | null;
    runId: () => string | null | undefined;
  },
): Promise<boolean> {
  const {
    goalId,
    previousObjective,
    status,
    updatedAt,
    expectedRunId,
    scopeIsCurrent,
    currentGoal,
    unavailable,
    runId,
  } = capture;
  const { showConfirmDialog } = await import("../../components/confirm-dialog.ts");
  if (!scopeIsCurrent()) {
    return false;
  }
  const confirmed = await showConfirmDialog({
    title: t("chat.goals.replaceTitle"),
    message: t(expectedRunId ? "chat.goals.replaceRunningMessage" : "chat.goals.replaceMessage"),
    details: objective,
    confirmLabel: t("chat.goals.replace"),
  });
  if (!confirmed || !scopeIsCurrent()) {
    return false;
  }
  const latest = currentGoal();
  if (
    latest?.id !== goalId ||
    latest.objective !== previousObjective ||
    latest.status !== status ||
    latest.updatedAt !== updatedAt
  ) {
    return rejectGoalOperation(host, t("chat.goals.goalChanged"));
  }
  const error = unavailable();
  if (error) {
    return rejectGoalOperation(host, error);
  }
  if (runId() !== expectedRunId) {
    return rejectGoalOperation(host, t("chat.goals.goalChanged"));
  }
  return await mutateChatGoal(
    host,
    expectedRunId
      ? { action: "replace", goalId, objective, expectedRunId, expectedGoalUpdatedAt: updatedAt }
      : { action: "edit", goalId, objective },
  );
}
