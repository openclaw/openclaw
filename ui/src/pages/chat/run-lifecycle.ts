import {
  normalizeLowercaseStringOrEmpty,
  normalizeNullableString,
} from "@openclaw/normalization-core/string-coerce";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { GatewaySessionRow, SessionRunStatus, SessionsListResult } from "../../api/types.ts";
import { t } from "../../i18n/index.ts";
import { redactToolDetail } from "../../lib/browser-redact.ts";
import type { ChatQueueItem, ChatReplyTarget } from "../../lib/chat/chat-types.ts";
import { isSessionRunActive } from "../../lib/session-run-state.ts";
import {
  reconcileSessionRunTerminal,
  scopedAgentParamsForSession,
  type SessionCapability,
  type SessionRunTerminal,
} from "../../lib/sessions/index.ts";
import {
  areUiSessionKeysEquivalent,
  resolveUiSelectedSessionAgentId,
  resolveUiConversationIdentity,
  uiSessionRowMatchesSelectedChat,
  type UiSessionDefaultsHost,
} from "../../lib/sessions/session-key.ts";
import {
  chatAbortTargetSession,
  currentChatAbortIntent,
  requestChatAbort,
  type ChatAbortIntent,
  type ChatAbortRequestResult,
  type ChatAbortTargetState,
  type PendingChatAbort,
} from "./chat-abort-request.ts";
import type { ChatRunStartupState } from "./chat-run-startup.ts";
import { readChatSessionActionAccess } from "./chat-session-action-access.ts";
import { formatConnectError } from "./connect-error.ts";
import {
  getChatSessionProjection,
  observeChatRunModel,
  reduceChatSessionProjection,
  setChatRunOwner,
} from "./history-merge.ts";
import { resetChatInputHistoryNavigation, type ChatInputHistoryState } from "./input-history.ts";
import type {
  CompactionStatus,
  FallbackStatus,
  ToolStreamHost,
  WaitingApprovalStatus,
} from "./tool-stream-contract.ts";
import { canResetToolStream, resetToolStream, resetToolStreamRun } from "./tool-stream-state.ts";

export const CHAT_RUN_STATUS_TOAST_DURATION_MS = 5_000;

export type ChatHistoryRunObservation = {
  runId: string;
  sessionId: string;
  isCurrent: () => boolean;
};

export type ChatRunError = {
  kind?: "auth_refresh" | "state_contention";
  summary: string;
  /** Display ownership only; the session reducer retains each run's diagnostic. */
  runId?: string;
};

export type ChatRunUiStatus = {
  phase: "done" | "interrupted";
  runId: string | null;
  sessionKey: string;
  occurredAt: number;
};

type TerminalSessionRunStatus = Exclude<SessionRunStatus, "running">;

export type LocalTerminalReconcile = {
  sessionKey: string;
  agentId?: string;
  runId: string | null;
  phase: ChatRunUiStatus["phase"];
  sessionStatus: TerminalSessionRunStatus;
  errorMessage?: string;
};

type TimerHandle = ReturnType<typeof globalThis.setTimeout>;

type RunLifecycleHost = Omit<Partial<ToolStreamHost>, "hello" | "sessions"> & {
  sessionKey: string;
  agentsList?: UiSessionDefaultsHost["agentsList"];
  hello?: { snapshot?: unknown } | null;
  chatRunId?: string | null;
  chatRunError?: ChatRunError | null;
  chatRunLifecycleGeneration?: number;
  chatRunSessionAbortable?: boolean;
  chatStream?: string | null;
  chatStreamStartedAt?: number | null;
  chatRunStartup?: ChatRunStartupState | null;
  compactionStatus?: CompactionStatus | null;
  compactionClearTimer?: TimerHandle | number | null;
  fallbackStatus?: FallbackStatus | null;
  fallbackClearTimer?: TimerHandle | number | null;
  waitingApprovalStatuses?: Map<string, WaitingApprovalStatus>;
  chatRunStatus?: ChatRunUiStatus | null;
  chatRunStatusClearTimer?: TimerHandle | number | null;
  sessionsResult?: SessionsListResult | null;
  sessions?: Partial<Pick<SessionCapability, "reconcileRunTerminal">>;
  lastLocalTerminalReconcile?: LocalTerminalReconcile | null;
  requestUpdate?: () => void;
};

type ReconcileOptions = {
  outcome?: ChatRunUiStatus["phase"];
  sessionStatus?: TerminalSessionRunStatus;
  errorMessage?: string;
  runId?: string | null;
  sessionKey?: string | null;
  agentId?: string;
  sessionKeys?: readonly (string | null | undefined)[];
  clearLocalRun?: boolean;
  clearChatStream?: boolean;
  clearIndicators?: boolean;
  clearToolStream?: boolean;
  clearToolStreamForRun?: boolean;
  clearRunStatus?: boolean;
  publishRunStatus?: boolean;
  armLocalTerminalReconcile?: boolean;
  yielded?: boolean;
  requestUpdate?: boolean;
};

type ChatAbortRunState = ChatAbortTargetState & {
  client: GatewayBrowserClient | null;
  connected: boolean;
  lastError?: string | null;
  chatError?: string | null;
  chatRunError?: ChatRunError | null;
  chatQueue?: readonly ChatQueueItem[];
  lastLocalTerminalReconcile?: LocalTerminalReconcile | null;
  requestUpdate?: () => void;
  /** Reloads history and the authoritative session row. */
  refreshCurrentChat?: () => Promise<void>;
};

type ChatAbortHost = ChatAbortRunState &
  ChatInputHistoryState & {
    pendingAbort?: PendingChatAbort | null;
    chatReplyTarget?: ChatReplyTarget | null;
    sessions?: Partial<Pick<SessionCapability, "deletionState">>;
  };

const CHAT_STOP_COMMANDS = new Set(["/stop", "stop", "esc", "abort", "wait", "exit"]);

function setChatError(state: ChatAbortRunState, error: string | null) {
  state.lastError = error;
  state.chatError = error;
}

export function isChatBusy(host: { chatSending?: boolean; chatRunId?: string | null }) {
  return Boolean(host.chatSending || host.chatRunId);
}

export function adoptStartedChatRun(
  host: RunLifecycleHost & Parameters<typeof reduceChatSessionProjection>[0],
  runId: string,
  startedAt: number,
): void {
  // A terminal event may beat the request ACK; never resurrect that completed run.
  if (host.chatRunStatus?.runId === runId || host.lastLocalTerminalReconcile?.runId === runId) {
    return;
  }
  const currentRun = getChatSessionProjection(host).runs[runId];
  if (currentRun && currentRun.status !== "streaming") {
    return;
  }
  reduceChatSessionProjection(host, { type: "runDelta", runId });
  const adopted = host.chatRunId === runId;
  const adoptedStream = adopted && typeof host.chatStream === "string";
  if (!adopted) {
    // Session-scoped activity can arrive before adoption. Retire only the prior
    // owner so the incoming run keeps its already accepted tools and approvals.
    reconcileChatRunLifecycle(host, {
      clearToolStreamForRun: true,
      clearIndicators: Boolean(host.chatRunId),
      clearRunStatus: true,
      requestUpdate: false,
    });
    host.chatRunError = null;
    if (host.providerPolicyNotice?.runId !== runId) {
      host.providerPolicyNotice = null;
    }
  }
  host.chatRunId = runId;
  setChatRunOwner(host, runId);
  if (!adoptedStream) {
    host.chatStream = "";
    host.chatStreamStartedAt = startedAt;
  }
}

export function setChatRunError(
  state: { chatRunError?: ChatRunError | null },
  summary: string,
  runId?: string,
  kind?: ChatRunError["kind"],
) {
  setChatRunOwner(state, runId);
  state.chatRunError = {
    ...(kind ? { kind } : {}),
    summary: redactToolDetail(summary.trim()),
    ...(runId ? { runId } : {}),
  };
}

type SessionRunHost = {
  chatRunId?: string | null;
  sessionKey: string;
  sessionsResult?: SessionsListResult | null;
};

export function hasDirectSessionRun(host: SessionRunHost): boolean {
  return Boolean(
    host.chatRunId ||
    host.sessionsResult?.sessions.some(
      (session) =>
        areUiSessionKeysEquivalent(session.key, host.sessionKey) && isSessionRunActive(session),
    ),
  );
}

export function hasAbortableSessionRun(host: SessionRunHost): boolean {
  return (
    hasDirectSessionRun(host) ||
    Boolean(
      host.sessionsResult?.sessions.some(
        (session) =>
          areUiSessionKeysEquivalent(session.key, host.sessionKey) &&
          session.hasActiveSubagentRun === true,
      ),
    )
  );
}

export function isChatStopCommand(text: string) {
  return CHAT_STOP_COMMANDS.has(normalizeLowercaseStringOrEmpty(text.trim()));
}

type ChatAbortOptions = { preserveDraft?: boolean };

function ownsChatAbortIntent(state: ChatAbortRunState, intent: ChatAbortIntent): boolean {
  const conversation = resolveUiConversationIdentity(state, state.sessionKey);
  const pendingRunId = state.chatQueue?.find(
    (item) => item.sendState === "sending" && item.sendRunId,
  )?.sendRunId;
  const runId = state.chatRunId ?? pendingRunId ?? null;
  const terminal = state.lastLocalTerminalReconcile;
  const terminalConversation = terminal
    ? resolveUiConversationIdentity(state, terminal.sessionKey, terminal.agentId)
    : undefined;
  const ownsTerminal =
    intent.runId !== null &&
    runId === null &&
    terminal?.runId === intent.runId &&
    terminalConversation?.sessionKey === intent.conversation.sessionKey &&
    terminalConversation.agentId === intent.conversation.agentId;
  return (
    state.client === intent.sourceClient &&
    conversation.sessionKey === intent.conversation.sessionKey &&
    conversation.agentId === intent.conversation.agentId &&
    (runId === intent.runId || ownsTerminal) &&
    scopedAgentParamsForSession(state, state.sessionKey).agentId === intent.agentId
  );
}

// Error publication and follow-up reads remain with the captured Stop intent.
async function settleChatAbortResponse(
  state: ChatAbortRunState,
  intent: ChatAbortIntent,
  result: ChatAbortRequestResult,
): Promise<boolean> {
  if (ownsChatAbortIntent(state, intent)) {
    if (!result.ok) {
      const message = formatConnectError(result.error);
      if (result.errorKind === "state_contention") {
        setChatError(state, null);
        setChatRunError(state, message, intent.runId ?? undefined, result.errorKind);
      } else if (state.chatRunId) {
        setChatError(state, message);
      } else {
        setChatRunError(state, message, intent.runId ?? undefined);
      }
      state.requestUpdate?.();
    } else if (result.warning) {
      setChatRunError(state, result.warning, intent.runId ?? undefined);
      state.requestUpdate?.();
    } else if (result.noActiveRun && state.connected) {
      // Only the refreshed owner may retire a run that is still finalizing.
      await state.refreshCurrentChat?.();
    }
  }
  return result.ok;
}

async function abortChatRun(state: ChatAbortRunState, intent?: ChatAbortIntent) {
  const client = state.client;
  if (!client || !state.connected) {
    return false;
  }
  const captured = intent ?? currentChatAbortIntent(state, client);
  const result = await requestChatAbort(client, captured);
  return settleChatAbortResponse(state, captured, result);
}

export async function replayPendingChatAbort(host: ChatAbortHost): Promise<boolean> {
  const intent = host.pendingAbort;
  const client = host.client;
  if (!intent || !client || !host.connected) {
    return false;
  }
  const recoveryScope =
    host.hello?.auth?.recoveryScope ??
    (client.recoveryScopeReady ? client.recoveryScope : undefined);
  // A retained browser client can reconnect as another principal. The hello
  // owns that identity before asynchronous recovery finishes updating the client.
  if (
    intent.sourceClient !== client ||
    (recoveryScope !== undefined && intent.recoveryScope !== recoveryScope)
  ) {
    host.pendingAbort = null;
    return false;
  }
  if (recoveryScope === undefined) {
    return false;
  }
  if (
    host.sessions?.deletionState?.(intent.sessionKey, intent.agentId, intent.sessionId) ===
    "confirmed"
  ) {
    host.pendingAbort = null;
    return false;
  }
  const session = chatAbortTargetSession(host, intent);
  if (intent.sessionId && session?.sessionId && session.sessionId !== intent.sessionId) {
    host.pendingAbort = null;
    return false;
  }
  const access = readChatSessionActionAccess(
    { client, hello: host.hello, phase: "connected" },
    true,
    { session, sessionAbortable: intent.sessionAbortable },
  ).abort;
  if (!access.allowed && access.cause === "session-not-owned" && !session) {
    // Reconnect can precede the canonical row. Its publication retries this
    // one exact intent; absence must neither authorize it nor discard it.
    return false;
  }
  // Consume before sending so repeated publications cannot duplicate the
  // exact-run request, and restored permissions cannot revive rejected intent.
  host.pendingAbort = null;
  if (!access.allowed) {
    if (ownsChatAbortIntent(host, intent)) {
      setChatError(host, access.reason);
    }
    return false;
  }
  return abortChatRun(host, intent);
}

export async function handleAbortChat(host: ChatAbortHost, opts?: ChatAbortOptions): Promise<void> {
  const disconnectedIntent =
    !host.connected && host.client ? currentChatAbortIntent(host, host.client) : null;
  const pendingAbort =
    disconnectedIntent?.runId && disconnectedIntent.recoveryScope ? disconnectedIntent : null;
  if (!host.connected && !pendingAbort) {
    // Session-only stops cannot be replayed safely against a later run.
    // Explain the blocked action instead of leaving the visible Stop inert.
    setChatError(host, t("chat.questions.disconnected"));
    return;
  }
  if (!opts?.preserveDraft) {
    host.chatMessage = "";
    host.chatMentions = [];
    host.chatReplyTarget = null;
    resetChatInputHistoryNavigation(host);
  }
  if (pendingAbort) {
    host.pendingAbort = pendingAbort;
    return;
  }
  await abortChatRun(host);
}

function clearTimer(timer: TimerHandle | number | null | undefined) {
  if (timer != null) {
    globalThis.clearTimeout(timer as TimerHandle);
  }
}

function clearChatRunStatus(host: RunLifecycleHost) {
  clearTimer(host.chatRunStatusClearTimer);
  host.chatRunStatusClearTimer = null;
  host.chatRunStatus = null;
}

function scheduleRunStatusClear(host: RunLifecycleHost, status: ChatRunUiStatus) {
  clearTimer(host.chatRunStatusClearTimer);
  host.chatRunStatusClearTimer = globalThis.setTimeout(() => {
    const current = host.chatRunStatus;
    if (
      current?.phase !== status.phase ||
      current.runId !== status.runId ||
      current.sessionKey !== status.sessionKey ||
      current.occurredAt !== status.occurredAt
    ) {
      return;
    }
    host.chatRunStatus = null;
    host.chatRunStatusClearTimer = null;
    // Terminal status temporarily masks stale active rows from session polling.
    // Reconcile again as the mask expires so the composer cannot revert to Stop.
    if (!reconcileChatRunAfterSessionStatePublication(host)) {
      host.requestUpdate?.();
    }
  }, CHAT_RUN_STATUS_TOAST_DURATION_MS);
}

function clearRunIndicators(host: RunLifecycleHost, runId?: string | null) {
  if (runId) {
    host.knownAgentRunIds?.delete(runId);
  } else {
    host.knownAgentRunIds?.clear();
  }
  if (!runId || host.chatRunStartup?.runId === runId) {
    host.chatRunStartup = null;
  }
  if (
    (!runId || host.compactionStatus?.runId === runId) &&
    host.compactionStatus?.phase !== "complete"
  ) {
    clearTimer(host.compactionClearTimer);
    host.compactionClearTimer = null;
    host.compactionStatus = null;
  }
  clearTimer(host.fallbackClearTimer);
  host.fallbackClearTimer = null;
  if (host.fallbackStatus) {
    host.fallbackStatus = null;
  }
  for (const [approvalId, waitingApproval] of host.waitingApprovalStatuses ?? []) {
    if (!runId || !waitingApproval.runId || waitingApproval.runId === runId) {
      host.waitingApprovalStatuses?.delete(approvalId);
    }
  }
}

function sessionKeysFor(host: RunLifecycleHost, options: ReconcileOptions): Set<string> {
  const primary = normalizeNullableString(options.sessionKey) ?? host.sessionKey;
  const keys = new Set(primary ? [primary] : []);
  if (uiSessionRowMatchesSelectedChat(host, "global", primary)) {
    keys.add("global");
  }
  for (const row of host.sessionsResult?.sessions ?? []) {
    if (uiSessionRowMatchesSelectedChat(host, row.key, primary, row.agentId)) {
      keys.add(row.key);
    }
  }
  for (const key of options.sessionKeys ?? []) {
    const normalized = normalizeNullableString(key);
    if (normalized) {
      keys.add(normalized);
    }
  }
  return keys;
}

function reconcileSessionRows(
  host: RunLifecycleHost,
  options: ReconcileOptions,
  occurredAt: number,
) {
  if (!options.outcome && !options.yielded) {
    return;
  }
  const keys = sessionKeysFor(host, options);
  if (options.outcome && keys.size === 0) {
    return;
  }
  const status = options.outcome
    ? (options.sessionStatus ?? (options.outcome === "done" ? "done" : "killed"))
    : "running";
  const terminal: SessionRunTerminal = {
    sessionKeys: [...keys],
    agentId: options.agentId,
    runId: options.runId ?? host.chatRunId ?? null,
    status,
    ...(options.outcome ? { errorMessage: options.errorMessage } : {}),
    endedAt: occurredAt,
  };
  if (host.sessionsResult) {
    host.sessionsResult = reconcileSessionRunTerminal(host.sessionsResult, terminal);
  }
  host.sessions?.reconcileRunTerminal?.(terminal);
}

export function reconcileChatRunLifecycle(host: RunLifecycleHost, options: ReconcileOptions = {}) {
  const occurredAt = Date.now();
  const runId = options.runId ?? host.chatRunId ?? null;
  const sessionKey = normalizeNullableString(options.sessionKey) ?? host.sessionKey;
  const agentId = options.agentId ?? resolveUiSelectedSessionAgentId(host, sessionKey);
  const sessionOptions = { ...options, agentId };

  if (options.clearIndicators ?? true) {
    clearRunIndicators(host, runId);
  }
  if (options.clearChatStream) {
    host.chatStream = null;
    host.chatStreamStartedAt = null;
  }
  if (options.clearLocalRun) {
    observeChatRunModel(host, undefined);
    if (host.chatRunId) {
      host.chatRunLifecycleGeneration = (host.chatRunLifecycleGeneration ?? 0) + 1;
    }
    host.chatRunId = null;
    host.chatRunSessionAbortable = undefined;
  }
  if (canResetToolStream(host)) {
    if (options.clearToolStream) {
      resetToolStream(host);
    } else if (options.clearToolStreamForRun && runId) {
      resetToolStreamRun(host, runId);
    }
  }
  if (options.outcome) {
    const status: ChatRunUiStatus = {
      phase: options.outcome,
      runId,
      sessionKey,
      occurredAt,
    };
    reconcileSessionRows(host, sessionOptions, occurredAt);
    if (options.armLocalTerminalReconcile) {
      host.lastLocalTerminalReconcile = {
        sessionKey,
        agentId,
        runId,
        phase: options.outcome,
        sessionStatus: options.sessionStatus ?? (options.outcome === "done" ? "done" : "killed"),
        errorMessage: options.errorMessage,
      };
    }
    if (options.publishRunStatus !== false) {
      host.chatRunStatus = status;
      scheduleRunStatusClear(host, status);
    }
  } else if (options.yielded) {
    reconcileSessionRows(host, sessionOptions, occurredAt);
    host.lastLocalTerminalReconcile = null;
    clearChatRunStatus(host);
  } else if (options.clearRunStatus) {
    clearChatRunStatus(host);
  }
  if (options.requestUpdate !== false) {
    host.requestUpdate?.();
  }
}

function currentSessionRow(host: RunLifecycleHost) {
  return host.sessionsResult?.sessions.find((row) =>
    uiSessionRowMatchesSelectedChat(host, row.key, host.sessionKey, row.agentId),
  );
}

// After a terminal chat event clears local run state, a racing sessions.list
// refresh can still carry a stale "active" row for the session we just
// finished, which would drive the composer back to in-progress. Re-apply
// terminal to that row — but only while its active-run identity exactly
// matches the locally completed run. Keep that identity tombstone until the
// Gateway reports terminal state or a different run, because poll lag has no
// safe time bound. (#87875)
function reconcileStaleSelectedSessionRunAfterLocalCompletion(host: RunLifecycleHost): boolean {
  const recent = host.lastLocalTerminalReconcile;
  if (
    !recent ||
    recent.sessionKey !== host.sessionKey ||
    (recent.agentId !== undefined && recent.agentId !== resolveUiSelectedSessionAgentId(host))
  ) {
    return false;
  }
  const row = currentSessionRow(host);
  if (!row) {
    // A disconnected or incomplete session result proves nothing about the
    // run. Retain the identity so reconnect cannot revive the completed run.
    return false;
  }
  if (!isSessionRunActive(row)) {
    // This may be our own shared terminal projection rather than a Gateway
    // publication. Retain the identity so a duplicate stale event cannot
    // revive the completed run.
    return false;
  }
  // Browser and Gateway clocks can differ. Only an exact active-run identity
  // proves this row still describes the locally completed run.
  if (
    recent.runId == null ||
    row.activeRunIds?.length !== 1 ||
    row.activeRunIds[0] !== recent.runId
  ) {
    host.lastLocalTerminalReconcile = null;
    return false;
  }
  reconcileSessionRows(
    host,
    {
      outcome: recent.phase,
      sessionStatus: recent.sessionStatus,
      errorMessage: recent.errorMessage,
      sessionKey: recent.sessionKey,
      agentId: recent.agentId,
      runId: recent.runId,
    },
    Date.now(),
  );
  host.requestUpdate?.();
  return true;
}

export function reconcileChatRunFromCurrentSessionRow(
  host: RunLifecycleHost,
  options: { publishRunStatus?: boolean } = {},
): boolean {
  if (!host.chatRunId && host.chatStream == null) {
    return reconcileStaleSelectedSessionRunAfterLocalCompletion(host);
  }
  const row = currentSessionRow(host);
  if (!row) {
    return false;
  }
  return reconcileChatRunFromSessionRow(host, row, options);
}

export function reconcileChatRunAfterSessionStatePublication(host: RunLifecycleHost): boolean {
  if (host.chatRunId) {
    const row = currentSessionRow(host);
    if (row?.lastRunId === host.chatRunId) {
      return reconcileChatRunFromSessionRow(host, row, { publishRunStatus: false });
    }
  }
  // Both session subscriptions and direct event reconciliation can republish
  // canonical rows after the local terminal projection; guard both paths.
  const canReconcile =
    host.lastLocalTerminalReconcile != null && !host.chatRunId && host.chatStream == null;
  return canReconcile && reconcileChatRunFromCurrentSessionRow(host, { publishRunStatus: false });
}

export function reconcileChatRunFromSessionRow(
  host: RunLifecycleHost,
  row: GatewaySessionRow,
  options: {
    publishRunStatus?: boolean;
    // Null marks history with no usable run observation.
    historyRun?: ChatHistoryRunObservation | null;
  } = {},
): boolean {
  if (!uiSessionRowMatchesSelectedChat(host, row.key, host.sessionKey, row.agentId)) {
    return false;
  }
  if (!host.chatRunId && host.chatStream == null) {
    return false;
  }
  if (row.hasActiveRun === true) {
    return false;
  }
  if (isSessionRunActive(row)) {
    return false;
  }
  // Transcript snapshots can briefly lose the active-run projection while the
  // persisted lifecycle is still running. Wait for a real terminal status so
  // tool updates cannot flash an interrupted composer state mid-turn.
  if (row.hasActiveRun !== false && row.status === "running") {
    return false;
  }
  const terminalStatus = row.status !== undefined;
  if (row.hasActiveRun !== false && !terminalStatus) {
    return false;
  }
  const runId = host.chatRunId;
  if (runId && row.lastRunId !== runId && (row.lastRunId || options.historyRun !== undefined)) {
    const historyRun = options.historyRun;
    if (
      row.hasActiveRun !== false ||
      !historyRun ||
      historyRun.runId !== runId ||
      historyRun.sessionId !== row.sessionId ||
      !historyRun.isCurrent()
    ) {
      return false;
    }
    // A fresh idle read can retire custody without identifying this run's outcome.
    // An identity-less response still cannot retire a run that began after issuance.
    reconcileChatRunLifecycle(host, {
      runId,
      clearLocalRun: true,
      clearChatStream: true,
      clearToolStreamForRun: true,
      clearRunStatus: true,
    });
    return true;
  }
  let errorMessage: string | undefined;
  if (runId && row.lastRunId === runId && (row.status === "failed" || row.status === "timeout")) {
    // Session publication can beat (or replace) chat.error. Show its diagnostic
    // before retiring the run, without freezing the bounded row summary into the
    // terminal reducer: a later live/history diagnostic can contain more detail.
    errorMessage =
      host.chatRunError?.runId === runId
        ? host.chatRunError.summary
        : row.lastRunError?.trim() ||
          t(
            row.status === "timeout"
              ? "sessionsView.runErrorTimedOut"
              : "sessionsView.runErrorUnknown",
          );
    if (host.chatRunError?.runId !== runId) {
      setChatRunError(host, errorMessage, runId);
    }
  }
  reconcileChatRunLifecycle(host, {
    outcome: row.status === "done" ? "done" : "interrupted",
    sessionStatus: row.status === "running" || row.status === undefined ? "killed" : row.status,
    errorMessage,
    runId,
    sessionKey: host.sessionKey,
    sessionKeys: [row.key],
    clearLocalRun: true,
    clearChatStream: true,
    clearToolStreamForRun: true,
    publishRunStatus: options.publishRunStatus,
    // Shared rows can finish this run before its persisted reply event arrives.
    armLocalTerminalReconcile: Boolean(host.chatRunId && row.lastRunId === host.chatRunId),
  });
  return true;
}
