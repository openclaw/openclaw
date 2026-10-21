import { GatewayProtocolRequestTimeoutError } from "@openclaw/gateway-client/browser";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type {
  SessionsGoalClearParams,
  SessionsGoalMutationResult,
  SessionsGoalUpdateParams,
} from "../../../../packages/gateway-protocol/src/schema/sessions-goal.js";
import { createChangeListeners } from "../../../../src/shared/listeners.js";
import { GatewayRequestError } from "../../api/gateway.ts";
import type { SessionGoal } from "../../api/types.ts";
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
  isSessionsGoalClearParams,
  isSessionsGoalUpdateParams,
} from "../../lib/protocol-validators.generated/session-input.js";
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
import { isInitialChatHistoryUnavailable, setChatError } from "./chat-history-state.ts";
import type { ChatHost, ChatSendSubmitOptions } from "./chat-send-contract.ts";
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

class GoalOperationOwner {
  private readonly operations = new Map<string, GoalOperation>();
  private readonly listeners = createChangeListeners();
  private startedExecution?: {
    goalId: string;
    runId: string;
    isCurrent: () => boolean;
  };

  recordStartedExecution(goalId: string, runId: string, isCurrent: () => boolean): void {
    // Retain only the latest accepted receipt, not another run lifecycle or durable store.
    this.startedExecution = { goalId, runId, isCurrent };
    this.publish();
  }

  confirmedRunId(goalId: string, currentRunId: string | null | undefined): string | undefined {
    const execution = this.startedExecution;
    return execution?.goalId === goalId && execution.runId === currentRunId && execution.isCurrent()
      ? execution.runId
      : undefined;
  }

  readonly subscribe = this.listeners.subscribe;

  get(signature: string): GoalOperation | undefined {
    return this.operations.get(signature);
  }

  set(signature: string, operation: GoalOperation): void {
    this.operations.set(signature, operation);
    this.publish();
  }

  delete(signature: string): void {
    if (this.operations.delete(signature)) {
      this.publish();
    }
  }

  setPending(operation: GoalOperation, pending: boolean): void {
    operation.pending = pending;
    this.publish();
  }

  expire(operation: GoalOperation): void {
    operation.params = undefined;
    operation.retired = "expired";
    this.publish();
  }

  private readonly publish = this.listeners.publish;
}

const goalOperations = new WeakMap<ChatHost, GoalOperationOwner>();

export function chatGoalOperations(host: ChatHost): GoalOperationOwner {
  let owner = goalOperations.get(host);
  if (!owner) {
    owner = new GoalOperationOwner();
    goalOperations.set(host, owner);
  }
  return owner;
}

type ChatGoalPresentation = {
  value: SessionGoal;
  executionConfirmed: boolean;
  confirmedRunId?: string;
};

/** Receipt confirmation changes the label, never the presence of an existing Goal. */
export function chatGoalPresentation(
  host: ChatHost,
  goal: SessionGoal | undefined,
): ChatGoalPresentation | undefined {
  if (!goal) {
    return undefined;
  }
  const confirmedRunId =
    goal.status === "active"
      ? goalOperations.get(host)?.confirmedRunId(goal.id, host.chatRunId)
      : undefined;
  return { value: goal, executionConfirmed: confirmedRunId !== undefined, confirmedRunId };
}

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

function rejectGoalOperation(host: ChatHost, message: string): false {
  setChatError(host, message);
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
  const operations = chatGoalOperations(host);
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
      const validate =
        isRecord(saved) && "action" in saved
          ? isSessionsGoalUpdateParams
          : isSessionsGoalClearParams;
      operation =
        saved === "expired"
          ? { retired: "expired", pending: false }
          : isRecord(saved) &&
              validate(saved) &&
              saved.sessionKey === sessionKey &&
              saved.agentId === agentId &&
              saved.sessionId === sessionId
            ? { params: saved, pending: false }
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
    operations.expire(operation);
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
      goalId: operation.params?.goalId,
      action: operation.params
        ? "action" in operation.params
          ? operation.params.action
          : "clear"
        : undefined,
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
      goalOperationTarget(host)?.operation === recoveryOperation;
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
    if (action) {
      return false;
    }
    const marker = JSON.stringify(operation.retired);
    operations.setPending(operation, true);
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
    } finally {
      operations.setPending(operation, false);
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
    // A descriptor can expose Goal actions before history binds their recovery identity.
    if (!sessionId || isInitialChatHistoryUnavailable(host)) {
      return rejectGoalOperation(host, t("chat.thread.loading"));
    }
    const identity = {
      sessionKey,
      ...(agentId ? { agentId } : {}),
      sessionId,
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
    const validate =
      action.action === "clear" ? isSessionsGoalClearParams : isSessionsGoalUpdateParams;
    if (!validate(operation.params)) {
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
  operations.setPending(operation, true);
  setChatError(host, null);
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
      if (
        !targetIsCurrent() ||
        goalOperationTarget(host)?.operation !== operation ||
        goalOperationExpired(params.issuedAtMs)
      ) {
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
  } finally {
    operations.setPending(operation, false);
  }
}
