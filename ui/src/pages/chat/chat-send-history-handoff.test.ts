// @vitest-environment node
import { expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { ChatHistoryResult } from "./chat-history-snapshot.ts";
import { loadChatHistory } from "./chat-history.ts";
import { findChatSendPayload, makeChatHost, requestCalls } from "./chat-host.test-support.ts";
import { resumeStoredChatOutboxes as drain } from "./chat-send-actions.ts";
import { handleSendChat } from "./chat-send-submit.ts";
import { useChatSendBrowserFixture } from "./outbox-browser.test-support.ts";
useChatSendBrowserFixture();
function pendingHistory(active: boolean, overrides: Parameters<typeof makeChatHost>[0] = {}) {
  const history = createDeferred<ChatHistoryResult>();
  const result: ChatHistoryResult = {
    messages: [],
    sessionInfo: {
      key: "agent:main:main",
      activeLeafEntryId: active ? "active-leaf" : "held-enter-terminal",
      kind: "direct",
      updatedAt: 1,
      sessionId: "current-session",
      hasActiveRun: active,
      status: active ? "running" : "done",
      ...(active ? { activeRunIds: ["active"] } : {}),
    },
  };
  let reads = 0;
  const host = makeChatHost({
    sessionKey: "agent:main:main",
    currentSessionId: "current-session",
    ...(active ? { chatRunId: "active", chatMessage: "Steer" } : {}),
    ...overrides,
    requestHandlers: {
      "chat.history": () => (active && ++reads > 1 ? result : history.promise),
      "chat.send": active ? { status: "in_flight", runId: "steer-input" } : { status: "started" },
    },
  });
  return { history, result, host, loading: loadChatHistory(host, { deferBranches: true }) };
}
it("holds attachments across history settlement", async () => {
  const dataUrl = "data:text/plain;base64,aGVsbG8=";
  const { history, result, host, loading } = pendingHistory(false, {
    chatDisplayedLeafEntryId: "previous-leaf",
    chatAttachments: [{ id: "f", fileName: "a", mimeType: "text/plain", dataUrl, origin: "file" }],
  });
  const channel = new MessageChannel();
  const release = channel.port2.postMessage.bind(channel.port2);

  const postInput = vi.spyOn(channel.port2, "postMessage").mockImplementation(() => undefined);
  vi.spyOn(globalThis, "MessageChannel").mockImplementationOnce(function () {
    return channel;
  });
  const sending = handleSendChat(host, undefined, undefined, new Event("submit"));
  let runId: string | undefined;
  try {
    await vi.waitFor(() => expect(host.chatQueue).toHaveLength(1));
    expect(postInput).toHaveBeenCalledOnce();
    expect(requestCalls(host.request, "chat.send")).toHaveLength(0);
    runId = host.chatQueue[0]!.sendRunId;
    expect(runId).toBeTypeOf("string");
    expect(requestCalls(host.request, "chat.history")).toHaveLength(1);
    history.resolve(result);
    await loading;
    await Promise.all([host, { ...host, chatQueue: [] }].map((owner) => drain(owner)));
    expect(requestCalls(host.request, "chat.send")).toHaveLength(0);
  } finally {
    history.resolve(result);
    release(undefined);
    await sending;
    [channel.port1, channel.port2].forEach((port) => port.close());
  }
  expect(requestCalls(host.request, "chat.send")).toHaveLength(1);
  expect(findChatSendPayload(host)).toMatchObject({
    expectedLeafEntryId: "held-enter-terminal",
    idempotencyKey: runId,
    message: "",
    attachments: [expect.objectContaining({ fileName: "a", content: "aGVsbG8=" })],
  });
});

it.each([false, true])("steers after superseded history (refresh first: %s)", async (first) => {
  const admitted = createDeferred();
  const { history, result, host, loading } = pendingHistory(true);
  const { sessionKey } = host;
  let refresh = first
    ? loadChatHistory(host, { supersedeInFlight: true, deferBranches: true })
    : undefined;
  const sending = handleSendChat(host, undefined, {
    followUpMode: "steer",
    onOutboxAdmitted: () => admitted.resolve(),
  });
  try {
    await admitted.promise;
    expect(requestCalls(host.request, "chat.send")).toHaveLength(0);
    if (!first) {
      refresh = loadChatHistory(host, { supersedeInFlight: true, deferBranches: true });
    }
    history.resolve({
      ...result,
      sessionInfo: { ...result.sessionInfo!, activeLeafEntryId: "stale-leaf" },
    });
    await Promise.all([loading, refresh, sending]);
    expect(requestCalls(host.request, "chat.history")).toHaveLength(2);
    expect(host).toMatchObject({ chatDisplayedLeafEntryId: "active-leaf", chatRunId: "active" });
    expect(requestCalls(host.request, "chat.send")).toHaveLength(1);
    const expectedInput = { sessionKey, message: "Steer", queueMode: "steer" };
    expect(findChatSendPayload(host)).toMatchObject(expectedInput);
  } finally {
    history.resolve(result);
    await Promise.all([loading, refresh, sending]);
    host.sessions.dispose();
  }
});
