// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { createStorageMock } from "../../test-helpers/storage.ts";
import type { ChatHistoryResult } from "./chat-history-snapshot.ts";
import { loadChatHistory } from "./chat-history.ts";
import { findChatSendPayload, makeChatHost } from "./chat-host.test-support.ts";
import { enqueueChatMessage } from "./chat-queue.ts";
import { retryQueuedChatMessage, steerQueuedChatMessage } from "./chat-send-actions.ts";
import { handleSendChat } from "./chat-send-submit.ts";
import { installOutboxBrowserStorage } from "./outbox-browser.test-support.ts";
import { applyChatCacheSnapshot } from "./session-message-cache.ts";

beforeEach(() => {
  installOutboxBrowserStorage();
  vi.stubGlobal("sessionStorage", createStorageMock());
  vi.stubGlobal("requestAnimationFrame", () => 1);
  vi.stubGlobal("cancelAnimationFrame", () => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it.each([
  { message: "/stop", action: "abort" },
  { message: "/approve approval-123 allow-once", action: "approve" },
  { message: "ordinary draft", action: "blocked" },
  { message: "/stop after the next turn", action: "blocked" },
  { message: "/stop", action: "goal" },
] as const)(
  "keeps $action admission separate from initial history",
  async ({ message, action }) => {
    const history = createDeferred<ChatHistoryResult>();
    const host = makeChatHost({
      chatMessage: message,
      chatRunId: "waiting-run",
      chatStream: "Waiting for approval",
      requestHandlers: {
        "chat.startup": () => history.promise,
        "chat.abort": { aborted: true },
        "chat.send": { runId: "approval-command", status: "started" },
      },
    });
    const loading = loadChatHistory(host, { startup: true, deferBranches: true });
    try {
      await handleSendChat(
        host,
        undefined,
        action === "goal"
          ? { intent: { kind: "session-goal-start", version: 1, issuedAtMs: Date.now() } }
          : undefined,
      );
      expect(host.chatLoading).toBe(true);
      if (action === "abort") {
        expect(host.request).toHaveBeenCalledWith("chat.abort", {
          runId: "waiting-run",
          sessionKey: host.sessionKey,
        });
      } else {
        expect(host.request).not.toHaveBeenCalledWith("chat.abort", expect.anything());
      }
      if (action === "approve") {
        expect(findChatSendPayload(host)).toMatchObject({ sessionKey: host.sessionKey, message });
      } else {
        expect(host.request).not.toHaveBeenCalledWith("chat.send", expect.anything());
      }
      expect(host.chatQueue).toEqual([]);
      if (action === "blocked" || action === "goal") {
        expect(host.chatMessage).toBe(message);
      }
    } finally {
      history.resolve({ messages: [] });
      await loading;
    }
  },
);

it.each(["steer", "retry"] as const)(
  "holds queued %s without changing custody during initial history",
  async (action) => {
    const history = createDeferred<ChatHistoryResult>();
    const host = makeChatHost({
      chatRunId: "current-run",
      requestHandlers: {
        "chat.startup": () => history.promise,
        "chat.send": { runId: "queued-send", status: "started" },
      },
    });
    const queued = enqueueChatMessage(host, "already queued", false);
    if (!queued) {
      throw new Error("Expected an admitted queue item");
    }
    const before = structuredClone(host.chatQueue);
    const loading = loadChatHistory(host, { startup: true, deferBranches: true });
    try {
      await (action === "steer" ? steerQueuedChatMessage : retryQueuedChatMessage)(host, queued.id);
      expect(host.request).not.toHaveBeenCalledWith("chat.send", expect.anything());
      expect(host.chatQueue).toEqual(before);
    } finally {
      history.resolve({ messages: [] });
      await loading;
    }
  },
);

it("keeps a restored transcript draft unsent until initial history commits", async () => {
  const history = createDeferred<ChatHistoryResult>();
  const current: ChatHistoryResult = {
    sessionId: "current-session",
    messages: [],
    sessionInfo: {
      key: "agent:main:main",
      sessionId: "current-session",
      kind: "direct",
      updatedAt: 1,
    },
  };
  const host = makeChatHost({
    chatMessage: "Draft while restoring history",
    requestHandlers: {
      "chat.startup": () => history.promise,
      "chat.history": current,
      "chat.send": { status: "started" },
    },
  });
  applyChatCacheSnapshot(host, {
    messages: [],
    sessionId: "restored-session",
    pagination: { hasMore: false, completeSnapshot: true },
  });
  const loading = loadChatHistory(host, { startup: true, deferBranches: true });
  await handleSendChat(host);
  expect(host.currentSessionId).toBe("restored-session");
  expect(host.chatMessage).toBe("Draft while restoring history");
  expect(host.chatQueue).toEqual([]);
  expect(host.request).not.toHaveBeenCalledWith("chat.send", expect.anything());
  expect(host.request).not.toHaveBeenCalledWith("chat.history", expect.anything());
  history.resolve(current);
  await loading;
  expect(host.request).not.toHaveBeenCalledWith("chat.send", expect.anything());
  await handleSendChat(host);
  expect(findChatSendPayload(host)).toMatchObject({
    message: "Draft while restoring history",
    sessionId: "current-session",
  });
});
