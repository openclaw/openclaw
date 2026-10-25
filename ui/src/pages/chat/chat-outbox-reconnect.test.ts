/* @vitest-environment jsdom */
import { expect, it, onTestFinished } from "vitest";
import { listStoredChatOutboxes } from "../../lib/chat/outbox-store-projection.ts";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import { makeChatHost, requestCalls, requireRecord } from "./chat-host.test-support.ts";
import { chatOutboxOwner } from "./chat-outbox-owner.ts";
import { admitHostQueueItems } from "./chat-outbox-recovery.test-support.ts";
import { keepVolatileQueuedMessage } from "./chat-queue.ts";
import { resumeStoredChatOutboxes, retryQueuedChatMessage } from "./chat-send-actions.ts";
import { useChatSendBrowserFixture } from "./outbox-browser.test-support.ts";

useChatSendBrowserFixture();

it.each(["ready", "identity unavailable"] as const)(
  "holds an unbound attempted send until its conversation is reviewed (%s)",
  async (review) => {
    const host = makeChatHost({
      currentSessionId: "reviewed-physical-session",
      chatQueue: [
        {
          id: "unbound-attempt",
          text: "Retained input",
          createdAt: 1,
          sendRunId: "original-unbound-key",
          sendAttempts: 1,
          sendState: "waiting-reconnect",
        },
      ],
      requestHandlers: {
        "chat.send": (params: unknown) => ({
          runId: requireRecord(params, "reviewed send").idempotencyKey,
          status: "ok",
        }),
      },
    });
    const sessionKey = host.sessionKey;
    admitHostQueueItems(host);
    onTestFinished(chatOutboxOwner(host).subscribe(host));

    await resumeStoredChatOutboxes(host);

    expect(requestCalls(host.request, "chat.send")).toEqual([]);
    expect(host.chatQueue[0]).toMatchObject({
      text: "Retained input",
      sendState: "held",
      sendRunId: "original-unbound-key",
      sendAttempts: 1,
    });
    if (review !== "ready") {
      host.currentSessionId = null;
      await retryQueuedChatMessage(host, "unbound-attempt");
      expect(requestCalls(host.request, "chat.send")).toEqual([]);
      expect(listStoredChatOutboxes(host)[0]?.queue[0]?.sendState).toBe("held");
      host.sessionKey = sessionKey;
      host.currentSessionId = "reviewed-physical-session";
      chatOutboxOwner(host).syncHost(host);
    }

    await retryQueuedChatMessage(host, "unbound-attempt");

    const sends = requestCalls(host.request, "chat.send");
    expect(sends).toHaveLength(1);
    expect(sends[0]?.[1]).toMatchObject({
      sessionKey,
      sessionId: "reviewed-physical-session",
      idempotencyKey: "original-unbound-key",
      message: "Retained input",
    });
    await waitForFast(() => expect(host.chatQueue).toEqual([]));
  },
);

it("replays attempted durable and memory-only sends FIFO with their original keys", async () => {
  const host = makeChatHost({
    connected: false,
    currentSessionId: "original-physical-session",
    chatRunId: "stale-local-run",
    chatStream: "The socket missed this run's terminal event",
    chatQueue: [
      { id: "a", createdAt: 1 },
      { id: "c", createdAt: 3 },
    ].map(({ id, createdAt }) => ({
      id,
      text: `Attempted ${id}`,
      createdAt,
      sendState: "waiting-reconnect" as const,
      sendRunId: `run-${id}`,
      sessionId: "original-physical-session",
      sendAttempts: 1,
      sendRequestStartedAtMs: createdAt,
    })),
    requestHandlers: {
      "chat.send": (params: unknown) => ({
        runId: requireRecord(params, "replayed send").idempotencyKey,
        status: "in_flight",
      }),
    },
  });
  admitHostQueueItems(host);
  onTestFinished(chatOutboxOwner(host).subscribe(host));
  keepVolatileQueuedMessage(
    host,
    host.sessionKey,
    {
      id: "b",
      text: "Memory-only attempt",
      createdAt: 2,
      orderKey: 2,
      sendState: "waiting-reconnect",
      sendRunId: "run-b",
      sessionId: "original-physical-session",
      sendAttempts: 1,
      sendRequestStartedAtMs: 2,
    },
    undefined,
    { retryable: true },
  );

  await resumeStoredChatOutboxes(host);
  expect(requestCalls(host.request, "chat.send")).toEqual([]);
  expect(host.chatQueue.map((item) => item.sendState)).toEqual([
    "waiting-reconnect",
    "waiting-reconnect",
    "waiting-reconnect",
  ]);

  host.connected = true;
  host.connectionEpoch += 1;
  await resumeStoredChatOutboxes(host);

  expect(
    requestCalls(host.request, "chat.send").map(
      (call) => requireRecord(call[1], "replayed send").idempotencyKey,
    ),
  ).toEqual(["run-a", "run-b", "run-c"]);
  expect(requestCalls(host.request, "chat.history")).toEqual([]);
  expect(listStoredChatOutboxes(host)).toEqual([]);
  expect(host.chatQueue).toEqual([]);
  expect(chatOutboxOwner(host).hasVolatile(host, "b")).toBe(false);
});
