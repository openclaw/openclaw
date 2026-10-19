// @vitest-environment node
import { expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { ChatHistoryResult } from "./chat-history-snapshot.ts";
import { loadChatHistory } from "./chat-history.ts";
import { findChatSendPayload, makeChatHost } from "./chat-host.test-support.ts";
import { resumeStoredChatOutboxes } from "./chat-send-actions.ts";
import { handleSendChat } from "./chat-send-submit.ts";
import { useChatSendBrowserFixture } from "./outbox-browser.test-support.ts";
useChatSendBrowserFixture();
it("retains foreground attachment custody when history settles during the input handoff", async () => {
  const history = createDeferred<ChatHistoryResult>();
  const result: ChatHistoryResult = {
    messages: [],
    sessionId: "current-session",
    sessionInfo: {
      key: "agent:main:main",
      kind: "direct",
      updatedAt: 1,
      sessionId: "current-session",
      activeLeafEntryId: "held-enter-terminal",
      hasActiveRun: false,
      status: "done",
    },
  };
  const host = makeChatHost({
    sessionKey: "agent:main:main",
    currentSessionId: "current-session",
    chatDisplayedLeafEntryId: "previous-leaf",
    chatMessage: "",
    chatAttachments: [
      {
        id: "file",
        fileName: "held-enter.txt",
        mimeType: "text/plain",
        dataUrl: "data:text/plain;base64,aGVsbG8=",
        origin: "file",
      },
    ],
    requestHandlers: { "chat.history": () => history.promise, "chat.send": { status: "started" } },
  });
  const loading = loadChatHistory(host, { deferBranches: true });
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
    expect(host.chatQueue).toHaveLength(1);
    expect(postInput).toHaveBeenCalledOnce();
    expect(host.request.mock.calls.some(([method]) => method === "chat.send")).toBe(false);
    runId = host.chatQueue[0]!.sendRunId;
    expect(runId).toBeTypeOf("string");
    expect(host.request.mock.calls.filter(([method]) => method === "chat.history")).toHaveLength(1);
    history.resolve(result);
    await loading;
    await Promise.all([
      resumeStoredChatOutboxes(host),
      resumeStoredChatOutboxes({ ...host, chatQueue: [] }),
    ]);
    // Main now retains this admission in the shared outbox owner. Neither
    // history settlement nor a passive drain may deliver before input resumes.
    expect(host.request.mock.calls.some(([method]) => method === "chat.send")).toBe(false);
  } finally {
    history.resolve(result);
    release(undefined);
    await sending;
    channel.port1.close();
    channel.port2.close();
  }
  expect(host.request.mock.calls.filter(([method]) => method === "chat.send")).toHaveLength(1);
  expect(findChatSendPayload(host)).toMatchObject({
    expectedLeafEntryId: "held-enter-terminal",
    idempotencyKey: runId,
    message: "",
    attachments: [expect.objectContaining({ fileName: "held-enter.txt", content: "aGVsbG8=" })],
  });
});

it.each([false, true])(
  "delivers steering across superseded history (refresh before send: %s)",
  async (refreshBeforeSend) => {
    const history = createDeferred<ChatHistoryResult>();
    const admitted = createDeferred();
    const sessionKey = "agent:main:history-steer";
    const result: ChatHistoryResult = {
      messages: [],
      sessionInfo: {
        key: sessionKey,
        kind: "direct",
        updatedAt: 1,
        sessionId: "current-session",
        activeLeafEntryId: "active-leaf",
        hasActiveRun: true,
        status: "running",
        activeRunIds: ["active-run"],
      },
    };
    let reads = 0;
    const host = makeChatHost({
      sessionKey,
      currentSessionId: "current-session",
      chatRunId: "active-run",
      chatMessage: "Correct the active reply",
      requestHandlers: {
        "chat.history": () => (++reads === 1 ? history.promise : result),
        "chat.send": { status: "in_flight", runId: "steer-input" },
      },
    });
    const loading = loadChatHistory(host, { deferBranches: true });
    // A live event invalidates the raw read and queues a replacement snapshot.
    let refresh = refreshBeforeSend
      ? loadChatHistory(host, { supersedeInFlight: true, deferBranches: true })
      : undefined;
    const sending = handleSendChat(host, undefined, {
      followUpMode: "steer",
      onOutboxAdmitted: () => admitted.resolve(),
    });
    try {
      await admitted.promise;
      expect(host.request.mock.calls.some(([method]) => method === "chat.send")).toBe(false);
      if (!refreshBeforeSend) {
        refresh = loadChatHistory(host, { supersedeInFlight: true, deferBranches: true });
      }
      history.resolve({
        ...result,
        sessionInfo: { ...result.sessionInfo!, activeLeafEntryId: "stale-leaf" },
      });
      await Promise.all([loading, refresh, sending]);
      expect(reads).toBe(2);
      expect(host.chatDisplayedLeafEntryId).toBe("active-leaf");
      expect(host.request.mock.calls.filter(([method]) => method === "chat.send")).toHaveLength(1);
      expect(findChatSendPayload(host)).toMatchObject({
        sessionKey,
        message: "Correct the active reply",
        queueMode: "steer",
      });
      expect(host.chatRunId).toBe("active-run");
    } finally {
      history.resolve(result);
      await Promise.all([loading, refresh, sending]);
      host.sessions.dispose();
    }
  },
);
