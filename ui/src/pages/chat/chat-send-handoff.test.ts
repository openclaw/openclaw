import { setImmediate as afterMicrotasks } from "node:timers/promises";
import { afterEach, assert, expect, it, onTestFinished, vi } from "vitest";
// @vitest-environment node
import { createDeferred } from "../../../../test/helpers/promise.js";
import { outboxStorageScope } from "../../lib/chat/outbox-payload-store.runtime.ts";
import type { ChatHistoryResult } from "./chat-history-snapshot.ts";
import { getChatHistoryLoadState } from "./chat-history-state.ts";
import { loadChatHistory } from "./chat-history.ts";
import * as chat from "./chat-host.test-support.ts";
import { chatOutboxOwner } from "./chat-outbox-owner.ts";
import { readQueuedMessageById } from "./chat-queue.ts";
import { handleSendChat } from "./chat-send-submit.ts";
import { chatOfflineQueueStorageError } from "./chat-send-support.ts";
import { queued } from "./chat-thread-fixtures.test-support.ts";
import { admitInitialTurnHandoff } from "./initial-turn-handoff-admission.ts";
import { prepareInitialTurnHandoff } from "./initial-turn-handoff.ts";
import { useChatSendBrowserFixture } from "./outbox-browser.test-support.ts";
import { applyChatCacheSnapshot } from "./session-message-cache.ts";

useChatSendBrowserFixture();
afterEach(() => vi.useRealTimers());

it.each(["steer", "interrupt"] as const)(
  "starts normally when initial history reveals an idle session with %s selected",
  async (followUpMode) => {
    const sessionKey = "agent:main:main";
    const history = createDeferred<ChatHistoryResult>();
    const host = chat.makeChatHost({
      sessionKey,
      chatMessage: "Start the next task",
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
      expect(host.request.mock.calls.some(([method]) => method === "chat.send")).toBe(false);
    } finally {
      history.resolve({
        messages: [],
        sessionInfo: {
          key: sessionKey,
          sessionId: "current-session",
          activeLeafEntryId: "current-leaf",
          hasActiveRun: false,
          status: "done",
          kind: "direct",
          updatedAt: 2,
        },
      });
      await loading;
      await sending;
    }
    expect(chat.findChatSendPayload(host)).not.toHaveProperty("queueMode");
    expect(host.request.mock.calls.filter(([method]) => method === "chat.send")).toHaveLength(1);
    expect(host.chatQueue).toEqual([]);
  },
);

it.each(["storage failure", "newer run"] as const)(
  "handles %s after durable admission while idle history settles",
  async (scenario) => {
    const sessionKey = "agent:main:main";
    const history = createDeferred<ChatHistoryResult>();
    const host = chat.makeChatHost({
      sessionKey,
      chatMessage: "Keep this queued message",
      requestHandlers: {
        "chat.startup": () => history.promise,
        "chat.send": { status: "in_flight", runId: "newer-run", messageSeq: 1 },
      },
    });
    applyChatCacheSnapshot(host, {
      messages: [],
      sessionId: "current-session",
      displayedLeafEntryId: "cached-leaf",
      pagination: { hasMore: false, completeSnapshot: true },
    });
    const loading = loadChatHistory(host, { startup: true, deferBranches: true });
    const sending = handleSendChat(host, undefined, { followUpMode: "steer" });
    try {
      await vi.waitFor(() => expect(host.chatQueue).toHaveLength(1));
      const id = host.chatQueue[0]!.id;
      expect(chatOutboxOwner(host).durable(host, id)?.queue).toEqual([
        expect.objectContaining({ id, queueMode: "steer", sendAttempts: 0 }),
      ]);
      expect(chat.requestCalls(host.request, "chat.send")).toEqual([]);
      if (scenario === "storage failure") {
        vi.spyOn(sessionStorage, "setItem").mockImplementation(() => {
          throw new DOMException("quota exceeded", "QuotaExceededError");
        });
      } else {
        host.chatRunId = "newer-run";
        host.chatStream = "Newer live reply";
      }
    } finally {
      history.resolve({
        messages: [],
        sessionInfo: {
          key: sessionKey,
          sessionId: "current-session",
          activeLeafEntryId: "current-leaf",
          hasActiveRun: false,
          status: "done",
          kind: "direct",
          updatedAt: 2,
        },
      });
      await loading;
      await sending;
    }
    expect(getChatHistoryLoadState(host)).toMatchObject({
      phase: "committed",
      sessionInfo: { hasActiveRun: false },
    });
    if (scenario === "storage failure") {
      expect(chat.requestCalls(host.request, "chat.send")).toEqual([]);
      expect(host.chatQueue).toEqual([
        expect.objectContaining({ text: "Keep this queued message", queueMode: "steer" }),
      ]);
      expect(host.chatError).toBe(chatOfflineQueueStorageError());
      expect(host.lastError).toBe(chatOfflineQueueStorageError());
    } else {
      expect(chat.findChatSendPayload(host)).toMatchObject({ queueMode: "steer" });
      expect(chat.requestCalls(host.request, "chat.send")).toHaveLength(1);
      expect(host.chatRunId).toBe("newer-run");
      expect(host.chatStream).toBe("Newer live reply");
    }
  },
);

it.each([false, true])("rejects cross-account handoffs (owned: %s)", async (owned) => {
  vi.useFakeTimers();
  const host = chat.makeChatHost({ requestHandlers: {}, sessionKey: "agent:main:initial-owner" });
  const client = host.client!;
  const original = client.recoveryScope;
  const scope = outboxStorageScope(host);
  prepareInitialTurnHandoff(host.sessionKey, {
    id: "private-initial",
    text: "Only account A",
    createdAt: 1,
    ...(owned ? { storageScope: scope } : {}),
  });
  const recovery = vi.spyOn(client, "recoveryScope", "get").mockReturnValue("account-b");
  expect(admitInitialTurnHandoff(host, host.sessionKey)).toBe(false);
  expect(host.chatQueue).toEqual([]);
  expect(host.chatError ?? null).toBeNull();
  recovery.mockReturnValue(original);
  expect(admitInitialTurnHandoff(host, host.sessionKey)).toBe(owned);
  expect(host.chatQueue).toEqual(
    owned ? [expect.objectContaining({ text: "Only account A", storageScope: scope })] : [],
  );
  expect(host.chatError ?? null).toBe(
    owned
      ? "Couldn’t save the previous draft. Keep this tab open or copy it before reloading."
      : null,
  );
  expect(host.lastError ?? null).toBe(host.chatError ?? null);
  expect(host.request).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(60_000);
});

it.each([
  ["followup", "in_flight"],
  [undefined, "started"],
] as const)("keeps the active reply on a %s %s custody ACK", async (queueMode, status) => {
  const acknowledgement = createDeferred<{ runId: string; status: string }>();
  const activeReply = {
    chatRunId: "active-reply",
    chatStream: "Already visible response text",
    chatStreamStartedAt: 100,
    chatStreamSegments: [{ text: "Earlier live commentary", ts: 90, itemId: "commentary" }],
    chatRunStartup: { state: "activity" as const, runId: "active-reply" },
  };
  const host = chat.makeChatHost({
    ...structuredClone(activeReply),
    chatMessage: "A follow-up",
    requestHandlers: { "chat.send": () => acknowledgement.promise },
  });
  const sending = handleSendChat(host, undefined, { followUpMode: queueMode });
  await vi.waitFor(() => chat.expectRpc(host.request, "chat.send"));
  expect(host.chatStream).toBe("Already visible response text");
  acknowledgement.resolve({ runId: "accepted-input", status });
  await sending;
  expect(host).toMatchObject(activeReply);
});

it.each([false, true])("retries only confirmed versions (edited: %s)", async (edited) => {
  const key = "agent:main:confirmed";
  const newer = "A newer unconfirmed edit";
  const history = createDeferred<ChatHistoryResult>();
  const consent = createDeferred<boolean>();
  const ownerChecked = createDeferred();
  const host = chat.makeChatHost({
    sessionKey: key,
    assistantAgentId: "main",
    currentSessionId: "s1",
    requestHandlers: {
      "chat.history": () => history.promise,
      "chat.send": { status: "started", runId: "confirmed" },
    },
  });
  onTestFinished(() => host.sessions.dispose());
  host.captureComposerRecoveryOwner = () => ({
    resolveOwner: () => {
      ownerChecked.resolve();
      return host;
    },
    retainedAttachmentIds: () => new Set(),
  });
  const item = queued("confirmed", "The message I confirmed", 1, "failed", {
    sessionKey: key,
    agentId: "main",
    storageScope: outboxStorageScope(host),
  });
  const loading = loadChatHistory(host, { deferBranches: true });
  const historyState = getChatHistoryLoadState(host);
  assert(historyState.phase === "in-flight", "Expected the pending history owner");
  prepareInitialTurnHandoff(key, item, consent.promise);
  admitInitialTurnHandoff(host, key);
  consent.resolve(true);
  await ownerChecked.promise;
  // Edit after history's version check but before the handoff resumes.
  const edit = historyState.promise.then(() => {
    if (edited) {
      chatOutboxOwner(host).change(host, item.id, (row) => ({ ...row, text: newer }), true);
    }
  });
  history.resolve({
    messages: [],
    sessionInfo: { key, sessionId: "s1", kind: "direct", activeLeafEntryId: "leaf", updatedAt: 1 },
  });
  await Promise.all([loading, edit]);
  await afterMicrotasks();
  if (edited) {
    expect(chat.requestCalls(host.request, "chat.send")).toEqual([]);
    expect(readQueuedMessageById(host, item.id)?.text).toBe(newer);
  } else {
    await vi.waitFor(() =>
      expect(chat.findChatSendPayload(host)).toMatchObject({ message: item.text }),
    );
    expect(chat.requestCalls(host.request, "chat.send")).toHaveLength(1);
  }
});
