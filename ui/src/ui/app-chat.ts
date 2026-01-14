import { abortChatRun, loadChatHistory, sendChatMessage } from "./controllers/chat";
import { loadSessions } from "./controllers/sessions";
import { generateUUID } from "./uuid";
import { resetToolStream } from "./app-tool-stream";
import { scheduleChatScroll } from "./app-scroll";
import { setLastActiveSessionKey } from "./app-settings";
import type { ClawdbotApp } from "./app";

type ChatHost = {
  connected: boolean;
  chatMessage: string;
  chatQueue: Array<{ id: string; text: string; createdAt: number }>;
  chatRunId: string | null;
  chatSending: boolean;
  sessionKey: string;
};

export function isChatBusy(host: ChatHost) {
  return host.chatSending || Boolean(host.chatRunId);
}

export function isChatStopCommand(text: string) {
  const trimmed = text.trim();
  if (!trimmed) return false;
  const normalized = trimmed.toLowerCase();
  if (normalized === "/stop") return true;
  return (
    normalized === "stop" ||
    normalized === "esc" ||
    normalized === "abort" ||
    normalized === "wait" ||
    normalized === "exit"
  );
}

export async function handleAbortChat(host: ChatHost) {
  if (!host.connected) return;
  host.chatMessage = "";
  await abortChatRun(host as unknown as ClawdbotApp);
}

function enqueueChatMessage(host: ChatHost, text: string) {
  const trimmed = text.trim();
  if (!trimmed) return;
  host.chatQueue = [
    ...host.chatQueue,
    {
      id: generateUUID(),
      text: trimmed,
      createdAt: Date.now(),
    },
  ];
}

async function sendChatMessageNow(
  host: ChatHost,
  message: string,
  opts?: { previousDraft?: string; restoreDraft?: boolean },
) {
  resetToolStream(host as unknown as Parameters<typeof resetToolStream>[0]);
  const ok = await sendChatMessage(host as unknown as ClawdbotApp, message);
  if (!ok && opts?.previousDraft != null) {
    host.chatMessage = opts.previousDraft;
  }
  if (ok) {
    setLastActiveSessionKey(host as unknown as Parameters<typeof setLastActiveSessionKey>[0], host.sessionKey);
  }
  if (ok && opts?.restoreDraft && opts.previousDraft?.trim()) {
    host.chatMessage = opts.previousDraft;
  }
  scheduleChatScroll(host as unknown as Parameters<typeof scheduleChatScroll>[0]);
  if (ok && !host.chatRunId) {
    void flushChatQueue(host);
  }
  return ok;
}

async function flushChatQueue(host: ChatHost) {
  if (!host.connected || isChatBusy(host)) return;
  const [next, ...rest] = host.chatQueue;
  if (!next) return;
  host.chatQueue = rest;
  const ok = await sendChatMessageNow(host, next.text);
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
  if (!host.connected) return;
  const previousDraft = host.chatMessage;
  const message = (messageOverride ?? host.chatMessage).trim();
  if (!message) return;

  if (isChatStopCommand(message)) {
    await handleAbortChat(host);
    return;
  }

  if (messageOverride == null) {
    host.chatMessage = "";
  }

  if (isChatBusy(host)) {
    enqueueChatMessage(host, message);
    return;
  }

  await sendChatMessageNow(host, message, {
    previousDraft: messageOverride == null ? previousDraft : undefined,
    restoreDraft: Boolean(messageOverride && opts?.restoreDraft),
  });
}

export async function refreshChat(host: ChatHost) {
  await Promise.all([
    loadChatHistory(host as unknown as ClawdbotApp),
    loadSessions(host as unknown as ClawdbotApp),
  ]);
  scheduleChatScroll(host as unknown as Parameters<typeof scheduleChatScroll>[0], true);
}

export const flushChatQueueForEvent = flushChatQueue;
