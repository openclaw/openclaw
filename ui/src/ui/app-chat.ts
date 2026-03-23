import type { OpenClawApp } from "./app.ts";
import type { GatewayHelloOk } from "./gateway.ts";
import type { UiSettings } from "./storage.ts";
import type { ChatAttachment, ChatQueueItem } from "./ui-types.ts";
import { parseAgentSessionKey } from "../../../src/sessions/session-key-utils.js";
import { scheduleChatScroll } from "./app-scroll.ts";
import { setLastActiveSessionKey } from "./app-settings.ts";
import { resetToolStream } from "./app-tool-stream.ts";
import { abortChatRun, loadChatHistory, sendChatMessage } from "./controllers/chat.ts";
import { loadSessions } from "./controllers/sessions.ts";
import { normalizeBasePath } from "./navigation.ts";
import { generateUUID } from "./uuid.ts";

export type ChatHost = {
  client: OpenClawApp["client"];
  connected: boolean;
  chatMessage: string;
  chatAttachments: ChatAttachment[];
  chatQueue: ChatQueueItem[];
  chatRunId: string | null;
  chatSending: boolean;
  chatMessages?: unknown[];
  chatSummary?: string | null;
  chatContextInfo?: Record<string, unknown> | null;
  chatToolMessages?: unknown[];
  chatStream?: string | null;
  chatStreamStartedAt?: number | null;
  compactionStatus?: unknown;
  sessionKey: string;
  basePath: string;
  hello: GatewayHelloOk | null;
  settings: UiSettings;
  applySettings: (next: UiSettings) => void;
  chatAvatarUrl: string | null;
  chatHistoryMode: "summary" | "full";
  refreshSessionsAfterChat: Set<string>;
};

export const CHAT_SESSIONS_ACTIVE_MINUTES = 120;

export function isChatBusy(host: ChatHost) {
  return host.chatSending || Boolean(host.chatRunId);
}

export function isChatStopCommand(text: string) {
  const trimmed = text.trim();
  if (!trimmed) {
    return false;
  }
  const normalized = trimmed.toLowerCase();
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
  const trimmed = text.trim();
  if (!trimmed) {
    return false;
  }
  const normalized = trimmed.toLowerCase();
  if (normalized === "/new" || normalized === "/reset") {
    return true;
  }
  return normalized.startsWith("/new ") || normalized.startsWith("/reset ");
}

export async function handleAbortChat(host: ChatHost) {
  if (!host.connected) {
    return;
  }
  host.chatMessage = "";
  await abortChatRun(host as unknown as OpenClawApp);
}

export function resetActiveChatRuntimeState(host: ChatHost) {
  host.chatRunId = null;
  host.chatSending = false;
  host.chatQueue = [];
  host.chatMessage = "";
  host.chatAttachments = [];
  host.chatAvatarUrl = null;
  host.refreshSessionsAfterChat.clear();
  if ("chatMessages" in host) {
    host.chatMessages = [];
  }
  if ("chatSummary" in host) {
    host.chatSummary = null;
  }
  if ("chatContextInfo" in host) {
    host.chatContextInfo = null;
  }
  if ("chatToolMessages" in host) {
    host.chatToolMessages = [];
  }
  if ("chatStream" in host) {
    host.chatStream = null;
  }
  if ("chatStreamStartedAt" in host) {
    host.chatStreamStartedAt = null;
  }
  if ("compactionStatus" in host) {
    host.compactionStatus = null;
  }
  resetToolStream(host as unknown as Parameters<typeof resetToolStream>[0]);
}

async function resetActiveChatRuntime(host: ChatHost) {
  if (host.connected && host.chatRunId) {
    await abortChatRun(host as unknown as OpenClawApp);
  }
  resetActiveChatRuntimeState(host);
}

async function switchActiveChatSession(
  host: ChatHost,
  nextSessionKey: string,
  opts?: { skipRuntimeReset?: boolean },
) {
  if (!opts?.skipRuntimeReset) {
    await resetActiveChatRuntime(host);
  }
  host.sessionKey = nextSessionKey;
  host.applySettings({
    ...host.settings,
    sessionKey: nextSessionKey,
    lastActiveSessionKey: nextSessionKey,
  });
  await refreshChat(host, { scheduleScroll: false });
}

function enqueueChatMessage(
  host: ChatHost,
  text: string,
  attachments?: ChatAttachment[],
  refreshSessions?: boolean,
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
      attachments: hasAttachments ? attachments?.map((att) => ({ ...att })) : undefined,
      refreshSessions,
    },
  ];
}

async function sendChatMessageNow(
  host: ChatHost,
  message: string,
  opts?: {
    previousDraft?: string;
    restoreDraft?: boolean;
    attachments?: ChatAttachment[];
    previousAttachments?: ChatAttachment[];
    restoreAttachments?: boolean;
    refreshSessions?: boolean;
  },
) {
  resetToolStream(host as unknown as Parameters<typeof resetToolStream>[0]);
  const runId = await sendChatMessage(host as unknown as OpenClawApp, message, opts?.attachments);
  const ok = Boolean(runId);
  if (!ok && opts?.previousDraft != null) {
    host.chatMessage = opts.previousDraft;
  }
  if (!ok && opts?.previousAttachments) {
    host.chatAttachments = opts.previousAttachments;
  }
  if (ok) {
    setLastActiveSessionKey(
      host as unknown as Parameters<typeof setLastActiveSessionKey>[0],
      host.sessionKey,
    );
  }
  if (ok && opts?.restoreDraft && opts.previousDraft?.trim()) {
    host.chatMessage = opts.previousDraft;
  }
  if (ok && opts?.restoreAttachments && opts.previousAttachments?.length) {
    host.chatAttachments = opts.previousAttachments;
  }
  scheduleChatScroll(host as unknown as Parameters<typeof scheduleChatScroll>[0]);
  if (ok && !host.chatRunId) {
    void flushChatQueue(host);
  }
  if (ok && opts?.refreshSessions && runId) {
    host.refreshSessionsAfterChat.add(runId);
  }
  return ok;
}

async function flushChatQueue(host: ChatHost) {
  if (!host.connected || isChatBusy(host)) {
    return;
  }
  const [next, ...rest] = host.chatQueue;
  if (!next) {
    return;
  }
  host.chatQueue = rest;
  const ok = await sendChatMessageNow(host, next.text, {
    attachments: next.attachments,
    refreshSessions: next.refreshSessions,
  });
  if (!ok) {
    host.chatQueue = [next, ...host.chatQueue];
  }
}

export function removeQueuedMessage(host: ChatHost, id: string) {
  host.chatQueue = host.chatQueue.filter((item) => item.id !== id);
}

export async function handleSendChat(
  host: ChatHost,
  messageOverride?: string,
  opts?: { restoreDraft?: boolean },
) {
  if (!host.connected) {
    return;
  }
  const previousDraft = host.chatMessage;
  const message = (messageOverride ?? host.chatMessage).trim();
  const attachments = host.chatAttachments ?? [];
  const attachmentsToSend = messageOverride == null ? attachments : [];
  const hasAttachments = attachmentsToSend.length > 0;

  // Allow sending with just attachments (no message text required)
  if (!message && !hasAttachments) {
    return;
  }

  if (isChatStopCommand(message)) {
    await handleAbortChat(host);
    return;
  }

  const refreshSessions = isChatResetCommand(message);
  if (messageOverride == null) {
    host.chatMessage = "";
    // Clear attachments when sending
    host.chatAttachments = [];
  }

  if (isChatBusy(host)) {
    enqueueChatMessage(host, message, attachmentsToSend, refreshSessions);
    return;
  }

  await sendChatMessageNow(host, message, {
    previousDraft: messageOverride == null ? previousDraft : undefined,
    restoreDraft: Boolean(messageOverride && opts?.restoreDraft),
    attachments: hasAttachments ? attachmentsToSend : undefined,
    previousAttachments: messageOverride == null ? attachments : undefined,
    restoreAttachments: Boolean(messageOverride && opts?.restoreDraft),
    refreshSessions,
  });
}

export async function refreshChat(host: ChatHost, opts?: { scheduleScroll?: boolean }) {
  await Promise.all([
    loadChatHistory(host as unknown as OpenClawApp),
    loadSessions(host as unknown as OpenClawApp, {
      activeMinutes: CHAT_SESSIONS_ACTIVE_MINUTES,
    }),
    refreshChatAvatar(host),
  ]);
  if (opts?.scheduleScroll !== false) {
    scheduleChatScroll(host as unknown as Parameters<typeof scheduleChatScroll>[0]);
  }
}

export async function compactActiveChat(host: ChatHost) {
  if (!host.client || !host.connected) {
    return;
  }
  await host.client.request("sessions.compact", { key: host.sessionKey });
  await refreshChat(host, { scheduleScroll: false });
}

export async function clearActiveChat(host: ChatHost) {
  if (!host.client || !host.connected) {
    return;
  }
  await resetActiveChatRuntime(host);
  await host.client.request("sessions.reset", { key: host.sessionKey, reason: "reset" });
  await refreshChat(host, { scheduleScroll: false });
}

export async function archiveActiveChat(host: ChatHost) {
  if (!host.client || !host.connected) {
    return;
  }
  const currentSessionKey = host.sessionKey;
  await resetActiveChatRuntime(host);
  await host.client.request("sessions.archive", { key: currentSessionKey });
  const nextSessionKey = buildNewChatSessionKey(host);
  await switchActiveChatSession(host, nextSessionKey, { skipRuntimeReset: true });
}

export async function handleSelectChatAgent(host: ChatHost, agentId: string) {
  const nextSessionKey = buildAgentSessionKey(host, agentId);
  await switchActiveChatSession(host, nextSessionKey);
}

export async function startNewChat(host: ChatHost) {
  await switchActiveChatSession(host, buildNewChatSessionKey(host));
}

export const flushChatQueueForEvent = flushChatQueue;

type SessionDefaultsSnapshot = {
  defaultAgentId?: string;
  mainKey?: string;
};

function resolveMainKey(host: ChatHost): string {
  const snapshot = host.hello?.snapshot as
    | { sessionDefaults?: SessionDefaultsSnapshot }
    | undefined;
  return snapshot?.sessionDefaults?.mainKey?.trim() || "main";
}

function buildAgentSessionKey(host: ChatHost, agentId: string): string {
  return `agent:${agentId}:${resolveMainKey(host)}`;
}

function buildNewChatSessionKey(host: ChatHost): string {
  const agentId = resolveAgentIdForSession(host) ?? "main";
  return `agent:${agentId}:chat:${Date.now().toString(36)}`;
}

function resolveAgentIdForSession(host: ChatHost): string | null {
  const parsed = parseAgentSessionKey(host.sessionKey);
  if (parsed?.agentId) {
    return parsed.agentId;
  }
  const snapshot = host.hello?.snapshot as
    | { sessionDefaults?: SessionDefaultsSnapshot }
    | undefined;
  const fallback = snapshot?.sessionDefaults?.defaultAgentId?.trim();
  return fallback || "main";
}

function buildAvatarMetaUrl(basePath: string, agentId: string): string {
  const base = normalizeBasePath(basePath);
  const encoded = encodeURIComponent(agentId);
  return base ? `${base}/avatar/${encoded}?meta=1` : `/avatar/${encoded}?meta=1`;
}

export async function refreshChatAvatar(host: ChatHost) {
  if (!host.connected) {
    host.chatAvatarUrl = null;
    return;
  }
  const agentId = resolveAgentIdForSession(host);
  if (!agentId) {
    host.chatAvatarUrl = null;
    return;
  }
  host.chatAvatarUrl = null;
  const url = buildAvatarMetaUrl(host.basePath, agentId);
  try {
    const res = await fetch(url, { method: "GET" });
    if (!res.ok) {
      host.chatAvatarUrl = null;
      return;
    }
    const data = (await res.json()) as { avatarUrl?: unknown };
    const avatarUrl = typeof data.avatarUrl === "string" ? data.avatarUrl.trim() : "";
    host.chatAvatarUrl = avatarUrl || null;
  } catch {
    host.chatAvatarUrl = null;
  }
}
