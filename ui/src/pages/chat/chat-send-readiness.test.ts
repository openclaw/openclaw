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

it.each(
  [
    { message: "/stop", action: "abort" },
    { message: "/approve approval-123 allow-once", action: "approve" },
    { message: "ordinary draft", action: "blocked" },
    { message: "/stop after the next turn", action: "blocked" },
    { message: "/stop", action: "goal" },
  ].flatMap((test) =>
    (test.action === "approve" ? [true, false] : [true]).map((hydrated) => ({
      message: test.message,
      action: test.action,
      hydrated,
    })),
  ),
)(
  "keeps $action admission separate from initial history (run hydrated: $hydrated)",
  async ({ message, action, hydrated }) => {
    const history = createDeferred<ChatHistoryResult>();
    const host = makeChatHost({
      chatMessage: message,
      chatRunId: hydrated ? "waiting-run" : null,
      chatStream: hydrated ? "Waiting for approval" : null,
      requestHandlers: {
        "chat.startup": () => history.promise,
        "chat.abort": { aborted: true },
        "chat.send": { runId: "approval-command", status: "started" },
      },
    });
    const loading = loadChatHistory(host, { startup: true, deferBranches: true });
    const sending = handleSendChat(
      host,
      undefined,
      action === "goal"
        ? { intent: { kind: "session-goal-start", version: 1, issuedAtMs: Date.now() } }
        : undefined,
    );
    try {
      if (action === "approve") {
        await vi.waitFor(() =>
          expect(findChatSendPayload(host)).toMatchObject({ sessionKey: host.sessionKey, message }),
        );
      } else {
        await sending;
      }
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
        expect(
          host.request.mock.calls.filter(([method]) => method === "chat.history"),
        ).toHaveLength(0);
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
      await sending;
    }
  },
);

it.each(["replacement Gateway", "reconnected client", "offline pane"] as const)(
  "keeps accepted-history admission scoped through a %s",
  async (change) => {
    const sessionKey = "agent:main:main";
    const accepted: ChatHistoryResult = {
      sessionId: "old-session",
      messages: [],
      sessionInfo: { key: sessionKey, sessionId: "old-session", kind: "direct", updatedAt: 1 },
    };
    const history = createDeferred<ChatHistoryResult>();
    let initial = true;
    const requestHandlers = {
      "chat.startup": () => (initial ? accepted : history.promise),
      "chat.history": accepted,
      "chat.send": { runId: "new-run", status: "started" },
    };
    const host = makeChatHost({
      sessionKey,
      chatMessage: "Keep this draft unsent",
      requestHandlers,
    });
    await loadChatHistory(host, { startup: true, deferBranches: true });
    initial = false;
    const next =
      change === "replacement Gateway" ? makeChatHost({ sessionKey, requestHandlers }) : host;
    host.client = next.client;
    host.sessions = next.sessions;
    host.connectionEpoch += 1;
    if (change === "offline pane") {
      host.connected = false;
    }
    const loading =
      change === "offline pane"
        ? Promise.resolve()
        : loadChatHistory(host, { startup: true, deferBranches: true });
    const sending = handleSendChat(host);
    history.resolve(accepted);
    await loading;
    await sending;
    expect(host.request).not.toHaveBeenCalledWith("chat.send", expect.anything());
    expect(next.request).not.toHaveBeenCalledWith("chat.send", expect.anything());
    if (change === "offline pane") {
      expect(host.chatQueue).toEqual([expect.objectContaining({ text: "Keep this draft unsent" })]);
      expect(host.chatMessage).toBe("");
    } else {
      expect(host.chatMessage).toBe("Keep this draft unsent");
      expect(host.chatQueue).toEqual([]);
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
  expect(host.request.mock.calls.filter(([method]) => method === "chat.history")).toHaveLength(0);
  history.resolve(current);
  await loading;
  expect(host.request).not.toHaveBeenCalledWith("chat.send", expect.anything());
  await handleSendChat(host);
  expect(findChatSendPayload(host)).toMatchObject({
    message: "Draft while restoring history",
    sessionId: "current-session",
  });
});
