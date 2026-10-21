import { setImmediate as afterMicrotasks } from "node:timers/promises";
import { afterEach, assert, expect, it, onTestFinished, vi } from "vitest";
// @vitest-environment node
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { ChatQueueItem } from "../../lib/chat/chat-types.ts";
import { outboxStorageScope } from "../../lib/chat/outbox-payload-store.runtime.ts";
import type { ChatHistoryResult } from "./chat-history-snapshot.ts";
import { getChatHistoryLoadState } from "./chat-history-state.ts";
import { loadChatHistory } from "./chat-history.ts";
import * as chat from "./chat-host.test-support.ts";
import { chatOutboxOwner } from "./chat-outbox-owner.ts";
import { readQueuedMessageById } from "./chat-queue.ts";
import { handleSendChat } from "./chat-send-submit.ts";
import { admitInitialTurnHandoff } from "./initial-turn-handoff-admission.ts";
import { prepareInitialTurnHandoff } from "./initial-turn-handoff.ts";
import { useChatSendBrowserFixture } from "./outbox-browser.test-support.ts";

useChatSendBrowserFixture();
afterEach(() => vi.useRealTimers());

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
  recovery.mockReturnValue(original);
  expect(admitInitialTurnHandoff(host, host.sessionKey)).toBe(owned);
  expect(host.chatQueue).toEqual(
    owned ? [expect.objectContaining({ text: "Only account A", storageScope: scope })] : [],
  );
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
  const item: ChatQueueItem = {
    id: "confirmed",
    text: "The message I confirmed",
    createdAt: 1,
    sessionKey: key,
    agentId: "main",
    sendState: "failed",
    storageScope: outboxStorageScope(host),
  };
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
