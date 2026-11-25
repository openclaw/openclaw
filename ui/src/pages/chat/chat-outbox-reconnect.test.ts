/* @vitest-environment jsdom */
import { expect, it, onTestFinished } from "vitest";
import type { ChatQueueItem } from "../../lib/chat/chat-types.ts";
import { listStoredChatOutboxes } from "../../lib/chat/outbox-store-projection.ts";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import { makeChatHost, requestCalls, requireRecord } from "./chat-host.test-support.ts";
import { chatOutboxOwner } from "./chat-outbox-owner.ts";
import { admitHostQueueItems } from "./chat-outbox-recovery.test-support.ts";
import { keepVolatileQueuedMessage } from "./chat-queue.ts";
import { resumeStoredChatOutboxes, retryQueuedChatMessage } from "./chat-send-actions.ts";
import { queued } from "./chat-thread-fixtures.test-support.ts";
import { useChatSendBrowserFixture } from "./outbox-browser.test-support.ts";

useChatSendBrowserFixture();

const ack = (status: string) => (params: unknown) => ({
  runId: requireRecord(params, "send").idempotencyKey,
  status,
});

it("holds unbound attempted sends until review has a conversation identity", async () => {
  const host = makeChatHost({
    currentSessionId: "reviewed-physical-session",
    chatQueue: [
      queued("unbound-attempt", "Retained input", 1, "waiting-reconnect", {
        sendRunId: "original-unbound-key",
        sendAttempts: 1,
      }),
    ],
    requestHandlers: { "chat.send": ack("ok") },
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
  host.currentSessionId = null;
  await retryQueuedChatMessage(host, "unbound-attempt");
  expect(requestCalls(host.request, "chat.send")).toEqual([]);
  expect(listStoredChatOutboxes(host)[0]?.queue[0]?.sendState).toBe("held");
  host.currentSessionId = "reviewed-physical-session";
  chatOutboxOwner(host).syncHost(host);

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
});

it("replays attempted durable and memory-only sends FIFO with their original keys", async () => {
  const attempted = (id: string, createdAt: number, text = `Attempted ${id}`): ChatQueueItem => ({
    id,
    text,
    createdAt,
    sendState: "waiting-reconnect",
    sendRunId: `run-${id}`,
    sessionId: "original-physical-session",
    sendAttempts: 1,
    sendRequestStartedAtMs: createdAt,
  });
  const host = makeChatHost({
    connected: false,
    currentSessionId: "original-physical-session",
    chatRunId: "stale-local-run",
    chatStream: "The socket missed this run's terminal event",
    chatQueue: [attempted("a", 1), attempted("c", 3)],
    requestHandlers: { "chat.send": ack("in_flight") },
  });
  admitHostQueueItems(host);
  onTestFinished(chatOutboxOwner(host).subscribe(host));
  keepVolatileQueuedMessage(
    host,
    host.sessionKey,
    { ...attempted("b", 2, "Memory-only attempt"), orderKey: 2 },
    undefined,
    { retryable: true },
  );

  await resumeStoredChatOutboxes(host);
  expect(requestCalls(host.request, "chat.send")).toEqual([]);

  host.connected = true;
  host.connectionEpoch += 1;
  await resumeStoredChatOutboxes(host);

  expect(
    requestCalls(host.request, "chat.send").map(
      (call) => requireRecord(call[1], "replayed send").idempotencyKey,
    ),
  ).toEqual(["run-a", "run-b", "run-c"]);
  expect(listStoredChatOutboxes(host)).toEqual([]);
  expect(host.chatQueue).toEqual([]);
  expect(chatOutboxOwner(host).hasVolatile(host, "b")).toBe(false);
});
