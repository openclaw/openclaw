// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { createStorageMock } from "../../test-helpers/storage.ts";
import type { ChatHistoryResult } from "./chat-history-snapshot.ts";
import { loadChatHistory } from "./chat-history.ts";
import { findChatSendPayload, makeChatHost } from "./chat-host.test-support.ts";
import { enqueueChatMessage, removeQueuedMessageWithoutReleasing } from "./chat-queue.ts";
import {
  resumeStoredChatOutboxes,
  retryQueuedChatMessage,
  steerQueuedChatMessage,
} from "./chat-send-actions.ts";
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
    { message: "ordinary draft", action: "queued" },
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
      if (action === "queued") {
        await vi.waitFor(() => expect(host.chatQueue).toHaveLength(1));
      } else if (action === "approve") {
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
      if (action === "queued") {
        expect(host.chatQueue).toEqual([
          expect.objectContaining({ text: message, sendAttempts: 0 }),
        ]);
        expect(host.chatMessage).toBe("");
      } else {
        expect(host.chatQueue).toEqual([]);
      }
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
  "keeps early queued delivery scoped through a %s",
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
    await vi.waitFor(() => expect(host.chatMessage).toBe(""));
    expect(host.request).not.toHaveBeenCalledWith("chat.send", expect.anything());
    expect(next.request).not.toHaveBeenCalledWith("chat.send", expect.anything());
    history.resolve(accepted);
    await loading;
    await sending;
    if (change === "offline pane") {
      expect(host.request).not.toHaveBeenCalledWith("chat.send", expect.anything());
      expect(host.chatQueue).toEqual([expect.objectContaining({ text: "Keep this draft unsent" })]);
      expect(host.chatMessage).toBe("");
    } else {
      expect(findChatSendPayload(next)).toMatchObject({
        message: "Keep this draft unsent",
        sessionId: "old-session",
      });
      if (next !== host) {
        expect(host.request).not.toHaveBeenCalledWith("chat.send", expect.anything());
      }
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

it.each([false, true])(
  "accepts a restored transcript draft before history and delivers to the authoritative session (attachment: %s)",
  async (withAttachment) => {
    const history = createDeferred<ChatHistoryResult>();
    const current: ChatHistoryResult = {
      sessionId: "current-session",
      messages: [],
      sessionInfo: {
        key: "agent:main:main",
        sessionId: "current-session",
        kind: "direct",
        updatedAt: 1,
        activeLeafEntryId: "current-leaf",
      },
    };
    const host = makeChatHost({
      chatMessage: "Draft while restoring history",
      chatAttachments: withAttachment
        ? [
            {
              id: "early-file",
              mimeType: "text/plain",
              fileName: "note.txt",
              dataUrl: "data:text/plain;base64,aGVsbG8=",
            },
          ]
        : [],
      requestHandlers: {
        "chat.startup": () => history.promise,
        "chat.history": current,
        "chat.send": { status: "started" },
      },
    });
    applyChatCacheSnapshot(host, {
      messages: [],
      sessionId: "restored-session",
      displayedLeafEntryId: "restored-leaf",
      pagination: { hasMore: false, completeSnapshot: true },
    });
    const loading = loadChatHistory(host, { startup: true, deferBranches: true });
    const sending = handleSendChat(host);
    try {
      await vi.waitFor(() => expect(host.chatMessage).toBe(""));
      expect(host.currentSessionId).toBe("restored-session");
      expect(host.chatQueue).toEqual([
        expect.objectContaining({ text: "Draft while restoring history", sendAttempts: 0 }),
      ]);
      expect(host.request).not.toHaveBeenCalledWith("chat.send", expect.anything());
      expect(host.request.mock.calls.filter(([method]) => method === "chat.history")).toHaveLength(
        0,
      );
      expect(host.chatAttachments).toEqual([]);
      host.chatMessage = "Next draft";
    } finally {
      history.resolve(current);
      await loading;
      await sending;
    }
    expect(findChatSendPayload(host)).toMatchObject({
      message: "Draft while restoring history",
      sessionId: "current-session",
      expectedLeafEntryId: "current-leaf",
    });
    expect(host.chatMessage).toBe("Next draft");
    expect(host.request.mock.calls.filter(([method]) => method === "chat.send")).toHaveLength(1);
    if (withAttachment) {
      expect(findChatSendPayload(host).attachments).toEqual([
        expect.objectContaining({
          content: "aGVsbG8=",
          fileName: "note.txt",
          mimeType: "text/plain",
        }),
      ]);
    }
  },
);

it.each(["original-leaf", null])(
  "preserves the submitted leaf fence %s when history starts after outbox admission",
  async (expectedLeafEntryId) => {
    const sessionKey = "agent:main:main";
    const history = createDeferred<ChatHistoryResult>();
    const host = makeChatHost({
      sessionKey,
      currentSessionId: "current-session",
      chatDisplayedLeafEntryId: expectedLeafEntryId,
      chatMessage: "Send against the branch I selected",
      requestHandlers: {
        "chat.history": () => history.promise,
        "chat.send": { status: "started", messageSeq: 1 },
      },
    });
    let loading: ReturnType<typeof loadChatHistory> | undefined;
    const sending = handleSendChat(host, undefined, {
      onOutboxAdmitted: () => {
        loading = loadChatHistory(host, { deferBranches: true });
      },
    });
    try {
      await vi.waitFor(() => expect(host.chatLoading).toBe(true));
      expect(host.chatMessage).toBe("");
      expect(host.chatQueue).toHaveLength(1);
      expect(host.request).not.toHaveBeenCalledWith("chat.send", expect.anything());
    } finally {
      history.resolve({
        messages: [],
        sessionInfo: {
          key: sessionKey,
          sessionId: "current-session",
          activeLeafEntryId: "different-branch-leaf",
          kind: "direct",
          updatedAt: 2,
        },
      });
      await loading;
      await sending;
    }

    expect(host.chatDisplayedLeafEntryId).toBe("different-branch-leaf");
    expect(findChatSendPayload(host)).toHaveProperty("expectedLeafEntryId", expectedLeafEntryId);
    expect(host.request.mock.calls.filter(([method]) => method === "chat.send")).toHaveLength(1);
  },
);

it.each(["connection", "conversation", "discard"] as const)(
  "does not deliver stale queued work after a %s change during history",
  async (change) => {
    const history = createDeferred<ChatHistoryResult>();
    const host = makeChatHost({
      chatMessage: "Queued before history",
      requestHandlers: {
        "chat.startup": () => history.promise,
        "chat.send": { status: "started" },
      },
    });
    const loading = loadChatHistory(host, { startup: true, deferBranches: true });
    const sending = handleSendChat(host);
    try {
      await vi.waitFor(() => expect(host.chatQueue).toHaveLength(1));
      if (change === "connection") {
        host.connectionEpoch += 1;
      } else if (change === "conversation") {
        host.sessionKey = "agent:main:another-conversation";
      } else {
        removeQueuedMessageWithoutReleasing(host, host.chatQueue[0]!.id);
      }
    } finally {
      history.resolve({ messages: [], sessionId: "old-session" });
      await loading;
      await sending;
    }
    expect(host.request).not.toHaveBeenCalledWith("chat.send", expect.anything());
    expect(host.chatMessage).toBe("");
  },
);

it.each([false, true])(
  "delivers the next early message after discarding the first during history (switch pane: %s)",
  async (switchPane) => {
    const sessionKey = "agent:main:main";
    const history = createDeferred<ChatHistoryResult>();
    const current: ChatHistoryResult = {
      messages: [],
      sessionInfo: {
        key: sessionKey,
        sessionId: "current-session",
        activeLeafEntryId: "current-leaf",
        hasActiveRun: false,
        status: "done",
        kind: "direct",
        updatedAt: 1,
      },
    };
    const host = makeChatHost({
      sessionKey,
      chatMessage: "Discard this first message",
      requestHandlers: {
        "chat.startup": () => history.promise,
        "chat.history": current,
        "chat.send": { status: "started", messageSeq: 1 },
      },
    });
    applyChatCacheSnapshot(host, {
      messages: [],
      sessionId: "cached-session",
      displayedLeafEntryId: "cached-leaf",
      pagination: { hasMore: false, completeSnapshot: true },
    });
    const loading = loadChatHistory(host, { startup: true, deferBranches: true });
    const sending = [handleSendChat(host)];
    try {
      await vi.waitFor(() => expect(host.chatQueue).toHaveLength(1));
      const firstId = host.chatQueue[0]!.id;
      host.chatMessage = "Keep this second message";
      sending.push(handleSendChat(host));
      await vi.waitFor(() => expect(host.chatQueue).toHaveLength(2));
      removeQueuedMessageWithoutReleasing(host, firstId);
      expect(host.chatQueue).toEqual([
        expect.objectContaining({ text: "Keep this second message", sendAttempts: 0 }),
      ]);
      expect(host.chatMessage).toBe("");
      expect(host.request).not.toHaveBeenCalledWith("chat.send", expect.anything());
      if (switchPane) {
        host.sessionKey = "agent:main:other";
        host.currentSessionId = "other-session";
        host.chatDisplayedLeafEntryId = "other-leaf";
      }
    } finally {
      history.resolve(current);
      await loading;
      await Promise.all(sending);
    }

    expect(host.request.mock.calls.filter(([method]) => method === "chat.send")).toHaveLength(1);
    const payload = findChatSendPayload(host);
    expect(payload).toMatchObject({
      sessionKey,
      message: "Keep this second message",
    });
    if (switchPane) {
      expect(payload).not.toHaveProperty("sessionId");
      expect(host.request).toHaveBeenCalledWith(
        "chat.history",
        expect.objectContaining({ sessionKey }),
      );
    } else {
      expect(payload.sessionId).toBe("current-session");
    }
    expect(payload).not.toHaveProperty("expectedLeafEntryId", "cached-leaf");
    expect(host.chatQueue).toEqual([]);
  },
);

it.each(["steer", "interrupt", "queue"] as const)(
  "preserves the selected %s policy when initial history reveals an active run",
  async (followUpMode) => {
    const sessionKey = "agent:main:main";
    const message = "Apply my selected follow-up mode";
    const history = createDeferred<ChatHistoryResult>();
    const host = makeChatHost({
      sessionKey,
      chatMessage: message,
      sessionsResult: {
        ts: 1,
        path: "",
        count: 1,
        defaults: { modelProvider: null, model: null, contextTokens: null },
        sessions: [
          {
            key: sessionKey,
            sessionId: "current-session",
            hasActiveRun: false,
            status: "done",
            kind: "direct",
            updatedAt: 1,
          },
        ],
      },
      requestHandlers: {
        "chat.startup": () => history.promise,
        "chat.send": { status: "started", messageSeq: 1 },
      },
    });
    applyChatCacheSnapshot(host, {
      messages: [],
      sessionId: "current-session",
      displayedLeafEntryId: "cached-leaf",
      pagination: { hasMore: false, completeSnapshot: true },
    });
    const loading = loadChatHistory(host, { startup: true, deferBranches: true });
    const sending = handleSendChat(host, undefined, { followUpMode });
    try {
      await vi.waitFor(() => expect(host.chatQueue).toHaveLength(1));
      expect(host.chatMessage).toBe("");
      expect(host.chatQueue[0]).toMatchObject({ text: message, sendAttempts: 0 });
      expect(host.request).not.toHaveBeenCalledWith("chat.send", expect.anything());
    } finally {
      history.resolve({
        messages: [],
        inFlightRun: { runId: "active-run", text: "Work started after the cached snapshot" },
        sessionInfo: {
          key: sessionKey,
          sessionId: "current-session",
          activeLeafEntryId: "active-leaf",
          activeRunIds: ["active-run"],
          hasActiveRun: true,
          status: "running",
          kind: "direct",
          updatedAt: 2,
        },
      });
      await loading;
      await sending;
    }

    if (followUpMode === "queue") {
      expect(host.request).not.toHaveBeenCalledWith("chat.send", expect.anything());
      expect(host.chatQueue).toEqual([
        expect.objectContaining({ text: message, sendAttempts: 0, sendState: "waiting-idle" }),
      ]);
    } else {
      expect(findChatSendPayload(host)).toMatchObject({
        sessionKey,
        message,
        queueMode: followUpMode,
      });
      expect(host.request.mock.calls.filter(([method]) => method === "chat.send")).toHaveLength(1);
      expect(host.chatQueue).toEqual([]);
    }
  },
);

it.each(["steer", "interrupt"] as const)(
  "resumes an early %s message for its captured session after switching panes",
  async (queueMode) => {
    const sessionKey = "agent:work:research";
    const message = "Continue the selected work";
    const history = createDeferred<ChatHistoryResult>();
    const host = makeChatHost({
      sessionKey,
      currentSessionId: "cached-source-session",
      chatDisplayedLeafEntryId: "cached-source-leaf",
      chatRunId: "cached-source-run",
      chatFollowUpMode: queueMode,
      chatMessage: message,
      requestHandlers: {
        "chat.startup": () => history.promise,
        "chat.send": { status: "started", messageSeq: 1 },
      },
    });
    const loading = loadChatHistory(host, { startup: true, deferBranches: true });
    const sending = handleSendChat(host);
    try {
      await vi.waitFor(() => expect(host.chatQueue).toHaveLength(1));
      expect(host.chatMessage).toBe("");
      expect(host.chatQueue[0]).toMatchObject({ sessionKey, queueMode, sendAttempts: 0 });
      expect(host.request).not.toHaveBeenCalledWith("chat.send", expect.anything());
      host.sessionKey = "agent:main:another-conversation";
      host.currentSessionId = "new-pane-session";
      host.chatDisplayedLeafEntryId = "new-pane-leaf";
      host.chatRunId = null;
    } finally {
      history.resolve({ messages: [], sessionId: "source-session" });
      await loading;
      await sending;
    }
    expect(host.request).not.toHaveBeenCalledWith("chat.send", expect.anything());

    await resumeStoredChatOutboxes(host);

    const payload = findChatSendPayload(host);
    expect(payload).toMatchObject({ sessionKey, queueMode, message });
    expect(payload).not.toHaveProperty("sessionId");
    expect(payload).not.toHaveProperty("expectedLeafEntryId");
    expect(payload).not.toHaveProperty("expectedRunId");
    expect(host.currentSessionId).toBe("new-pane-session");
    expect(host.request.mock.calls.filter(([method]) => method === "chat.send")).toHaveLength(1);
  },
);
