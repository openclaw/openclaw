import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { GatewaySessionRow, SessionRunStatus, SessionsListResult } from "../../api/types.ts";
import { isSessionRunActive } from "../../lib/session-run-state.ts";
import { scopedAgentParamsForSession, type SessionScopeHost } from "../../lib/sessions/index.ts";
import { uiSessionRowMatchesSelectedChat } from "../../lib/sessions/session-key.ts";
import { normalizeLowercaseStringOrEmpty } from "../../lib/string-coerce.ts";
import { formatConnectError } from "./connect-error.ts";
import { resetChatInputHistoryNavigation, type ChatInputHistoryState } from "./input-history.ts";
// Control UI chat module implements run lifecycle behavior.
import { resetToolStream, type CompactionStatus, type FallbackStatus } from "./tool-stream.ts";

export const CHAT_RUN_STATUS_TOAST_DURATION_MS = 5_000;

export type ChatRunUiStatus = {
  phase: "done" | "interrupted";
  runId: string | null;
  sessionKey: string;
  occurredAt: number;
};

export type LocalTerminalReconcile = {
  sessionKey: string;
  runId: string | null;
  phase: ChatRunUiStatus["phase"];
  sessionStatus: SessionRunStatus;
};

type TimerHandle = ReturnType<typeof globalThis.setTimeout>;

type RunLifecycleHost = Omit<Partial<Parameters<typeof resetToolStream>[0]>, "hello"> & {
  sessionKey: string;
  agentsList?: { mainKey?: string | null } | null;
  hello?: { snapshot?: unknown } | null;
  chatRunId?: string | null;
  chatStream?: string | null;
  chatStreamStartedAt?: number | null;
  chatSideResultTerminalRuns?: Set<string>;
  compactionStatus?: CompactionStatus | null;
  compactionClearTimer?: TimerHandle | number | null;
  fallbackStatus?: FallbackStatus | null;
  fallbackClearTimer?: TimerHandle | number | null;
  chatRunStatus?: ChatRunUiStatus | null;
  chatRunStatusClearTimer?: TimerHandle | number | null;
  sessionsResult?: SessionsListResult | null;
  lastLocalTerminalReconcile?: LocalTerminalReconcile | null;
  requestUpdate?: () => void;
};

type ReconcileOptions = {
  outcome?: ChatRunUiStatus["phase"];
  sessionStatus?: SessionRunStatus;
  runId?: string | null;
  sessionKey?: string | null;
  sessionKeys?: readonly (string | null | undefined)[];
  clearLocalRun?: boolean;
  clearChatStream?: boolean;
  clearIndicators?: boolean;
  clearToolStream?: boolean;
  clearSideResultTerminalRuns?: boolean;
  clearRunStatus?: boolean;
  publishRunStatus?: boolean;
  armLocalTerminalReconcile?: boolean;
};

type ChatAbortRunState = SessionScopeHost & {
  client: GatewayBrowserClient | null;
  connected: boolean;
  sessionKey: string;
  chatRunId?: string | null;
  lastError?: string | null;
  chatError?: string | null;
};

type ChatAbortHost = ChatAbortRunState &
  ChatInputHistoryState & {
    pendingAbort?: { runId?: string | null; sessionKey: string; agentId?: string } | null;
    sessionsResult?: SessionsListResult | null;
  };

const CHAT_STOP_COMMANDS = new Set(["/stop", "stop", "esc", "abort", "wait", "exit"]);

function toSessionKey(value: string | null | undefined): string | null {
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed ? trimmed : null;
}

function setChatError(state: ChatAbortRunState, error: string | null) {
  state.lastError = error;
  state.chatError = error;
}

export function isChatBusy(host: { chatSending?: boolean; chatRunId?: string | null }) {
  return Boolean(host.chatSending || host.chatRunId);
}

export function hasAbortableSessionRun(host: {
  chatRunId?: string | null;
  sessionKey: string;
  sessionsResult?: SessionsListResult | null;
}): boolean {
  if (host.chatRunId) {
    return true;
  }
  return Boolean(
    host.sessionsResult?.sessions.some(
      (session) => session.key === host.sessionKey && isSessionRunActive(session),
    ),
  );
}

export function isChatStopCommand(text: string) {
  return CHAT_STOP_COMMANDS.has(normalizeLowercaseStringOrEmpty(text.trim()));
}

export type ChatAbortOptions = { preserveDraft?: boolean };

export async function abortChatRun(state: ChatAbortRunState): Promise<boolean> {
  if (!state.client || !state.connected) {
    return false;
  }
  const runId = state.chatRunId;
  try {
    await state.client.request("chat.abort", {
      sessionKey: state.sessionKey,
      ...scopedAgentParamsForSession(state, state.sessionKey),
      ...(runId ? { runId } : {}),
    });
    return true;
  } catch (err) {
    setChatError(state, formatConnectError(err));
    return false;
  }
}

export async function handleAbortChat(host: ChatAbortHost, opts?: ChatAbortOptions) {
  const activeRunId = host.chatRunId;
  const queueAbort = !host.connected && hasAbortableSessionRun(host);
  if (!host.connected && !queueAbort) {
    return;
  }
  if (!opts?.preserveDraft) {
    host.chatMessage = "";
    resetChatInputHistoryNavigation(host);
  }
  if (queueAbort) {
    host.pendingAbort = {
      runId: activeRunId,
      sessionKey: host.sessionKey,
      ...scopedAgentParamsForSession(host, host.sessionKey),
    };
    return;
  }
  await abortChatRun(host);
}

function clearTimer(timer: TimerHandle | number | null | undefined) {
  if (timer != null) {
    globalThis.clearTimeout(timer as TimerHandle);
  }
}

function canResetToolStream(host: RunLifecycleHost): host is Parameters<typeof resetToolStream>[0] {
  return (
    host.toolStreamById instanceof Map &&
    Array.isArray(host.toolStreamOrder) &&
    Array.isArray(host.chatToolMessages) &&
    Array.isArray(host.chatStreamSegments)
  );
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
    if (!reconcileStaleChatRunAfterSessionStatePublication(host)) {
      host.requestUpdate?.();
    }
  }, CHAT_RUN_STATUS_TOAST_DURATION_MS);
}

function clearRunIndicators(host: RunLifecycleHost) {
  clearTimer(host.compactionClearTimer);
  host.compactionClearTimer = null;
  if (host.compactionStatus) {
    host.compactionStatus = null;
  }
  clearTimer(host.fallbackClearTimer);
  host.fallbackClearTimer = null;
  if (host.fallbackStatus) {
    host.fallbackStatus = null;
  }
}

function sessionKeysFor(host: RunLifecycleHost, options: ReconcileOptions): Set<string> {
  const keys = new Set<string>();
  const primary = toSessionKey(options.sessionKey) ?? host.sessionKey;
  if (primary) {
    keys.add(primary);
  }
  for (const key of options.sessionKeys ?? []) {
    const normalized = toSessionKey(key);
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
  if (!options.outcome || !host.sessionsResult) {
    return;
  }
  const keys = sessionKeysFor(host, options);
  if (keys.size === 0) {
    return;
  }
  const status =
    options.sessionStatus ?? (options.outcome === "done" ? ("done" as const) : ("killed" as const));
  let changed = false;
  const sessions = host.sessionsResult.sessions.map((row) => {
    if (!keys.has(row.key)) {
      return row;
    }
    const next = {
      ...row,
      hasActiveRun: false,
      status,
      endedAt: row.endedAt ?? occurredAt,
    };
    if (status === "killed") {
      next.abortedLastRun = true;
    }
    if (typeof next.startedAt === "number" && typeof next.endedAt === "number") {
      next.runtimeMs = Math.max(0, next.endedAt - next.startedAt);
    }
    changed = true;
    return next;
  });
  if (changed) {
    host.sessionsResult = { ...host.sessionsResult, sessions };
  }
}

export function reconcileChatRunLifecycle(host: RunLifecycleHost, options: ReconcileOptions = {}) {
  const occurredAt = Date.now();
  const runId = options.runId ?? host.chatRunId ?? null;
  const sessionKey = toSessionKey(options.sessionKey) ?? host.sessionKey;

  if (options.clearIndicators ?? true) {
    clearRunIndicators(host);
  }
  if (options.clearChatStream) {
    host.chatStream = null;
    host.chatStreamStartedAt = null;
  }
  if (options.clearLocalRun) {
    host.chatRunId = null;
  }
  if (options.clearSideResultTerminalRuns) {
    host.chatSideResultTerminalRuns?.clear();
  }
  if (options.clearToolStream && canResetToolStream(host)) {
    resetToolStream(host);
  }
  if (options.outcome) {
    const status: ChatRunUiStatus = {
      phase: options.outcome,
      runId,
      sessionKey,
      occurredAt,
    };
    reconcileSessionRows(host, options, occurredAt);
    if (options.armLocalTerminalReconcile) {
      host.lastLocalTerminalReconcile = {
        sessionKey,
        runId,
        phase: options.outcome,
        sessionStatus: options.sessionStatus ?? (options.outcome === "done" ? "done" : "killed"),
      };
    }
    if (options.publishRunStatus !== false) {
      host.chatRunStatus = status;
      scheduleRunStatusClear(host, status);
    }
  } else if (options.clearRunStatus) {
    clearChatRunStatus(host);
  }
  host.requestUpdate?.();
}

function currentSessionRow(host: RunLifecycleHost) {
  return host.sessionsResult?.sessions.find((row) => row.key === host.sessionKey);
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
  if (!recent || recent.sessionKey !== host.sessionKey) {
    return false;
  }
  const row = currentSessionRow(host);
  if (!row) {
    // A disconnected or incomplete session result proves nothing about the
    // run. Retain the identity so reconnect cannot revive the completed run.
    return false;
  }
  if (!isSessionRunActive(row)) {
    // The server now reflects a non-active state, so stop suppressing.
    host.lastLocalTerminalReconcile = null;
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
    { outcome: recent.phase, sessionStatus: recent.sessionStatus, sessionKey: recent.sessionKey },
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

export function reconcileStaleChatRunAfterSessionStatePublication(host: RunLifecycleHost): boolean {
  // Both session subscriptions and direct event reconciliation can republish
  // canonical rows after the local terminal projection; guard both paths.
  const canReconcile =
    host.chatRunStatus == null &&
    host.lastLocalTerminalReconcile != null &&
    !host.chatRunId &&
    host.chatStream == null;
  return canReconcile && reconcileChatRunFromCurrentSessionRow(host, { publishRunStatus: false });
}

function isSessionRowForSelectedChat(
  host: RunLifecycleHost,
  rowKey: string,
  sessionKey: string,
): boolean {
  return uiSessionRowMatchesSelectedChat(host, rowKey, sessionKey);
}

export function reconcileChatRunFromSessionRow(
  host: RunLifecycleHost,
  row: GatewaySessionRow,
  options: { publishRunStatus?: boolean } = {},
): boolean {
  if (!isSessionRowForSelectedChat(host, row.key, host.sessionKey)) {
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
  const terminalStatus = row.status !== undefined;
  if (row.hasActiveRun !== false && !terminalStatus) {
    return false;
  }
  reconcileChatRunLifecycle(host, {
    outcome: row.status === "done" ? "done" : "interrupted",
    sessionStatus: row.status === "done" ? "done" : (row.status ?? "killed"),
    runId: host.chatRunId,
    sessionKey: host.sessionKey,
    sessionKeys: [row.key],
    clearLocalRun: true,
    clearChatStream: true,
    publishRunStatus: options.publishRunStatus,
  });
  return true;
}
