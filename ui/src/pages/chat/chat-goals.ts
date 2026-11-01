import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type {
  SessionsGoalClearParams,
  SessionsGoalUpdateParams,
} from "../../../../packages/gateway-protocol/src/schema/sessions-goal.js";
import {
  matchSlashCommandToken,
  splitCommandAction,
} from "../../../../src/auto-reply/reply/commands-slash-parse.js";
import { createChangeListeners } from "../../../../src/shared/listeners.js";
import type { SessionGoal } from "../../api/types.ts";
import { t } from "../../i18n/index.ts";
import { registerChatGoalsEnglish } from "../../i18n/locales/en-chat-goals.ts";
import { registerChatSessionEnglish } from "../../i18n/locales/en-chat-session.ts";
import type {
  ChatGoalDraft,
  ChatGoalMutationAction,
  ChatGoalRecovery,
} from "../../lib/chat/chat-types.ts";
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
} from "../../lib/sessions/navigation.ts";
import { generateUUID } from "../../lib/uuid.ts";
import { captureChatConnectionOwner } from "./chat-connection-owner.ts";
import { isInitialChatHistoryUnavailable, setChatError } from "./chat-history-state.ts";
import type { ChatHost, ChatSendSubmitOptions } from "./chat-send-contract.ts";
import { chatSendHoldReason } from "./chat-send-support.ts";
import { hasDirectSessionRun, isChatBusy } from "./run-lifecycle.ts";

registerChatSessionEnglish();

registerChatGoalsEnglish();

type ChatGoalHost = ChatHost & {
  handleSendChat: (
    messageOverride?: string,
    options?: ChatSendSubmitOptions,
    submissionAction?: Event,
  ) => Promise<boolean | void>;
};

type GoalParams = SessionsGoalUpdateParams | SessionsGoalClearParams;
export type GoalOperation = {
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

export function rejectGoalOperation(host: ChatHost, message: string): false {
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
  return {
    client: host.client,
    sessionKey,
    agentId,
    sessionId,
    signature,
    storageKey,
    storage,
    operations,
    operation,
  };
}

export type GoalOperationTarget = NonNullable<ReturnType<typeof goalOperationTarget>>;

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
      onCheck: () => mutateChatGoal(host, undefined, operation),
    };
  } catch {
    return undefined;
  }
}

/** Only creation syntax is intercepted; explicit management commands keep their normal path. */
export function chatGoalCreationObjective(message: string): string | undefined {
  const args = matchSlashCommandToken(message, "/goal");
  if (!args) {
    return undefined;
  }
  const parsed = splitCommandAction(args);
  if (["start", "set", "create"].includes(parsed.action)) {
    return parsed.args || undefined;
  }
  if (
    ["status", "edit", "pause", "resume", "complete", "done", "block", "blocked", "clear"].includes(
      parsed.action,
    )
  ) {
    return undefined;
  }
  return args;
}

/** Undefined means first creation: leave it with the ordinary send/admission owner. */
export async function replaceExistingChatGoal(
  host: ChatHost,
  objective: string,
): Promise<boolean | undefined> {
  const currentRow = () =>
    host.sessionsResult?.sessions.find(
      (row) =>
        row.sessionId === host.currentSessionId &&
        visibleSessionMatches(
          host,
          row.key,
          row.agentId ?? host.sessionsResultAgentId ?? undefined,
        ),
    );
  const currentGoal = () => currentRow()?.goal;
  const goal = currentGoal();
  if (!goal) {
    return undefined;
  }
  const sessionKey = host.sessionKey;
  const sessionId = host.currentSessionId;
  const agentId = scopedAgentIdForSession(host, sessionKey);
  const connectionIsCurrent = captureChatConnectionOwner(host, false);
  const scopeIsCurrent = () =>
    connectionIsCurrent() &&
    host.currentSessionId === sessionId &&
    visibleSessionMatches(host, sessionKey, agentId);
  const runId = () => host.chatRunId ?? currentRow()?.activeRunIds?.[0];
  const expectedRunId = goal.status === "active" ? runId() : undefined;
  // Capture values, not a renderer-owned row that may be replaced while the modal is open.
  const { id: goalId, objective: previousObjective, status, updatedAt } = goal;
  const unavailable = () => {
    if (!host.connected || !host.client) {
      return t("chat.goals.offline");
    }
    if (!sessionId || isInitialChatHistoryUnavailable(host)) {
      return t("chat.thread.loading");
    }
    const hold = chatSendHoldReason(host, sessionKey, false, agentId);
    if (hold) {
      return hold;
    }
    const recovery = chatGoalRecovery(host);
    if (recovery) {
      return t(recovery.pending ? "chat.goals.actionPending" : "chat.goals.outcomeUnknown");
    }
    if (currentGoal()?.status === "complete") {
      return t("chat.goals.editUnavailable");
    }
    if ((isChatBusy(host) || hasDirectSessionRun(host)) && !expectedRunId) {
      return t("chat.goals.busy");
    }
    return null;
  };
  const initialError = unavailable();
  if (initialError) {
    return rejectGoalOperation(host, initialError);
  }
  try {
    const { confirmChatGoalReplacement } = await import("./chat-goal-operations.runtime.ts");
    return await confirmChatGoalReplacement(host, objective, {
      goalId,
      previousObjective,
      status,
      updatedAt,
      expectedRunId,
      scopeIsCurrent,
      currentGoal,
      unavailable,
      runId,
    });
  } catch (error) {
    if (scopeIsCurrent()) {
      setChatError(host, formatUiError(error));
    }
    return false;
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
  action?: ChatGoalMutationAction,
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
  if (operation?.retired && action) {
    return false;
  }
  if (operation && action) {
    const params = operation.params;
    if (
      !params ||
      params.goalId !== action.goalId ||
      ("action" in params ? params.action : "clear") !== action.action ||
      ((action.action === "edit" || action.action === "replace") &&
        (!("objective" in params) || params.objective !== action.objective)) ||
      (action.action === "replace" &&
        (!("action" in params) ||
          params.action !== "replace" ||
          params.expectedRunId !== action.expectedRunId ||
          params.expectedGoalUpdatedAt !== action.expectedGoalUpdatedAt))
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
    if (action.action === "resume" && (isChatBusy(host) || hasDirectSessionRun(host))) {
      return rejectGoalOperation(host, t("chat.goals.busy"));
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
          : action.action === "replace"
            ? {
                ...identity,
                sessionId,
                action: "replace",
                objective: action.objective,
                expectedRunId: action.expectedRunId,
                expectedGoalUpdatedAt: action.expectedGoalUpdatedAt,
              }
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
  if (!params && !operation.retired) {
    return false;
  }
  operations.setPending(operation, true);
  if (!operation.retired) {
    setChatError(host, null);
  }
  const admittedOperation = operation;
  try {
    const { executeChatGoalOperation } = await import("./chat-goal-operations.runtime.ts");
    return await executeChatGoalOperation(
      host,
      target,
      admittedOperation,
      targetIsCurrent,
      () => goalOperationTarget(host)?.operation === admittedOperation,
      rowAgentId,
    );
  } catch (error) {
    if (targetIsCurrent()) {
      setChatError(host, `${t("chat.goals.outcomeUnknown")} ${formatUiError(error)}`);
    }
    return false;
  } finally {
    operations.setPending(admittedOperation, false);
  }
}
