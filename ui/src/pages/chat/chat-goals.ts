import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { Value } from "typebox/value";
import {
  SessionsGoalClearParamsSchema,
  SessionsGoalUpdateParamsSchema,
  type SessionsGoalClearParams,
  type SessionsGoalMutationResult,
  type SessionsGoalUpdateParams,
} from "../../../../packages/gateway-protocol/src/schema/sessions-goal.js";
import { GatewayRequestError } from "../../api/gateway.ts";
import type { GatewaySessionRow } from "../../api/types.ts";
import { t } from "../../i18n/index.ts";
import { registerChatGoalsEnglish } from "../../i18n/locales/en-chat-goals.ts";
import type { ChatGoalAction, ChatGoalDraft, ChatGoalRecovery } from "../../lib/chat/chat-types.ts";
import {
  goalOperationExpired,
  goalOperationScopePrefix,
  goalOperationStorageGeneration,
} from "../../lib/chat/goal-operation-storage.ts";
import { formatUiError } from "../../lib/format-error.ts";
import {
  scopedAgentIdForSession,
  scopedAgentListParamsForSession,
  visibleSessionMatches,
} from "../../lib/sessions/index.ts";
import type { SessionRowObservation } from "../../lib/sessions/session-capability.ts";
import {
  areUiSessionKeysEquivalent,
  resolveUiConversationIdentity,
} from "../../lib/sessions/session-key.ts";
import { generateUUID } from "../../lib/uuid.ts";
import type { ChatHost } from "./chat-send-contract.ts";
import { setChatError } from "./chat-send-queue-state.ts";
import type { ChatSendSubmitOptions } from "./chat-send-submit.ts";
import { refreshChatSessionListForTarget } from "./chat-session.ts";
import { adoptStartedChatRun } from "./run-lifecycle.ts";

registerChatGoalsEnglish();

type ChatGoalHost = ChatHost & {
  handleSendChat: (
    messageOverride?: string,
    options?: ChatSendSubmitOptions,
    submissionAction?: Event,
  ) => Promise<boolean | void>;
};

type GoalParams = SessionsGoalUpdateParams | SessionsGoalClearParams;
type GoalOperation = {
  params?: GoalParams;
  retired?: "expired" | "invalid";
  pending: boolean;
};

const goalOperations = new WeakMap<ChatHost, Map<string, GoalOperation>>();
const GOAL_REQUEST_TIMEOUT_MS = 30_000;
const rejectedGoalReasons = new Set([
  "expired",
  "operation-conflict",
  "session-rebound",
  "goal-rebound",
  "capacity",
  "invalid",
]);

function rejectGoalOperation(host: ChatHost, message: string): false {
  setChatError(host, message);
  host.requestUpdate?.();
  return false;
}

function goalOperationTarget(host: ChatHost) {
  if (!host.client?.recoveryScopeReady || !host.client.recoveryScope) {
    return null;
  }
  const gatewayUrl = host.settings?.gatewayUrl ?? "";
  const sessionKey = host.sessionKey;
  const agentId = scopedAgentIdForSession(host, sessionKey);
  const sessionId = host.currentSessionId ?? undefined;
  const incognito = Boolean(host.selectedChatSessionIncognito);
  const storageKey = `${goalOperationScopePrefix(gatewayUrl, host.client.recoveryScope)}${JSON.stringify([sessionKey, agentId, sessionId, incognito])}`;
  const signature = `${goalOperationStorageGeneration(gatewayUrl)}:${storageKey}`;
  const operations = goalOperations.get(host) ?? new Map<string, GoalOperation>();
  goalOperations.set(host, operations);
  const storage = incognito ? undefined : globalThis.sessionStorage;
  if (!incognito && !storage) {
    throw new Error(t("chat.goals.recoveryUnavailable"));
  }
  let operation = operations.get(signature);
  if (!operation) {
    const raw = storage?.getItem(storageKey);
    if (raw) {
      let saved: unknown;
      try {
        saved = JSON.parse(raw);
      } catch {
        saved = "invalid";
      }
      const schema =
        isRecord(saved) && "action" in saved
          ? SessionsGoalUpdateParamsSchema
          : SessionsGoalClearParamsSchema;
      operation =
        saved === "expired"
          ? { retired: "expired", pending: false }
          : isRecord(saved) &&
              Value.Check(schema, saved) &&
              saved.sessionKey === sessionKey &&
              saved.agentId === agentId &&
              saved.sessionId === sessionId
            ? {
                // SAFETY: The exact action schema and session ownership fields were checked above.
                params: saved as GoalParams,
                pending: false,
              }
            : { retired: "invalid", pending: false };
      if (operation.retired) {
        storage?.setItem(storageKey, JSON.stringify(operation.retired));
      }
      operations.set(signature, operation);
    }
  }
  if (
    operation &&
    !operation.pending &&
    operation.params &&
    goalOperationExpired(operation.params.issuedAtMs)
  ) {
    operation.params = undefined;
    operation.retired = "expired";
    storage?.setItem(storageKey, JSON.stringify("expired"));
  }
  return { sessionKey, agentId, sessionId, signature, storageKey, storage, operations, operation };
}

// Restoration is read-only. Checking is an explicit action, even if the original Goal pill
// disappeared after Clear or changed its available actions after Pause/Resume.
export function chatGoalRecovery(host: ChatHost): ChatGoalRecovery | undefined {
  try {
    const operation = goalOperationTarget(host)?.operation;
    if (!operation) {
      return undefined;
    }
    return {
      pending: operation.pending,
      retired: operation.retired,
      onCheck: () => runGoalOperation(host, undefined, operation),
    };
  } catch {
    return undefined;
  }
}

export async function submitChatGoalDraft(
  host: ChatGoalHost,
  draft: ChatGoalDraft,
  submissionAction?: Event,
): Promise<boolean> {
  if (!draft.objective.trim()) {
    return false;
  }
  if (draft.sessionId && draft.sessionId !== host.currentSessionId) {
    return rejectGoalOperation(host, t("chat.goals.sessionChanged"));
  }
  if (draft.action === "edit") {
    return mutateChatGoal(host, {
      action: "edit",
      goalId: draft.goalId,
      objective: draft.objective,
    });
  }
  // The composer commits its literal objective before calling the normal admission owner.
  if (host.chatMessage !== draft.objective) {
    return false;
  }
  return Boolean(
    await host.handleSendChat(
      undefined,
      {
        intent: { kind: "session-goal-start", version: 1, issuedAtMs: Date.now() },
      },
      submissionAction,
    ),
  );
}

export async function mutateChatGoal(
  host: ChatHost,
  action: { goalId: string } & ({ action: ChatGoalAction } | { action: "edit"; objective: string }),
): Promise<boolean> {
  return runGoalOperation(host, action);
}

async function runGoalOperation(
  host: ChatHost,
  action?: { goalId: string } & (
    | { action: ChatGoalAction }
    | { action: "edit"; objective: string }
  ),
  expectedOperation?: GoalOperation,
): Promise<boolean> {
  const client = host.client;
  if (!client || !host.connected || !client.recoveryScopeReady) {
    return rejectGoalOperation(host, t("chat.goals.offline"));
  }
  if (!client.recoveryScope) {
    return rejectGoalOperation(host, t("chat.goals.recoveryUnavailable"));
  }
  let target: ReturnType<typeof goalOperationTarget>;
  try {
    target = goalOperationTarget(host);
  } catch (error) {
    return rejectGoalOperation(
      host,
      `${t("chat.goals.recoveryUnavailable")} ${formatUiError(error)}`,
    );
  }
  if (!target) {
    return false;
  }
  const { sessionKey, agentId, sessionId, signature, storageKey, storage, operations } = target;
  const rowAgentId = scopedAgentListParamsForSession(host, sessionKey).agentId;
  let { operation } = target;
  // A rendered recovery control owns its captured request, not a later foreground target.
  if (expectedOperation && operation !== expectedOperation) {
    return false;
  }
  const epoch = host.connectionEpoch;
  const recoveryScope = client.recoveryScope;
  const targetIsCurrent = () =>
    host.client === client &&
    host.connected &&
    host.connectionEpoch === epoch &&
    client.recoveryScope === recoveryScope &&
    (host.currentSessionId ?? undefined) === sessionId &&
    visibleSessionMatches(host, sessionKey, agentId);
  if (operation?.pending) {
    return rejectGoalOperation(host, t("chat.goals.actionPending"));
  }
  if (operation?.retired) {
    // Expired/invalid identities cannot be replayed. Refresh before letting the operator
    // make a new decision; never transform a saved request into a fresh mutation.
    if (action) {
      return false;
    }
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
      goalOperationTarget(host)?.operation === operation;
    const marker = JSON.stringify(operation.retired);
    let observation: SessionRowObservation | undefined;
    operation.pending = true;
    host.requestUpdate?.();
    try {
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
      const described = await client.request<{ session?: GatewaySessionRow | null }>(
        "sessions.describe",
        { key: sessionKey, ...(agentId ? { agentId } : {}) },
        { timeoutMs: GOAL_REQUEST_TIMEOUT_MS },
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
    } finally {
      observation?.dispose();
      operation.pending = false;
      host.requestUpdate?.();
    }
  }
  if (operation && action) {
    const params = operation.params;
    if (
      !params ||
      params.goalId !== action.goalId ||
      ("action" in params ? params.action : "clear") !== action.action ||
      (action.action === "edit" &&
        (!("objective" in params) || params.objective !== action.objective))
    ) {
      return rejectGoalOperation(host, t("chat.goals.outcomeUnknown"));
    }
  }
  if (!operation) {
    if (!action) {
      return false;
    }
    const identity = {
      sessionKey,
      ...(agentId ? { agentId } : {}),
      ...(sessionId ? { sessionId } : {}),
      goalId: action.goalId,
      operationId: generateUUID(),
      issuedAtMs: Date.now(),
    };
    operation = {
      params:
        action.action === "clear"
          ? identity
          : action.action === "edit"
            ? { ...identity, action: "edit", objective: action.objective }
            : { ...identity, action: action.action },
      pending: false,
    };
    const schema =
      action.action === "clear" ? SessionsGoalClearParamsSchema : SessionsGoalUpdateParamsSchema;
    if (!Value.Check(schema, operation.params)) {
      return rejectGoalOperation(host, t("chat.goals.invalidRequest"));
    }
    try {
      // Persist before sending: a storage failure must not start an unrecoverable Resume.
      storage?.setItem(storageKey, JSON.stringify(operation.params));
    } catch (error) {
      return rejectGoalOperation(
        host,
        `${t("chat.goals.recoveryUnavailable")} ${formatUiError(error)}`,
      );
    }
    operations.set(signature, operation);
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
  operation.pending = true;
  setChatError(host, null);
  host.requestUpdate?.();
  try {
    const result = await client.request<SessionsGoalMutationResult>(
      "action" in params ? "sessions.goal.update" : "sessions.goal.clear",
      params,
      { timeoutMs: GOAL_REQUEST_TIMEOUT_MS },
    );
    operations.delete(signature);
    // The successful response already settled the operation, even if storage cleanup fails.
    try {
      settleSavedOperation();
    } catch {
      // A retained receipt is safe to reconcile on a later explicit retry.
    }
    if (targetIsCurrent()) {
      if (result.replayed) {
        // Receipt snapshots describe the original decision, not the current goal or run.
        void refreshChatSessionListForTarget(host, { sessionKey, agentId }).catch(
          (error: unknown) => {
            if (targetIsCurrent()) {
              setChatError(host, formatUiError(error));
              host.requestUpdate?.();
            }
          },
        );
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
        }
      }
    }
    return true;
  } catch (error) {
    // UNAVAILABLE can follow a commit. A definitive rejection may retire the intent,
    // but receipt expiry still requires observing the current Goal before a new decision.
    const details =
      error instanceof GatewayRequestError && isRecord(error.details) ? error.details : null;
    const reason = details?.reason;
    const rejected =
      typeof reason === "string" &&
      ((details?.code === "GOAL_OPERATION_REJECTED" && rejectedGoalReasons.has(reason)) ||
        // Resume can be rejected by chat pre-admission before a turn is reserved.
        (reason.startsWith("goal-") && rejectedGoalReasons.has(reason.slice(5))));
    if (rejected) {
      const retired = reason === "expired" || reason === "goal-expired" ? "expired" : undefined;
      if (retired) {
        // The server's receipt clock wins: expiry cannot prove the original outcome.
        operation.params = undefined;
        operation.retired = retired;
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
  } finally {
    operation.pending = false;
    host.requestUpdate?.();
  }
}
