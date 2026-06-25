import {
  GatewayRequestError,
  type GatewayBrowserClient,
  type GatewayHelloOk,
} from "../../api/gateway.ts";
import type {
  AgentsListResult,
  ChatModelOverride,
  GatewaySessionRow,
  ModelCatalogEntry,
} from "../../api/types.ts";
import type { SessionsListResult } from "../../api/types.ts";
import {
  areUiSessionKeysEquivalent,
  isUiGlobalSessionKey,
  normalizeAgentId,
  parseAgentSessionKey,
  resolveUiGlobalAliasAgentId,
  resolveUiSelectedGlobalAgentId,
} from "../../lib/session-key.ts";
import { isSessionRunActive } from "../../lib/session-run-state.ts";
import {
  scopedAgentIdForSession,
  scopedAgentListParamsForSession,
  scopedAgentParamsForSession,
  visibleSessionMatches,
  type SessionCapability,
} from "../../lib/sessions/index.ts";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "../../lib/string-coerce.ts";
import { generateUUID } from "../../lib/uuid.ts";
// Control UI module implements app chat behavior.
import { isNonTerminalAgentRunStatus } from "../../../../src/shared/agent-run-status.js";
import { resetToolStream } from "../../ui/app-tool-stream.ts";
import { executeSlashCommand } from "../../ui/chat/slash-command-executor.ts";
import { parseSlashCommand } from "../../ui/chat/slash-commands.ts";
import { formatConnectError } from "../../ui/connect-error.ts";
import {
  controlUiNowMs,
  recordControlUiPerformanceEvent,
  roundedControlUiDurationMs,
  scheduleControlUiAfterPaint,
} from "../../ui/control-ui-performance.ts";
import {
  cloneChatAttachmentsMetadata,
  discardChatAttachmentDataUrls,
  getChatAttachmentDataUrl,
  releaseChatAttachmentPayloads,
} from "./attachment-payload-store.ts";
import { resolveAgentIdForSession } from "./chat-avatar.ts";
import {
  INTERRUPTED_MODEL_WAIT_ERROR,
  persistStoredChatComposerQueue,
  removeStoredChatComposerQueueItem,
} from "./composer-persistence.ts";
import {
  abortChatRun,
  appendUserChatMessage,
  loadChatHistory,
  requestChatSend,
  requestSkillWorkshopRevisionChatSend,
  sendDetachedChatMessage,
  sendSteerChatMessage,
  type ChatEventPayload,
  type ChatHistoryResult,
  type ChatMetadataResult,
  type ChatSendAck,
  type ChatState,
} from "./gateway.ts";
import {
  handleChatDraftChange,
  handleChatInputHistoryKey,
  navigateChatInputHistory,
  recordNonTranscriptInputHistory,
  resetChatInputHistoryNavigation,
  type ChatInputHistoryKeyInput,
  type ChatInputHistoryKeyResult,
  type ChatInputHistoryState,
} from "./input-history.ts";
// Control UI module implements app chat behavior.
import { setLastActiveSessionKey } from "./last-active-session.ts";
import { reconcileChatRunLifecycle } from "./run-lifecycle.ts";
import { scheduleChatScroll, resetChatScroll } from "./scroll.ts";
import { clearChatMessagesFromCache, type ChatMessageCache } from "./session-message-cache.ts";
import {
  createChatSessionsLoadOverrides,
  scopedAgentListParamsForRefreshTarget,
} from "./session-scope.ts";
import type { ChatSideResult } from "./side-result.ts";
import type {
  ChatAttachment,
  ChatQueueItem,
  ChatQueueSkillWorkshopRevision,
  ChatSessionRefreshTarget,
} from "./types.ts";

export type ChatHost = ChatInputHistoryState & {
  sessions: SessionCapability;
  client: GatewayBrowserClient | null;
  chatStream: string | null;
  connected: boolean;
  chatAttachments: ChatAttachment[];
  chatQueue: ChatQueueItem[];
  chatQueueBySession?: Record<string, ChatQueueItem[]>;
  chatMessagesBySession?: ChatMessageCache;
  chatRunId: string | null;
  chatSending: boolean;
  lastError?: string | null;
  chatError?: string | null;
  basePath: string;
  settings?: { gatewayUrl?: string | null; token?: string | null };
  password?: string | null;
  hello: GatewayHelloOk | null;
  chatAvatarUrl: string | null;
  chatAvatarSource?: string | null;
  chatAvatarStatus?: "none" | "local" | "remote" | "data" | null;
  chatAvatarReason?: string | null;
  chatSideResult?: ChatSideResult | null;
  chatSideResultTerminalRuns?: Set<string>;
  chatModelOverrides: Record<string, ChatModelOverride | null>;
  chatModelSwitchPromises?: Record<string, Promise<boolean>>;
  chatModelsLoading: boolean;
  chatModelCatalog: ModelCatalogEntry[];
  sessionsResult?: SessionsListResult | null;
  sessionsLoading: boolean;
  sessionsError?: string | null;
  sessionsShowArchived?: boolean;
  updateComplete?: Promise<unknown>;
  requestUpdate?: () => void;
  refreshSessionsAfterChat: Map<string, ChatSessionRefreshTarget>;
  pendingAbort?: { runId?: string | null; sessionKey: string; agentId?: string } | null;
  chatSubmitGuards?: Map<string, Promise<void>>;
  chatSendTimingsByRun?: Map<string, ChatSendTimingEntry>;
  assistantAgentId?: string | null;
  agentsList?: ChatAgentsListSnapshot | null;
  agentsSelectedId?: string | null;
  eventLogBuffer?: unknown[];
  eventLog?: unknown[];
  tab?: string;
  /** Callback for slash-command side effects that need app-level access. */
  onSlashAction?: (action: string) => void | Promise<void>;
  /** Selected message to reply to (right-click / keyboard shortcut). */
  chatReplyTarget?: { messageId: string; text: string; senderLabel?: string | null } | null;
};

type ChatAgentsListSnapshot = Partial<Omit<AgentsListResult, "agents">> & {
  agents?: AgentsListResult["agents"];
};

export type ChatStartupMetadataHandler = (params: {
  client: GatewayBrowserClient;
  agentId: string | null | undefined;
  metadata: ChatMetadataResult | undefined;
}) => void | Promise<void>;

function setChatError(host: ChatHost, error: string | null) {
  host.lastError = error;
  host.chatError = error;
}

type AcceptedChatSendAck = ChatSendAck & { status: "started" | "in_flight" | "ok" };
type TerminalFailureChatSendAck = ChatSendAck & { status: "timeout" | "error" };

function isAcceptedChatSendAck(ack: ChatSendAck | null): ack is AcceptedChatSendAck {
  return ack != null && (ack.status === "ok" || isNonTerminalAgentRunStatus(ack.status));
}

function isTerminalFailureChatSendAck(ack: ChatSendAck | null): ack is TerminalFailureChatSendAck {
  return ack?.status === "timeout" || ack?.status === "error";
}

function formatTerminalChatSendAckError(
  ack: TerminalFailureChatSendAck,
  context: "chat" | "detached" | "steer",
): string {
  if (ack.status === "error") {
    if (context === "steer") {
      return "Steer failed before it reached the run; try again.";
    }
    return "Chat failed before the run started; try again.";
  }
  if (context === "detached") {
    return "The active run ended before the detached message was accepted.";
  }
  if (context === "steer") {
    return "The active run ended before the steer message was accepted.";
  }
  return "The run ended before the message was accepted.";
}

export type ChatSendOptions = {
  confirmReset?: boolean;
  restoreDraft?: boolean;
  skillWorkshopRevision?: ChatQueueSkillWorkshopRevision;
};

export type ChatAbortOptions = {
  preserveDraft?: boolean;
};

export {
  handleChatDraftChange,
  handleChatInputHistoryKey,
  navigateChatInputHistory,
  resetChatInputHistoryNavigation,
};
export type { ChatInputHistoryKeyInput, ChatInputHistoryKeyResult };

export function isChatBusy(host: ChatHost) {
  return host.chatSending || Boolean(host.chatRunId);
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
  const trimmed = text.trim();
  if (!trimmed) {
    return false;
  }
  const normalized = normalizeLowercaseStringOrEmpty(trimmed);
  if (normalized === "/stop") {
    return true;
  }
  return (
    normalized === "stop" ||
    normalized === "esc" ||
    normalized === "abort" ||
    normalized === "wait" ||
    normalized === "exit"
  );
}

function isChatResetCommand(text: string) {
  const parsed = parseSlashCommand(text);
  if (!parsed || (parsed.command.key !== "new" && parsed.command.key !== "reset")) {
    return false;
  }
  if (parsed.command.key === "new") {
    return true;
  }
  if (/^soft(?:\s|$)/.test(normalizeLowercaseStringOrEmpty(parsed.args))) {
    return false;
  }
  return true;
}

function confirmChatResetCommand(text: string) {
  if (!isChatResetCommand(text)) {
    return true;
  }
  if (typeof globalThis.confirm !== "function") {
    return false;
  }
  return globalThis.confirm("Start a new session? This will reset the current chat.");
}

function isBtwCommand(text: string) {
  return /^\/(?:btw|side)(?::|\s|$)/i.test(text.trim());
}

export async function handleAbortChat(host: ChatHost, opts?: ChatAbortOptions) {
  const activeRunId = host.chatRunId;
  const clearDraft = () => {
    if (opts?.preserveDraft) {
      return;
    }
    host.chatMessage = "";
    resetChatInputHistoryNavigation(host);
  };
  // If disconnected but this session is abortable, queue the abort for when we reconnect.
  if (!host.connected && hasAbortableSessionRun(host)) {
    clearDraft();
    host.pendingAbort = {
      runId: activeRunId,
      sessionKey: host.sessionKey,
      ...scopedAgentParamsForSession(host, host.sessionKey),
    };
    return;
  }
  if (!host.connected) {
    return;
  }
  clearDraft();
  await abortChatRun(host as unknown as ChatState);
}

function enqueueChatMessage(
  host: ChatHost,
  text: string,
  attachments?: ChatAttachment[],
  refreshSessions?: boolean,
  localCommand?: { args: string; name: string },
): ChatQueueItem | null {
  const trimmed = text.trim();
  const hasAttachments = Boolean(attachments && attachments.length > 0);
  if (!trimmed && !hasAttachments) {
    return null;
  }
  const item: ChatQueueItem = {
    id: generateUUID(),
    text: trimmed,
    createdAt: Date.now(),
    attachments: hasAttachments ? cloneChatAttachmentsMetadata(attachments ?? []) : undefined,
    refreshSessions,
    localCommandArgs: localCommand?.args,
    localCommandName: localCommand?.name,
    sessionKey: host.sessionKey,
    agentId: scopedAgentIdForSession(host, host.sessionKey),
  };
  host.chatQueue = [...host.chatQueue, item];
  return item;
}

function enqueuePendingRunMessage(
  host: ChatHost,
  text: string,
  pendingRunId: string,
  attachments?: ChatAttachment[],
) {
  const trimmed = text.trim();
  const hasAttachments = Boolean(attachments && attachments.length > 0);
  if (!trimmed && !hasAttachments) {
    return;
  }
  host.chatQueue = [
    ...host.chatQueue,
    {
      id: generateUUID(),
      text: trimmed,
      createdAt: Date.now(),
      kind: "steered",
      attachments: hasAttachments ? cloneChatAttachmentsMetadata(attachments ?? []) : undefined,
      pendingRunId,
    },
  ];
}

function enqueuePendingSendMessage(
  host: ChatHost,
  text: string,
  attachments?: ChatAttachment[],
  refreshSessions?: boolean,
  submittedAtMs = controlUiNowMs(),
  sendState: ChatQueueItem["sendState"] = host.connected && host.client
    ? "sending"
    : "waiting-reconnect",
  skillWorkshopRevision?: ChatQueueSkillWorkshopRevision,
): ChatQueueItem | null {
  const trimmed = text.trim();
  const hasAttachments = Boolean(attachments && attachments.length > 0);
  if (!trimmed && !hasAttachments) {
    return null;
  }
  const pending: ChatQueueItem = {
    id: generateUUID(),
    text: trimmed,
    createdAt: Date.now(),
    attachments: hasAttachments ? attachments : undefined,
    refreshSessions,
    sendAttempts: 0,
    sendRunId: generateUUID(),
    sendState,
    sendSubmittedAtMs: submittedAtMs,
    sessionKey: host.sessionKey,
    agentId: scopedAgentIdForSession(host, host.sessionKey),
    ...(skillWorkshopRevision ? { skillWorkshopRevision } : {}),
  };
  host.chatQueue = [...host.chatQueue, pending];
  recordChatSendTiming(host, pending, "pending-visible", submittedAtMs);
  if (sendState === "waiting-model" || sendState === "waiting-reconnect") {
    recordChatSendTiming(host, pending, sendState, submittedAtMs);
  }
  schedulePendingSendPaintTiming(host, pending, submittedAtMs);
  scheduleChatScroll(host as unknown as Parameters<typeof scheduleChatScroll>[0], true, false, {
    source: "manual",
  });
  return pending;
}

function updateQueuedMessage(
  host: ChatHost,
  id: string,
  update: (item: ChatQueueItem) => ChatQueueItem,
): ChatQueueItem | null {
  return updateQueuedMessageForSession(host, host.sessionKey, id, update);
}

function readChatQueueForSession(host: ChatHost, sessionKey: string): ChatQueueItem[] {
  return sessionKey === host.sessionKey
    ? host.chatQueue
    : (host.chatQueueBySession?.[sessionKey] ?? []);
}

function writeChatQueueForSession(host: ChatHost, sessionKey: string, queue: ChatQueueItem[]) {
  if (sessionKey === host.sessionKey) {
    host.chatQueue = queue;
    return;
  }
  const queueBySession = { ...host.chatQueueBySession };
  if (queue.length > 0) {
    queueBySession[sessionKey] = queue;
  } else {
    delete queueBySession[sessionKey];
  }
  host.chatQueueBySession = queueBySession;
  host.requestUpdate?.();
}

function updateQueuedMessageForSession(
  host: ChatHost,
  sessionKey: string,
  id: string,
  update: (item: ChatQueueItem) => ChatQueueItem,
): ChatQueueItem | null {
  let nextItem: ChatQueueItem | null = null;
  const nextQueue = readChatQueueForSession(host, sessionKey).map((item) => {
    if (item.id !== id) {
      return item;
    }
    nextItem = update(item);
    return nextItem;
  });
  writeChatQueueForSession(host, sessionKey, nextQueue);
  return nextItem;
}

function persistQueuedMessagesForSession(host: ChatHost, sessionKey: string) {
  persistStoredChatComposerQueue(host, sessionKey, readChatQueueForSession(host, sessionKey));
}

function removeQueuedMessageWithoutReleasing(
  host: ChatHost,
  id: string,
  sessionKey = host.sessionKey,
): ChatQueueItem | null {
  const queue = readChatQueueForSession(host, sessionKey);
  const item = queue.find((entry) => entry.id === id) ?? null;
  writeChatQueueForSession(
    host,
    sessionKey,
    queue.filter((entry) => entry.id !== id),
  );
  return item;
}

function removeVisibleOrScopedQueuedMessageWithoutReleasing(
  host: ChatHost,
  id: string,
  sessionKey: string | undefined,
): ChatQueueItem | null {
  return (
    removeQueuedMessageWithoutReleasing(host, id) ??
    (sessionKey ? removeQueuedMessageWithoutReleasing(host, id, sessionKey) : null)
  );
}

function isRecoverableChatSendError(err: unknown, formattedError: string): boolean {
  if (err instanceof GatewayRequestError) {
    return err.retryable;
  }
  return /gateway (?:not connected|closed)|websocket|disconnected/i.test(formattedError);
}

function restoreComposerAfterFailedSend(
  host: ChatHost,
  opts: {
    previousAttachments?: ChatAttachment[];
    previousDraft?: string;
  },
) {
  if (opts.previousDraft != null && !host.chatMessage.trim()) {
    host.chatMessage = opts.previousDraft;
  }
  if (opts.previousAttachments?.length && host.chatAttachments.length === 0) {
    host.chatAttachments = opts.previousAttachments;
  }
}

function cancelPendingSendBeforeRequest(
  host: ChatHost,
  queued: ChatQueueItem,
  opts: {
    previousAttachments?: ChatAttachment[];
    previousDraft?: string;
    restoreComposer?: boolean;
  },
) {
  const removed = removeVisibleOrScopedQueuedMessageWithoutReleasing(
    host,
    queued.id,
    queued.sessionKey,
  );
  const restoreComposer = opts.restoreComposer !== false && removed != null;
  const willRestoreDraft =
    restoreComposer && opts.previousDraft != null && !host.chatMessage.trim();
  const willRestoreAttachments = Boolean(
    restoreComposer &&
    opts.previousAttachments?.length &&
    host.chatAttachments.length === 0 &&
    (willRestoreDraft || !host.chatMessage.trim()),
  );
  if (restoreComposer) {
    if (willRestoreDraft) {
      host.chatMessage = opts.previousDraft ?? "";
    }
    if (willRestoreAttachments) {
      host.chatAttachments = opts.previousAttachments ?? [];
    }
  }
  if (removed?.sessionKey) {
    removeStoredChatComposerQueueItem(host, removed.sessionKey, removed.id);
  }
  if (removed && !willRestoreAttachments) {
    releaseChatAttachmentPayloads(excludeComposerAttachments(host, removed.attachments));
  }
}

type QueuedChatSendResult = "sent" | "pending" | "failed";

type ChatSendTimingPhase =
  | "pending-visible"
  | "pending-painted"
  | "request-start"
  | "ack"
  | "server-dispatch-started"
  | "server-model-selected"
  | "server-agent-run-started"
  | "server-first-assistant-event"
  | "server-dispatch-completed"
  | "server-post-dispatch-completed"
  | "first-assistant-visible"
  | "terminal-before-delta"
  | "queued-busy"
  | "waiting-model"
  | "waiting-reconnect"
  | "failed";

type ChatSendTimingEntry = {
  runId: string;
  sessionKey?: string;
  agentId?: string;
  sendAttempts: number;
  sendState?: ChatQueueItem["sendState"];
  submittedAtMs: number;
  requestStartedAtMs?: number;
  ackAtMs?: number;
  ackStatus?: ChatSendAck["status"];
  firstAssistantVisibleRecorded?: boolean;
};

type ChatSendServerTimingPhase =
  | "dispatch-started"
  | "model-selected"
  | "agent-run-started"
  | "first-assistant-event"
  | "dispatch-completed"
  | "post-dispatch-completed";

const CHAT_SEND_SERVER_TIMING_PHASES = new Set<ChatSendServerTimingPhase>([
  "dispatch-started",
  "model-selected",
  "agent-run-started",
  "first-assistant-event",
  "dispatch-completed",
  "post-dispatch-completed",
]);
const CHAT_SEND_SLOW_FIRST_ASSISTANT_MS = 1_500;

function chatSendTimingOptions(slow: boolean) {
  return { console: slow, warn: slow, maxBufferedEventsForType: 40 };
}

function recordChatSendTiming(
  host: ChatHost,
  item: Pick<
    ChatQueueItem,
    "sendRunId" | "sessionKey" | "agentId" | "sendAttempts" | "sendState" | "sendSubmittedAtMs"
  >,
  phase: ChatSendTimingPhase,
  startedAtMs = item.sendSubmittedAtMs,
  extra: Record<string, unknown> = {},
) {
  if (startedAtMs == null) {
    return;
  }
  recordControlUiPerformanceEvent(
    host as Parameters<typeof recordControlUiPerformanceEvent>[0],
    "control-ui.chat.send",
    {
      phase,
      durationMs: roundedControlUiDurationMs(controlUiNowMs() - startedAtMs),
      runId: item.sendRunId,
      sessionKey: item.sessionKey,
      agentId: item.agentId,
      sendAttempts: item.sendAttempts ?? 0,
      sendState: item.sendState,
      ...extra,
    },
    { console: false, maxBufferedEventsForType: 40 },
  );
}

function readChatSendServerTimingPhase(value: unknown): ChatSendServerTimingPhase | null {
  return typeof value === "string" &&
    (CHAT_SEND_SERVER_TIMING_PHASES as ReadonlySet<string>).has(value)
    ? (value as ChatSendServerTimingPhase)
    : null;
}

function readChatSendTimingNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

export function recordChatSendServerTiming(host: ChatHost, payload: unknown) {
  if (!payload || typeof payload !== "object") {
    return;
  }
  const record = payload as Record<string, unknown>;
  const phase = readChatSendServerTimingPhase(record.phase);
  const runId = typeof record.runId === "string" && record.runId.trim() ? record.runId.trim() : "";
  if (!phase || !runId) {
    return;
  }
  const entry = host.chatSendTimingsByRun?.get(runId);
  const nowMs = controlUiNowMs();
  const serverAckToPhaseMs = readChatSendTimingNumber(record.ackToPhaseMs);
  const serverReceivedToPhaseMs = readChatSendTimingNumber(record.receivedToPhaseMs);
  const serverDispatchStartedToPhaseMs = readChatSendTimingNumber(record.dispatchStartedToPhaseMs);
  const serverPostDispatchMs = readChatSendTimingNumber(record.postDispatchMs);
  const durationMs =
    entry?.submittedAtMs !== undefined
      ? roundedControlUiDurationMs(nowMs - entry.submittedAtMs)
      : serverAckToPhaseMs;
  if (durationMs === undefined) {
    return;
  }
  const slow = phase === "first-assistant-event" && durationMs >= CHAT_SEND_SLOW_FIRST_ASSISTANT_MS;
  recordControlUiPerformanceEvent(
    host as Parameters<typeof recordControlUiPerformanceEvent>[0],
    "control-ui.chat.send",
    {
      phase: `server-${phase}`,
      durationMs,
      runId,
      sessionKey:
        entry?.sessionKey ??
        (typeof record.sessionKey === "string" && record.sessionKey.trim()
          ? record.sessionKey.trim()
          : undefined),
      agentId:
        entry?.agentId ??
        (typeof record.agentId === "string" && record.agentId.trim()
          ? record.agentId.trim()
          : undefined),
      sendAttempts: entry?.sendAttempts ?? 0,
      sendState: entry?.sendState,
      ackStatus: entry?.ackStatus,
      serverPhase: phase,
      ...(serverAckToPhaseMs !== undefined ? { serverAckToPhaseMs } : {}),
      ...(serverReceivedToPhaseMs !== undefined ? { serverReceivedToPhaseMs } : {}),
      ...(serverDispatchStartedToPhaseMs !== undefined ? { serverDispatchStartedToPhaseMs } : {}),
      ...(serverPostDispatchMs !== undefined ? { serverPostDispatchMs } : {}),
      ...(typeof record.provider === "string" && record.provider.trim()
        ? { provider: record.provider.trim() }
        : {}),
      ...(typeof record.model === "string" && record.model.trim()
        ? { model: record.model.trim() }
        : {}),
      ...(typeof record.agentRunId === "string" && record.agentRunId.trim()
        ? { agentRunId: record.agentRunId.trim() }
        : {}),
      ...(slow ? { slow: true } : {}),
    },
    chatSendTimingOptions(slow),
  );
}

function ensureChatSendTimingEntries(host: ChatHost): Map<string, ChatSendTimingEntry> {
  if (host.chatSendTimingsByRun) {
    return host.chatSendTimingsByRun;
  }
  const entries = new Map<string, ChatSendTimingEntry>();
  host.chatSendTimingsByRun = entries;
  return entries;
}

function registerChatSendTiming(
  host: ChatHost,
  item: Pick<
    ChatQueueItem,
    "sendRunId" | "sessionKey" | "agentId" | "sendAttempts" | "sendState" | "sendSubmittedAtMs"
  >,
  runId: string,
  requestStartedAtMs: number,
) {
  ensureChatSendTimingEntries(host).set(runId, {
    runId,
    sessionKey: item.sessionKey,
    agentId: item.agentId,
    sendAttempts: item.sendAttempts ?? 0,
    sendState: item.sendState,
    submittedAtMs: item.sendSubmittedAtMs ?? requestStartedAtMs,
    requestStartedAtMs,
  });
}

function updateChatSendAckTiming(
  host: ChatHost,
  requestedRunId: string,
  ack: ChatSendAck,
  item: Pick<
    ChatQueueItem,
    "sessionKey" | "agentId" | "sendAttempts" | "sendState" | "sendSubmittedAtMs"
  >,
  requestStartedAtMs: number,
) {
  const entries = ensureChatSendTimingEntries(host);
  const existing = entries.get(requestedRunId);
  const submittedAtMs = existing?.submittedAtMs ?? item.sendSubmittedAtMs ?? requestStartedAtMs;
  const next: ChatSendTimingEntry = {
    ...(existing ?? {
      runId: ack.runId,
      sessionKey: item.sessionKey,
      agentId: item.agentId,
      sendAttempts: item.sendAttempts ?? 0,
      sendState: item.sendState,
      submittedAtMs,
      requestStartedAtMs,
    }),
    runId: ack.runId,
    sessionKey: existing?.sessionKey ?? item.sessionKey,
    agentId: existing?.agentId ?? item.agentId,
    ackAtMs: controlUiNowMs(),
    ackStatus: ack.status,
  };
  if (ack.runId !== requestedRunId) {
    entries.delete(requestedRunId);
  }
  entries.set(ack.runId, next);
}

function chatSendAckServerTimingEventFields(ack: ChatSendAck): Record<string, number> {
  const timing = ack.serverTiming;
  return {
    ...(typeof timing?.receivedToAckMs === "number"
      ? { serverReceivedToAckMs: timing.receivedToAckMs }
      : {}),
    ...(typeof timing?.loadSessionMs === "number"
      ? { serverLoadSessionMs: timing.loadSessionMs }
      : {}),
    ...(typeof timing?.prepareAttachmentsMs === "number"
      ? { serverPrepareAttachmentsMs: timing.prepareAttachmentsMs }
      : {}),
  };
}

function chatEventHasVisibleTerminalPayload(payload: ChatEventPayload): boolean {
  if (payload.state === "error" && payload.errorMessage?.trim()) {
    return true;
  }
  return Boolean(payload.message && typeof payload.message === "object");
}

function resolveFirstAssistantTimingPhase(
  host: ChatHost,
  payload: ChatEventPayload,
  entry: ChatSendTimingEntry,
): Extract<ChatSendTimingPhase, "first-assistant-visible" | "terminal-before-delta"> | null {
  if (entry.firstAssistantVisibleRecorded) {
    return null;
  }
  if (payload.state === "delta") {
    return typeof host.chatStream === "string" && host.chatStream.trim()
      ? "first-assistant-visible"
      : null;
  }
  if (payload.state === "final" || payload.state === "aborted" || payload.state === "error") {
    return chatEventHasVisibleTerminalPayload(payload) ? "terminal-before-delta" : null;
  }
  return null;
}

export function recordFirstAssistantChatTiming(
  host: ChatHost,
  payload: ChatEventPayload | undefined,
  handledState: ChatEventPayload["state"] | null,
) {
  if (!payload || !handledState || typeof payload.runId !== "string") {
    return;
  }
  const runId = payload.runId.trim();
  const entry = runId ? host.chatSendTimingsByRun?.get(runId) : undefined;
  if (!entry) {
    return;
  }
  const phase = resolveFirstAssistantTimingPhase(host, payload, entry);
  if (!phase) {
    if (payload.state === "final" || payload.state === "aborted" || payload.state === "error") {
      host.chatSendTimingsByRun?.delete(runId);
    }
    return;
  }

  const eventAtMs = controlUiNowMs();
  entry.firstAssistantVisibleRecorded = true;
  scheduleControlUiAfterPaint(host, () => {
    const paintedAtMs = controlUiNowMs();
    const durationMs = roundedControlUiDurationMs(paintedAtMs - entry.submittedAtMs);
    const slow = durationMs >= CHAT_SEND_SLOW_FIRST_ASSISTANT_MS;
    recordControlUiPerformanceEvent(
      host as Parameters<typeof recordControlUiPerformanceEvent>[0],
      "control-ui.chat.send",
      {
        phase,
        durationMs,
        runId,
        sessionKey: entry.sessionKey ?? payload.sessionKey,
        agentId: entry.agentId ?? payload.agentId,
        sendAttempts: entry.sendAttempts,
        sendState: entry.sendState,
        ackStatus: entry.ackStatus,
        eventState: payload.state,
        firstAssistantPaintMs: roundedControlUiDurationMs(paintedAtMs - eventAtMs),
        ...(entry.requestStartedAtMs != null
          ? {
              requestToFirstAssistantEventMs: roundedControlUiDurationMs(
                eventAtMs - entry.requestStartedAtMs,
              ),
            }
          : {}),
        ...(entry.ackAtMs != null
          ? {
              ackToFirstAssistantEventMs: roundedControlUiDurationMs(eventAtMs - entry.ackAtMs),
            }
          : {}),
        ...(slow ? { slow: true } : {}),
      },
      chatSendTimingOptions(slow),
    );
    if (phase === "terminal-before-delta") {
      host.chatSendTimingsByRun?.delete(runId);
    }
  });
}

function shouldRecordPendingSendPaint(item: ChatQueueItem): boolean {
  return (
    typeof item.sendSubmittedAtMs === "number" &&
    (item.sendState === "waiting-model" ||
      item.sendState === "sending" ||
      item.sendState === "waiting-reconnect")
  );
}

function schedulePendingSendPaintTiming(
  host: ChatHost,
  item: ChatQueueItem,
  startedAtMs = item.sendSubmittedAtMs,
) {
  const sessionKey = item.sessionKey ?? host.sessionKey;
  const sendRunId = item.sendRunId;
  if (!sendRunId || startedAtMs == null) {
    return;
  }
  scheduleControlUiAfterPaint(host as Parameters<typeof scheduleControlUiAfterPaint>[0], () => {
    if (!visibleSessionMatches(host, sessionKey, item.agentId)) {
      return;
    }
    const queued = readChatQueueForSession(host, sessionKey).find(
      (entry) => entry.id === item.id && entry.sendRunId === sendRunId,
    );
    if (!queued || !shouldRecordPendingSendPaint(queued)) {
      return;
    }
    recordChatSendTiming(host, queued, "pending-painted", startedAtMs);
  });
}

function ensureQueuedSendState(
  host: ChatHost,
  item: ChatQueueItem,
  fallbackSessionKey = host.sessionKey,
): ChatQueueItem {
  if (item.sendRunId && item.sendState) {
    return item;
  }
  const sessionKey = item.sessionKey ?? fallbackSessionKey;
  const agentId = item.agentId ?? scopedAgentIdForSession(host, sessionKey);
  const prepared: ChatQueueItem = {
    ...item,
    sendAttempts: item.sendAttempts ?? 0,
    sendRunId: item.sendRunId ?? generateUUID(),
    sendState: host.connected && host.client ? "sending" : "waiting-reconnect",
    sessionKey,
    agentId,
  };
  updateQueuedMessageForSession(host, sessionKey, item.id, () => prepared);
  return prepared;
}

async function sendQueuedChatMessage(
  host: ChatHost,
  id: string,
  opts?: {
    previousAttachments?: ChatAttachment[];
    previousDraft?: string;
  },
  queuedSessionKey = host.sessionKey,
): Promise<QueuedChatSendResult> {
  const queued = readChatQueueForSession(host, queuedSessionKey).find((item) => item.id === id);
  if (!queued || queued.pendingRunId || queued.localCommandName) {
    return "failed";
  }
  const prepared = ensureQueuedSendState(host, queued, queuedSessionKey);
  const message = prepared.text.trim();
  const attachments = prepared.attachments ?? [];
  const hasAttachments = attachments.length > 0;
  if (!message && !hasAttachments) {
    removeQueuedMessageWithoutReleasing(host, id, prepared.sessionKey ?? host.sessionKey);
    return "sent";
  }
  if (prepared.skillWorkshopRevision && hasAttachments) {
    updateQueuedMessageForSession(host, prepared.sessionKey ?? host.sessionKey, id, (item) => ({
      ...item,
      sendError: "Skill Workshop revision requests do not support attachments.",
      sendState: "failed",
    }));
    return "failed";
  }
  const sessionKey = prepared.sessionKey ?? host.sessionKey;
  if (!host.connected || !host.client) {
    updateQueuedMessageForSession(host, sessionKey, id, (item) => ({
      ...item,
      sendState: "waiting-reconnect",
      sendError: undefined,
    }));
    return "pending";
  }

  const runId = prepared.sendRunId ?? generateUUID();
  const startedAt = Date.now();
  const requestStartedAtMs = controlUiNowMs();
  const sendingItem =
    updateQueuedMessageForSession(host, sessionKey, id, (item) => ({
      ...item,
      sendAttempts: (item.sendAttempts ?? 0) + 1,
      sendError: undefined,
      sendRunId: runId,
      sendState: "sending",
      sendRequestStartedAtMs: requestStartedAtMs,
      sessionKey,
      agentId: prepared.agentId,
    })) ?? prepared;
  registerChatSendTiming(host, sendingItem, runId, requestStartedAtMs);
  recordChatSendTiming(host, sendingItem, "request-start", sendingItem.sendSubmittedAtMs);
  host.chatSending = true;
  const isVisibleSession = () => visibleSessionMatches(host, sessionKey, prepared.agentId);
  if (isVisibleSession()) {
    setChatError(host, null);
    reconcileChatRunLifecycle(host as unknown as Parameters<typeof reconcileChatRunLifecycle>[0], {
      clearRunStatus: true,
    });
  }

  try {
    const ack = prepared.skillWorkshopRevision
      ? await requestSkillWorkshopRevisionChatSend(host as unknown as ChatState, {
          proposalId: prepared.skillWorkshopRevision.proposalId,
          ...(prepared.skillWorkshopRevision.agentId
            ? { agentId: prepared.skillWorkshopRevision.agentId }
            : {}),
          ...(prepared.agentId ? { targetAgentId: prepared.agentId } : {}),
          instructions: message,
          runId,
          sessionKey,
        })
      : await requestChatSend(host as unknown as ChatState, {
          message,
          attachments: hasAttachments ? attachments : undefined,
          runId,
          sessionKey,
          agentId: prepared.agentId,
        });
    updateChatSendAckTiming(host, runId, ack, sendingItem, requestStartedAtMs);
    recordChatSendTiming(host, sendingItem, "ack", sendingItem.sendSubmittedAtMs, {
      ackStatus: ack.status,
      requestDurationMs: roundedControlUiDurationMs(controlUiNowMs() - requestStartedAtMs),
      ...chatSendAckServerTimingEventFields(ack),
    });
    if (isTerminalFailureChatSendAck(ack)) {
      const error = formatTerminalChatSendAckError(ack, "chat");
      updateQueuedMessageForSession(host, sessionKey, id, (item) => ({
        ...item,
        sendError: error,
        sendState: "failed",
      }));
      if (isVisibleSession()) {
        reconcileChatRunLifecycle(
          host as unknown as Parameters<typeof reconcileChatRunLifecycle>[0],
          {
            outcome: "interrupted",
            sessionStatus: ack.status === "error" ? "failed" : "killed",
            runId: ack.runId,
            sessionKey,
            clearLocalRun: true,
            clearChatStream: true,
            clearToolStream: true,
            clearSideResultTerminalRuns: true,
            publishRunStatus: false,
            armLocalTerminalReconcile: ack.runId === runId,
          },
        );
        setChatError(host, error);
        restoreComposerAfterFailedSend(host, opts ?? {});
      }
      recordChatSendTiming(host, sendingItem, "failed", sendingItem.sendSubmittedAtMs, {
        error,
        ackStatus: ack.status,
      });
      return "failed";
    }
    removeQueuedMessageWithoutReleasing(host, id, sessionKey);
    if (isVisibleSession()) {
      appendUserChatMessage(
        host as unknown as ChatState,
        message,
        hasAttachments ? attachments : undefined,
        startedAt,
      );
      if (ack.status === "ok") {
        reconcileChatRunLifecycle(
          host as unknown as Parameters<typeof reconcileChatRunLifecycle>[0],
          {
            outcome: "done",
            sessionStatus: "done",
            runId: ack.runId,
            sessionKey,
            clearLocalRun: true,
            clearChatStream: true,
            clearToolStream: true,
            clearSideResultTerminalRuns: true,
            publishRunStatus: false,
            armLocalTerminalReconcile: true,
          },
        );
        void loadChatHistory(host as unknown as ChatState);
      } else if (isNonTerminalAgentRunStatus(ack.status)) {
        const hasAlreadyAdoptedRunStream =
          host.chatRunId === ack.runId && typeof host.chatStream === "string";
        host.chatRunId = ack.runId;
        // Gateway can deliver the first delta before the chat.send ACK resolves.
        // Preserve that adopted stream; resetting here makes first replies vanish
        // until a later delta or final event arrives.
        if (!hasAlreadyAdoptedRunStream) {
          host.chatStream = "";
          (host as ChatHost & { chatStreamStartedAt?: number | null }).chatStreamStartedAt =
            startedAt;
        }
      } else {
        reconcileChatRunLifecycle(
          host as unknown as Parameters<typeof reconcileChatRunLifecycle>[0],
          {
            outcome: "interrupted",
            sessionStatus: ack.status === "error" ? "failed" : "killed",
            runId: ack.runId,
            sessionKey,
            clearLocalRun: true,
            clearChatStream: true,
            clearToolStream: true,
            clearSideResultTerminalRuns: true,
            publishRunStatus: false,
            armLocalTerminalReconcile: ack.runId === runId,
          },
        );
      }
    }
    if (prepared.refreshSessions) {
      const refreshTarget = {
        sessionKey,
        agentId: prepared.agentId,
      };
      if (ack.status === "ok") {
        void host.sessions.refresh({
          ...createChatSessionsLoadOverrides(host),
          ...scopedAgentListParamsForRefreshTarget(host, refreshTarget),
          force: true,
        });
      } else if (isNonTerminalAgentRunStatus(ack.status)) {
        host.refreshSessionsAfterChat.set(ack.runId, refreshTarget);
      }
    }
    discardChatAttachmentDataUrls(excludeComposerAttachments(host, attachments));
    return "sent";
  } catch (err) {
    const error = formatConnectError(err);
    if (isRecoverableChatSendError(err, error)) {
      updateQueuedMessageForSession(host, sessionKey, id, (item) => ({
        ...item,
        sendError: error,
        sendState: "waiting-reconnect",
      }));
      if (isVisibleSession()) {
        setChatError(host, "Message will send when the Gateway reconnects.");
      }
      recordChatSendTiming(host, prepared, "waiting-reconnect", prepared.sendSubmittedAtMs, {
        error,
      });
      return "pending";
    }
    updateQueuedMessageForSession(host, sessionKey, id, (item) => ({
      ...item,
      sendError: error,
      sendState: "failed",
    }));
    if (isVisibleSession()) {
      setChatError(host, error);
      restoreComposerAfterFailedSend(host, opts ?? {});
    }
    recordChatSendTiming(host, prepared, "failed", prepared.sendSubmittedAtMs, { error });
    return "failed";
  } finally {
    host.chatSending = false;
  }
}

async function sendChatMessageNow(
  host: ChatHost,
  message: string,
  opts?: {
    queueItemId?: string;
    previousDraft?: string;
    restoreDraft?: boolean;
    attachments?: ChatAttachment[];
    previousAttachments?: ChatAttachment[];
    restoreAttachments?: boolean;
    refreshSessions?: boolean;
    submittedAtMs?: number;
  },
) {
  resetToolStream(host as unknown as Parameters<typeof resetToolStream>[0]);
  // Reset scroll state before sending to ensure auto-scroll works for the response
  resetChatScroll(host as unknown as Parameters<typeof resetChatScroll>[0]);
  const queued =
    opts?.queueItemId != null
      ? (host.chatQueue.find((item) => item.id === opts.queueItemId) ?? null)
      : enqueuePendingSendMessage(
          host,
          message,
          opts?.attachments,
          opts?.refreshSessions,
          opts?.submittedAtMs,
        );
  if (!queued) {
    return false;
  }
  const queuedSessionKey = queued.sessionKey ?? host.sessionKey;
  const result = await sendQueuedChatMessage(host, queued.id, {
    previousDraft: opts?.previousDraft,
    previousAttachments: opts?.previousAttachments,
  });
  const ok = result === "sent";
  if (ok && host.sessionKey === queuedSessionKey) {
    setLastActiveSessionKey(
      host as unknown as Parameters<typeof setLastActiveSessionKey>[0],
      queuedSessionKey,
    );
    resetChatInputHistoryNavigation(host);
  }
  if (
    ok &&
    host.sessionKey === queuedSessionKey &&
    opts?.restoreDraft &&
    opts.previousDraft?.trim()
  ) {
    host.chatMessage = opts.previousDraft;
  }
  if (
    ok &&
    host.sessionKey === queuedSessionKey &&
    opts?.restoreAttachments &&
    opts.previousAttachments?.length
  ) {
    host.chatAttachments = opts.previousAttachments;
  }
  // Force scroll after sending to ensure viewport is at bottom for incoming stream
  if (host.sessionKey === queuedSessionKey) {
    scheduleChatScroll(host as unknown as Parameters<typeof scheduleChatScroll>[0], true);
  }
  if (ok && host.sessionKey === queuedSessionKey && !host.chatRunId) {
    void flushChatQueue(host);
  }
  return ok;
}

function attachmentSubmitSignature(attachment: ChatAttachment): string {
  const dataUrl = getChatAttachmentDataUrl(attachment);
  return JSON.stringify([
    attachment.id,
    attachment.mimeType,
    attachment.fileName ?? "",
    attachment.sizeBytes ?? 0,
    dataUrl?.length ?? 0,
    dataUrl?.slice(0, 64) ?? "",
  ]);
}

function chatSubmitKey(
  host: ChatHost,
  kind: "btw" | "message",
  message: string,
  attachments: ChatAttachment[],
  skillWorkshopRevision?: ChatQueueSkillWorkshopRevision,
): string {
  return JSON.stringify([
    kind,
    host.sessionKey,
    message.trim(),
    skillWorkshopRevision?.proposalId ?? "",
    skillWorkshopRevision?.agentId ?? "",
    attachments.map(attachmentSubmitSignature),
  ]);
}

async function withChatSubmitGuard<T>(
  host: ChatHost,
  key: string,
  run: () => Promise<T>,
): Promise<T | undefined> {
  const guards = (host.chatSubmitGuards ??= new Map<string, Promise<void>>());
  if (guards.has(key)) {
    return undefined;
  }
  let releaseGuard!: () => void;
  const guard = new Promise<void>((resolve) => {
    releaseGuard = resolve;
  });
  guards.set(key, guard);
  try {
    return await run();
  } finally {
    releaseGuard();
    if (guards.get(key) === guard) {
      guards.delete(key);
    }
  }
}

function waitForPendingChatModelSwitch(
  host: ChatHost,
  sessionKey: string,
): Promise<boolean> | true {
  const pending = host.chatModelSwitchPromises?.[sessionKey];
  if (!pending) {
    return true;
  }
  return pending;
}

function clearSubmittedComposerState(
  host: ChatHost,
  submittedDraft: string,
  submittedAttachments: ChatAttachment[],
): {
  previousAttachments?: ChatAttachment[];
  previousDraft?: string;
} {
  const attachmentsUnchanged =
    host.chatAttachments.length === submittedAttachments.length &&
    host.chatAttachments.every(
      (attachment, index) =>
        attachmentSubmitSignature(attachment) ===
        attachmentSubmitSignature(submittedAttachments[index]),
    );
  const clearedDraft = host.chatMessage === submittedDraft && attachmentsUnchanged;
  const clearedAttachments = clearedDraft;
  if (clearedDraft) {
    host.chatMessage = "";
  }
  if (clearedAttachments) {
    host.chatAttachments = [];
  }
  if (clearedDraft || clearedAttachments) {
    resetChatInputHistoryNavigation(host);
  }
  return {
    previousAttachments: clearedAttachments ? submittedAttachments : undefined,
    previousDraft: clearedDraft ? submittedDraft : undefined,
  };
}

function excludeComposerAttachments(
  host: ChatHost,
  attachments: readonly ChatAttachment[] | undefined,
): ChatAttachment[] | undefined {
  if (!attachments?.length) {
    return attachments ? [] : undefined;
  }
  const retainedIds = new Set((host.chatAttachments ?? []).map((attachment) => attachment.id));
  return attachments.filter((attachment) => !retainedIds.has(attachment.id));
}

function snapshotChatAttachments(attachments: readonly ChatAttachment[]): ChatAttachment[] {
  return attachments.map((attachment) => {
    const dataUrl = getChatAttachmentDataUrl(attachment);
    return {
      ...attachment,
      ...(dataUrl ? { dataUrl } : {}),
    };
  });
}

async function sendDetachedBtwMessage(
  host: ChatHost,
  message: string,
  opts?: {
    previousDraft?: string;
    attachments?: ChatAttachment[];
    previousAttachments?: ChatAttachment[];
  },
) {
  const ack = await sendDetachedChatMessage(
    host as unknown as ChatState,
    message,
    opts?.attachments,
  );
  const ok = isAcceptedChatSendAck(ack);
  if (!ok && opts?.previousDraft != null) {
    host.chatMessage = opts.previousDraft;
  }
  if (!ok && opts?.previousAttachments) {
    host.chatAttachments = opts.previousAttachments;
  }
  if (isTerminalFailureChatSendAck(ack)) {
    setChatError(host, formatTerminalChatSendAckError(ack, "detached"));
  }
  if (ok) {
    setLastActiveSessionKey(
      host as unknown as Parameters<typeof setLastActiveSessionKey>[0],
      host.sessionKey,
    );
    releaseChatAttachmentPayloads(excludeComposerAttachments(host, opts?.attachments));
  }
  return ok;
}

export async function steerQueuedChatMessage(host: ChatHost, id: string) {
  if (!host.connected || !host.chatRunId) {
    return;
  }
  const activeRunId = host.chatRunId;
  const item = host.chatQueue.find(
    (entry) => entry.id === id && !entry.pendingRunId && !entry.localCommandName,
  );
  if (!item) {
    return;
  }
  const message = item.text.trim();
  const attachments = item.attachments ?? [];
  const hasAttachments = attachments.length > 0;
  if (!message && !hasAttachments) {
    return;
  }

  host.chatQueue = host.chatQueue.map((entry) =>
    entry.id === id ? { ...entry, kind: "steered", pendingRunId: activeRunId } : entry,
  );
  const ack = await sendSteerChatMessage(
    host as unknown as ChatState,
    message,
    hasAttachments ? attachments : undefined,
  );
  if (!ack || isTerminalFailureChatSendAck(ack)) {
    host.chatQueue = host.chatQueue.map((entry) => (entry.id === id ? item : entry));
    if (isTerminalFailureChatSendAck(ack)) {
      setChatError(host, formatTerminalChatSendAckError(ack, "steer"));
    }
    return;
  }
  if (ack.status === "ok") {
    removeQueuedMessageWithoutReleasing(host, id, host.sessionKey);
  }
  releaseChatAttachmentPayloads(attachments);
  setLastActiveSessionKey(
    host as unknown as Parameters<typeof setLastActiveSessionKey>[0],
    host.sessionKey,
  );
  scheduleChatScroll(host as unknown as Parameters<typeof scheduleChatScroll>[0]);
}

async function flushChatQueue(host: ChatHost) {
  if (!host.connected || isChatBusy(host)) {
    return;
  }
  const nextIndex = host.chatQueue.findIndex(
    (item) =>
      !item.pendingRunId &&
      item.sendState !== "sending" &&
      item.sendState !== "waiting-model" &&
      item.sendState !== "failed" &&
      (item.sessionKey == null || item.sessionKey === host.sessionKey),
  );
  if (nextIndex < 0) {
    return;
  }
  const next = host.chatQueue[nextIndex];
  let ok = false;
  try {
    if (next.localCommandName) {
      host.chatQueue = host.chatQueue.filter((_, index) => index !== nextIndex);
      await dispatchSlashCommand(host, next.localCommandName, next.localCommandArgs ?? "");
      ok = true;
    } else {
      ok = await sendChatMessageNow(host, next.text, {
        queueItemId: next.id,
        attachments: next.attachments,
        refreshSessions: next.refreshSessions,
      });
    }
  } catch (err) {
    setChatError(host, String(err));
  }
  if (!ok && next.localCommandName) {
    host.chatQueue = [next, ...host.chatQueue];
  } else if (ok && host.chatQueue.length > 0) {
    // Continue draining — local commands don't block on server response
    void flushChatQueue(host);
  }
}

function isSelectedSessionKnownIdle(
  sessionsResult: SessionsListResult,
  sessionKey: string,
): boolean {
  const row = sessionsResult.sessions.find((session) =>
    areUiSessionKeysEquivalent(session.key, sessionKey),
  );
  return Boolean(row && !isSessionRunActive(row));
}

function isHistorySessionInfoForRequestedSession(
  host: ChatHost,
  historySessionKey: string | undefined,
  requestedSessionKey: string,
): boolean {
  if (areUiSessionKeysEquivalent(historySessionKey, requestedSessionKey)) {
    return true;
  }
  return Boolean(
    historySessionKey &&
    isUiGlobalSessionKey(historySessionKey) &&
    resolveUiGlobalAliasAgentId(host, requestedSessionKey),
  );
}

function findSelectedSessionRow(
  host: ChatHost,
  sessionsResult: SessionsListResult | null | undefined,
  sessionKey: string,
  historySessionKey: string | undefined,
): GatewaySessionRow | undefined {
  const requestedGlobalAgentId =
    historySessionKey && isUiGlobalSessionKey(historySessionKey)
      ? resolveUiGlobalAliasAgentId(host, sessionKey)
      : undefined;
  return sessionsResult?.sessions.find((session) => {
    if (areUiSessionKeysEquivalent(session.key, sessionKey)) {
      return true;
    }
    return (
      requestedGlobalAgentId != null &&
      resolveUiGlobalAliasAgentId(host, session.key) === requestedGlobalAgentId
    );
  });
}

function historyIdleProofIsStaleForSelectedRow(
  historySessionInfo: GatewaySessionRow,
  selectedRow: GatewaySessionRow | undefined,
): boolean {
  if (!selectedRow || !isSessionRunActive(selectedRow) || isSessionRunActive(historySessionInfo)) {
    return false;
  }
  const historyUpdatedAt =
    typeof historySessionInfo.updatedAt === "number" ? historySessionInfo.updatedAt : null;
  if (historyUpdatedAt == null) {
    return true;
  }
  const selectedUpdatedAt = typeof selectedRow.updatedAt === "number" ? selectedRow.updatedAt : 0;
  if (selectedUpdatedAt >= historyUpdatedAt) {
    return true;
  }
  const selectedStartedAt = typeof selectedRow.startedAt === "number" ? selectedRow.startedAt : 0;
  return selectedStartedAt >= historyUpdatedAt;
}

export function flushChatQueueAfterIdleSessionReconciliation(
  host: ChatHost,
  sessionKey: string,
  historyRefresh: Promise<ChatHistoryResult | undefined>,
  sessionsRefresh: Promise<unknown>,
  previousSessionsResult: SessionsListResult | null | undefined,
) {
  if (host.chatQueue.length === 0) {
    return;
  }
  void Promise.allSettled([historyRefresh, sessionsRefresh]).then((results) => {
    const historyRefreshSettled = results[0];
    const sessionsRefreshSettled = results[1];
    const freshSessionsResult = host.sessionsResult;
    const historySessionInfo =
      historyRefreshSettled.status === "fulfilled"
        ? historyRefreshSettled.value?.sessionInfo
        : null;
    const selectedSessionRow = findSelectedSessionRow(
      host,
      freshSessionsResult,
      sessionKey,
      historySessionInfo?.key,
    );
    const historySessionKnownIdle = Boolean(
      historySessionInfo &&
      isHistorySessionInfoForRequestedSession(host, historySessionInfo.key, sessionKey) &&
      !isSessionRunActive(historySessionInfo) &&
      !historyIdleProofIsStaleForSelectedRow(historySessionInfo, selectedSessionRow),
    );
    const sessionsResultKnownIdle = freshSessionsResult
      ? isSelectedSessionKnownIdle(freshSessionsResult, sessionKey)
      : false;
    if (
      sessionsRefreshSettled.status !== "fulfilled" ||
      host.chatQueue.length === 0 ||
      !areUiSessionKeysEquivalent(host.sessionKey, sessionKey) ||
      (!freshSessionsResult && !historySessionKnownIdle) ||
      (freshSessionsResult === previousSessionsResult && !historySessionKnownIdle) ||
      (host.sessionsError && !historySessionKnownIdle) ||
      !(historySessionKnownIdle || sessionsResultKnownIdle)
    ) {
      return;
    }
    void flushChatQueue(host);
  });
}

export function removeQueuedMessage(host: ChatHost, id: string) {
  const removed = host.chatQueue.filter((item) => item.id === id);
  host.chatQueue = host.chatQueue.filter((item) => item.id !== id);
  for (const item of removed) {
    releaseChatAttachmentPayloads(excludeComposerAttachments(host, item.attachments));
  }
}

export function clearPendingQueueItemsForRun(host: ChatHost, runId: string | undefined) {
  if (!runId) {
    return;
  }
  const removed = host.chatQueue.filter((item) => item.pendingRunId === runId);
  host.chatQueue = host.chatQueue.filter((item) => item.pendingRunId !== runId);
  for (const item of removed) {
    releaseChatAttachmentPayloads(excludeComposerAttachments(host, item.attachments));
  }
}

type ChatQueueStoreHost = {
  chatQueue: ChatQueueItem[];
  chatQueueBySession?: Record<string, ChatQueueItem[]>;
};

function chatQueueCollections(host: ChatQueueStoreHost): ChatQueueItem[][] {
  return [host.chatQueue, ...Object.values(host.chatQueueBySession ?? {})];
}

export function hasReconnectableQueuedChatSends(host: ChatQueueStoreHost): boolean {
  return chatQueueCollections(host).some((queue) =>
    queue.some((item) => item.sendRunId && item.sendState === "waiting-reconnect"),
  );
}

export function markQueuedChatSendsWaitingForReconnect(host: ChatQueueStoreHost) {
  const markQueue = (queue: ChatQueueItem[]): { changed: boolean; queue: ChatQueueItem[] } => {
    let changed = false;
    const nextQueue = queue.map((item) => {
      if (!item.sendRunId || item.sendState !== "sending") {
        return item;
      }
      changed = true;
      return {
        ...item,
        sendState: "waiting-reconnect" as const,
      };
    });
    return { changed, queue: nextQueue };
  };

  const active = markQueue(host.chatQueue);
  if (active.changed) {
    host.chatQueue = active.queue;
  }

  let changed = false;
  const queueBySession = { ...host.chatQueueBySession };
  for (const [sessionKey, queue] of Object.entries(queueBySession)) {
    const next = markQueue(queue);
    if (next.changed) {
      changed = true;
      queueBySession[sessionKey] = next.queue;
    }
  }
  if (changed) {
    host.chatQueueBySession = queueBySession;
  }
}

export async function retryReconnectableQueuedChatSends(host: ChatHost) {
  if (!host.connected || !host.client || host.chatSending) {
    return;
  }
  const sessionKeys = [
    host.sessionKey,
    ...Object.keys(host.chatQueueBySession ?? {}).filter(
      (sessionKey) => sessionKey !== host.sessionKey,
    ),
  ];
  for (const sessionKey of sessionKeys) {
    const item = readChatQueueForSession(host, sessionKey).find(
      (entry) =>
        entry.sendRunId &&
        entry.sendState === "waiting-reconnect" &&
        !entry.pendingRunId &&
        !entry.localCommandName,
    );
    if (!item) {
      continue;
    }
    await sendQueuedChatMessage(host, item.id, undefined, sessionKey);
    if (host.chatRunId) {
      return;
    }
  }
  if (!host.chatRunId) {
    void flushChatQueue(host);
  }
}

export async function retryQueuedChatMessage(host: ChatHost, id: string) {
  const item = host.chatQueue.find((entry) => entry.id === id);
  if (
    !item ||
    item.localCommandName ||
    item.pendingRunId ||
    item.sendState === "sending" ||
    item.sendState === "waiting-model"
  ) {
    return;
  }
  updateQueuedMessage(host, id, (entry) => ({
    ...entry,
    sendError: undefined,
    sendState: host.connected && host.client ? "sending" : "waiting-reconnect",
  }));
  await sendQueuedChatMessage(host, id);
  if (!host.chatRunId) {
    void flushChatQueue(host);
  }
}

export async function handleSendChat(
  host: ChatHost,
  messageOverride?: string,
  opts?: ChatSendOptions,
) {
  const previousDraft = host.chatMessage;
  const message = (messageOverride ?? host.chatMessage).trim();
  const submittedAtMs = controlUiNowMs();
  const submittedSessionKey = host.sessionKey;
  const attachments = host.chatAttachments ?? [];
  const attachmentsToSend = messageOverride == null ? snapshotChatAttachments(attachments) : [];
  const hasAttachments = attachmentsToSend.length > 0;
  const skillWorkshopRevision = opts?.skillWorkshopRevision;
  const shouldInterpretChatCommands = !skillWorkshopRevision;

  if (!message && !hasAttachments) {
    return;
  }

  if (messageOverride != null && opts?.confirmReset && !confirmChatResetCommand(message)) {
    return;
  }

  if (shouldInterpretChatCommands) {
    if (isChatStopCommand(message)) {
      if (messageOverride == null) {
        recordNonTranscriptInputHistory(host, message);
      }
      await handleAbortChat(host);
      return;
    }

    if (isBtwCommand(message)) {
      const submitKey = chatSubmitKey(host, "btw", message, attachmentsToSend);
      await withChatSubmitGuard(host, submitKey, async () => {
        const modelSwitchReady = waitForPendingChatModelSwitch(host, submittedSessionKey);
        if (modelSwitchReady !== true && !(await modelSwitchReady)) {
          return;
        }
        if (host.sessionKey !== submittedSessionKey) {
          return;
        }
        const cleared =
          messageOverride == null
            ? clearSubmittedComposerState(host, previousDraft, attachmentsToSend)
            : {};
        if (messageOverride == null) {
          recordNonTranscriptInputHistory(host, message);
        }
        await sendDetachedBtwMessage(host, message, {
          previousDraft: cleared.previousDraft,
          attachments: hasAttachments ? attachmentsToSend : undefined,
          previousAttachments: cleared.previousAttachments,
        });
      });
      return;
    }

    // Intercept local slash commands (/status, /model, /compact, etc.)
    const parsed = parseSlashCommand(message);
    if (parsed?.command.executeLocal) {
      if (isChatBusy(host) && shouldQueueLocalSlashCommand(parsed.command.key)) {
        if (messageOverride == null) {
          recordNonTranscriptInputHistory(host, message);
          host.chatMessage = "";
          host.chatAttachments = [];
          resetChatInputHistoryNavigation(host);
        }
        enqueueChatMessage(host, message, undefined, isChatResetCommand(message), {
          args: parsed.args,
          name: parsed.command.key,
        });
        return;
      }
      const prevDraft = messageOverride == null ? previousDraft : undefined;
      if (messageOverride == null) {
        recordNonTranscriptInputHistory(host, message);
        host.chatMessage = "";
        host.chatAttachments = [];
        resetChatInputHistoryNavigation(host);
      }
      await dispatchSlashCommand(host, parsed.command.key, parsed.args, {
        previousDraft: prevDraft,
        restoreDraft: Boolean(messageOverride && opts?.restoreDraft),
      });
      return;
    }
  }

  const replyTarget = host.chatReplyTarget;
  const effectiveMessage = replyTarget ? prependReplyQuote(message, replyTarget) : message;

  const refreshSessions = shouldInterpretChatCommands && isChatResetCommand(message);
  const submitKey = chatSubmitKey(
    host,
    "message",
    effectiveMessage,
    attachmentsToSend,
    skillWorkshopRevision,
  );
  await withChatSubmitGuard(host, submitKey, async () => {
    if (host.sessionKey !== submittedSessionKey) {
      return;
    }
    const cleared =
      messageOverride == null
        ? clearSubmittedComposerState(host, previousDraft, attachmentsToSend)
        : {};
    if (messageOverride == null) {
      recordNonTranscriptInputHistory(host, message);
    }

    const modelSwitchReady = waitForPendingChatModelSwitch(host, submittedSessionKey);
    const waitingForModel = modelSwitchReady !== true;
    const queued = enqueuePendingSendMessage(
      host,
      effectiveMessage,
      hasAttachments ? attachmentsToSend : undefined,
      refreshSessions,
      submittedAtMs,
      waitingForModel ? "waiting-model" : undefined,
      skillWorkshopRevision,
    );
    if (!queued) {
      return;
    }
    if (modelSwitchReady !== true && !(await modelSwitchReady)) {
      if (host.sessionKey === submittedSessionKey) {
        cancelPendingSendBeforeRequest(host, queued, {
          previousDraft: cleared.previousDraft,
          previousAttachments: cleared.previousAttachments,
        });
      } else {
        updateQueuedMessageForSession(host, submittedSessionKey, queued.id, (item) => ({
          ...item,
          sendError: INTERRUPTED_MODEL_WAIT_ERROR,
          sendState: "failed",
        }));
        persistQueuedMessagesForSession(host, submittedSessionKey);
      }
      return;
    }
    if (host.sessionKey !== submittedSessionKey) {
      updateQueuedMessageForSession(host, submittedSessionKey, queued.id, (item) => ({
        ...item,
        sendError: undefined,
        sendState: undefined,
      }));
      persistQueuedMessagesForSession(host, submittedSessionKey);
      return;
    }

    if (isChatBusy(host)) {
      updateQueuedMessage(host, queued.id, (item) => ({
        ...item,
        sendError: undefined,
        sendState: undefined,
      }));
      recordChatSendTiming(host, queued, "queued-busy", submittedAtMs);
      return;
    }

    const accepted = await sendChatMessageNow(host, effectiveMessage, {
      queueItemId: queued.id,
      previousDraft: cleared.previousDraft,
      restoreDraft: Boolean(messageOverride && opts?.restoreDraft),
      attachments: hasAttachments ? attachmentsToSend : undefined,
      previousAttachments: cleared.previousAttachments,
      restoreAttachments: Boolean(messageOverride && opts?.restoreDraft),
      refreshSessions,
      submittedAtMs,
    });
    if (
      accepted &&
      replyTarget &&
      host.chatReplyTarget?.messageId === replyTarget.messageId &&
      host.sessionKey === submittedSessionKey
    ) {
      host.chatReplyTarget = null;
    }
  });
}

function shouldQueueLocalSlashCommand(name: string): boolean {
  return !["stop", "export-session", "steer", "redirect", "new"].includes(name);
}

function prependReplyQuote(
  message: string,
  replyTarget: NonNullable<ChatHost["chatReplyTarget"]>,
): string {
  const label = escapeMarkdownInline(replyTarget.senderLabel ?? "User");
  const text = replyTarget.text.trim();
  if (!text.includes("\n")) {
    return `> **${label}:** ${text}\n\n${message}`;
  }
  const quoted = text
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
  return `> **${label}:**\n${quoted}\n\n${message}`;
}

function escapeMarkdownInline(value: string): string {
  return value.replace(/([\\`*_{}[\]()#+\-.!|>])/g, "\\$1");
}

// ── Slash Command Dispatch ──

async function dispatchSlashCommand(
  host: ChatHost,
  name: string,
  args: string,
  sendOpts?: { previousDraft?: string; restoreDraft?: boolean },
) {
  switch (name) {
    case "stop":
      await handleAbortChat(host);
      return;
    case "new":
      if (!host.onSlashAction) {
        setChatError(host, "New Chat is unavailable.");
        return;
      }
      await host.onSlashAction("new-session");
      return;
    case "reset":
      await sendChatMessageNow(host, args ? `/reset ${args}` : "/reset", {
        refreshSessions: true,
        previousDraft: sendOpts?.previousDraft,
        restoreDraft: sendOpts?.restoreDraft,
      });
      return;
    case "clear":
      await clearChatHistory(host);
      return;
    case "export-session":
      await host.onSlashAction?.("export");
      return;
  }

  if (!host.client || !host.connected) {
    setChatError(host, "Gateway not connected");
    injectCommandResult(
      host,
      `Cannot run \`/${name}\`: Control UI is not connected to the Gateway.`,
    );
    scheduleChatScroll(host as unknown as Parameters<typeof scheduleChatScroll>[0]);
    return;
  }

  const targetSessionKey = host.sessionKey;
  let result: Awaited<ReturnType<typeof executeSlashCommand>>;
  try {
    result = await executeSlashCommand(host.client, targetSessionKey, name, args, {
      sessions: host.sessions,
      chatModelCatalog: host.chatModelCatalog,
      sessionsResult: host.sessionsResult,
      agentId: scopedAgentIdForSession(host, targetSessionKey),
    });
  } catch (err) {
    setChatError(host, String(err));
    injectCommandResult(host, `Command \`/${name}\` failed unexpectedly.`);
    scheduleChatScroll(host as unknown as Parameters<typeof scheduleChatScroll>[0]);
    return;
  }

  if (result.content) {
    injectCommandResult(host, result.content);
  }

  if (result.trackRunId) {
    host.chatRunId = result.trackRunId;
    host.chatStream = "";
    host.chatSending = false;
  }

  if (result.pendingCurrentRun && host.chatRunId) {
    enqueuePendingRunMessage(host, `/${name} ${args}`.trim(), host.chatRunId);
  }

  if (result.sessionPatch && "modelOverride" in result.sessionPatch) {
    host.chatModelOverrides = {
      ...host.chatModelOverrides,
      [targetSessionKey]: result.sessionPatch.modelOverride ?? null,
    };
    await host.onSlashAction?.("refresh-tools-effective");
  }

  if (result.action === "refresh") {
    await refreshChat(host);
  }

  scheduleChatScroll(host as unknown as Parameters<typeof scheduleChatScroll>[0]);
}

function clearCachedChatMessagesForSession(host: ChatHost, sessionKey: string) {
  if (!host.chatMessagesBySession) {
    return;
  }
  clearChatMessagesFromCache(host.chatMessagesBySession, host, { sessionKey });
}

export async function clearChatHistory(host: ChatHost) {
  if (!host.client || !host.connected) {
    return;
  }
  const hadActiveRun = hasAbortableSessionRun(host);
  try {
    await host.sessions.reset(host.sessionKey, {
      agentId: scopedAgentParamsForSession(host, host.sessionKey).agentId,
    });
    host.chatMessages = [];
    clearCachedChatMessagesForSession(host, host.sessionKey);
    host.chatSideResult = null;
    host.chatReplyTarget = null;
    reconcileChatRunLifecycle(host as unknown as Parameters<typeof reconcileChatRunLifecycle>[0], {
      outcome: hadActiveRun ? "interrupted" : undefined,
      sessionStatus: "killed",
      runId: host.chatRunId,
      sessionKey: host.sessionKey,
      clearLocalRun: true,
      clearChatStream: true,
      clearToolStream: true,
      clearSideResultTerminalRuns: true,
      clearRunStatus: !hadActiveRun,
    });
    await loadChatHistory(host as unknown as ChatState);
  } catch (err) {
    setChatError(host, String(err));
  }
  scheduleChatScroll(host as unknown as Parameters<typeof scheduleChatScroll>[0]);
}

function injectCommandResult(host: ChatHost, content: string) {
  host.chatMessages = [
    ...host.chatMessages,
    {
      role: "system",
      content,
      timestamp: Date.now(),
    },
  ];
}

export async function refreshChat(
  host: ChatHost,
  opts?: {
    scheduleScroll?: boolean;
    awaitHistory?: boolean;
    startup?: boolean;
    onStartupMetadata?: ChatStartupMetadataHandler;
  },
) {
  const refreshedSessionKey = host.sessionKey;
  const refreshedClient = host.client;
  const refreshedAgentId = resolveAgentIdForSession(host);
  const requestUpdate = () => host.requestUpdate?.();
  const previousSessionsResult = host.sessionsResult;
  const historyLoad = loadChatHistory(host as unknown as ChatState, {
    startup: opts?.startup === true,
  });
  const historyRefresh = historyLoad.finally(() => {
    if (opts?.scheduleScroll !== false) {
      scheduleChatScroll(host as unknown as Parameters<typeof scheduleChatScroll>[0]);
    }
    requestUpdate();
  });
  const sessionsRefresh = historyLoad.then((history) => {
    if (history?.sessionInfo) {
      const reconciled = host.sessions.reconcile(history.sessionInfo, history.defaults, {
        resultAgentId: host.sessionsResultAgentId ?? refreshedAgentId,
        selectedGlobalAgentId: refreshedAgentId,
        showArchived: host.sessionsShowArchived,
      });
      const sessionsResult = reconciled ? host.sessions.state.result : host.sessionsResult;
      if (reconciled) {
        host.sessionsResult = sessionsResult;
      }
      const sessionInfo = sessionsResult?.sessions.find(
        (row) =>
          areUiSessionKeysEquivalent(row.key, history.sessionInfo?.key) ||
          row.key === refreshedSessionKey,
      );
      if (sessionInfo) {
        const reconciled = reconcileChatRunFromSessionRow(host, sessionInfo, {
          publishRunStatus: true,
        });
        if (!reconciled) {
          reconcileChatRunFromCurrentSessionRow(host, { publishRunStatus: true });
        }
      }
    }
  });
  const startupMetadataRefresh =
    opts?.startup === true && opts.onStartupMetadata && refreshedClient
      ? historyLoad.then((history) => {
          if (
            host.client !== refreshedClient ||
            !host.connected ||
            host.sessionKey !== refreshedSessionKey ||
            resolveAgentIdForSession(host) !== refreshedAgentId
          ) {
            return;
          }
          return opts.onStartupMetadata?.({
            client: refreshedClient,
            agentId: refreshedAgentId,
            metadata: history?.metadata,
          });
        })
      : Promise.resolve();
  flushChatQueueAfterIdleSessionReconciliation(
    host,
    refreshedSessionKey,
    historyRefresh,
    sessionsRefresh,
    previousSessionsResult,
  );
  const secondaryRefresh = Promise.allSettled([sessionsRefresh, startupMetadataRefresh]).finally(
    requestUpdate,
  );
  void historyRefresh;
  void secondaryRefresh;
  if (opts?.awaitHistory === true) {
    await historyRefresh;
    return;
  }
  await Promise.resolve();
}

export const flushChatQueueForEvent = flushChatQueue;
