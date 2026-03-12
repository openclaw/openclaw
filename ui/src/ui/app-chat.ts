import { parseAgentSessionKey } from "../../../src/sessions/session-key-utils.js";
import { scheduleChatScroll } from "./app-scroll.ts";
import { setLastActiveSessionKey } from "./app-settings.ts";
import { resetToolStream } from "./app-tool-stream.ts";
import type { OpenClawApp } from "./app.ts";
import { abortChatRun, loadChatHistory, sendChatMessage } from "./controllers/chat.ts";
import { loadSessions } from "./controllers/sessions.ts";
import type { GatewayBrowserClient } from "./gateway.ts";
import type { GatewayHelloOk } from "./gateway.ts";
import { normalizeBasePath } from "./navigation.ts";
import type { ChatAttachment, ChatQueueItem } from "./ui-types.ts";
import { generateUUID } from "./uuid.ts";

export type ChatHost = {
  connected: boolean;
  chatMessage: string;
  chatAttachments: ChatAttachment[];
  chatQueue: ChatQueueItem[];
  chatRunId: string | null;
  chatSending: boolean;
  sessionKey: string;
  basePath: string;
  hello: GatewayHelloOk | null;
  chatAvatarUrl: string | null;
  refreshSessionsAfterChat: Set<string>;
};

export const CHAT_SESSIONS_ACTIVE_MINUTES = 120;
const CHAT_RUN_WATCHDOG_IDLE_MS = 15_000;
const CHAT_RUN_WATCHDOG_RETRY_MS = 5_000;
const CHAT_RUN_WATCHDOG_WAIT_TIMEOUT_MS = 50;

export function isChatBusy(host: ChatHost) {
  return host.chatSending || Boolean(host.chatRunId);
}

type ChatRunWatchdogHost = ChatHost & {
  client: GatewayBrowserClient | null;
  chatLoading: boolean;
  chatMessages: unknown[];
  chatThinkingLevel: string | null;
  chatRunLastActivityAt: number | null;
  chatRunWatchdogTimer: number | null;
  chatRunWatchdogProbeInFlight: boolean;
  chatStream: string | null;
  chatStreamStartedAt: number | null;
  lastError: string | null;
};

function clearChatRunWatchdogTimer(host: ChatRunWatchdogHost) {
  if (host.chatRunWatchdogTimer !== null) {
    globalThis.clearTimeout(host.chatRunWatchdogTimer);
    host.chatRunWatchdogTimer = null;
  }
}

export function resetChatRunWatchdog(host: ChatRunWatchdogHost) {
  clearChatRunWatchdogTimer(host);
  host.chatRunWatchdogProbeInFlight = false;
  if (!host.chatRunId) {
    host.chatRunLastActivityAt = null;
  }
}

async function runChatRunWatchdog(host: ChatRunWatchdogHost, runId: string) {
  if (!host.connected || !host.client || !host.chatRunId || host.chatRunId !== runId) {
    resetChatRunWatchdog(host);
    return;
  }
  if (host.chatRunWatchdogProbeInFlight) {
    scheduleChatRunWatchdog(host, CHAT_RUN_WATCHDOG_RETRY_MS);
    return;
  }

  host.chatRunWatchdogProbeInFlight = true;
  try {
    const result = await host.client.request<{ status?: string }>("agent.wait", {
      runId,
      timeoutMs: CHAT_RUN_WATCHDOG_WAIT_TIMEOUT_MS,
    });
    if (host.chatRunId !== runId) {
      return;
    }
    if (result?.status === "ok" || result?.status === "error") {
      host.chatRunId = null;
      host.chatStream = null;
      host.chatStreamStartedAt = null;
      host.chatRunLastActivityAt = null;
      resetToolStream(host as unknown as Parameters<typeof resetToolStream>[0]);
      try {
        await loadChatHistory(host as unknown as OpenClawApp);
      } finally {
        await flushChatQueue(host);
      }
      return;
    }
  } catch (err) {
    host.lastError = String(err);
  } finally {
    host.chatRunWatchdogProbeInFlight = false;
  }

  if (host.chatRunId === runId) {
    scheduleChatRunWatchdog(host, CHAT_RUN_WATCHDOG_RETRY_MS);
  }
}

export function scheduleChatRunWatchdog(host: ChatRunWatchdogHost, delayMs?: number) {
  clearChatRunWatchdogTimer(host);
  if (!host.connected || !host.client || !host.chatRunId) {
    resetChatRunWatchdog(host);
    return;
  }

  const now = Date.now();
  const lastActivityAt = host.chatRunLastActivityAt ?? now;
  const delay =
    delayMs ?? Math.max(0, CHAT_RUN_WATCHDOG_IDLE_MS - Math.max(0, now - lastActivityAt));
  const runId = host.chatRunId;
  host.chatRunWatchdogTimer = globalThis.setTimeout(() => {
    host.chatRunWatchdogTimer = null;
    void runChatRunWatchdog(host, runId);
  }, delay);
}

export function noteChatRunActivity(host: ChatRunWatchdogHost, now = Date.now()) {
  if (!host.chatRunId) {
    return;
  }
  host.chatRunLastActivityAt = now;
  scheduleChatRunWatchdog(host);
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
  const ok = await abortChatRun(host as unknown as OpenClawApp);
  if (ok && host.chatRunId) {
    noteChatRunActivity(host as unknown as ChatRunWatchdogHost);
  }
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

export const flushChatQueueForEvent = flushChatQueue;

type SessionDefaultsSnapshot = {
  defaultAgentId?: string;
};

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
