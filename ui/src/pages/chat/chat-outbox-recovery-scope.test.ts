/* @vitest-environment jsdom */
import { GatewayProtocolRequestTimeoutError } from "@openclaw/gateway-client/browser";
import { expect, it, onTestFinished, vi } from "vitest";
import { GatewayRequestError } from "../../api/gateway-connect-errors.ts";
import { listStoredChatOutboxes } from "../../lib/chat/outbox-store-projection.ts";
import { makeChatHost, requestCalls, requireRecord } from "./chat-host.test-support.ts";
import { chatOutboxOwner } from "./chat-outbox-owner.ts";
import { markQueuedChatSendsWaitingForReconnect } from "./chat-queue-reconnect.ts";
import { resumeStoredChatOutboxes } from "./chat-send-actions.ts";
import { handleSendChat } from "./chat-send-submit.ts";
import { useChatSendBrowserFixture } from "./outbox-browser.test-support.ts";

useChatSendBrowserFixture();

function useMemoryOnlyStorage() {
  vi.useFakeTimers();
  onTestFinished(() => {
    vi.useRealTimers();
  });
  vi.spyOn(sessionStorage, "setItem").mockImplementation(() => {
    throw new Error("quota");
  });
}

async function retainMemoryOnlySend() {
  useMemoryOnlyStorage();
  let attempts = 0;
  const host = makeChatHost({
    sessionKey: "agent:main:retained",
    currentSessionId: "original-physical-session",
    chatMessage: "Synthetic retained input",
    requestHandlers: {
      "chat.send": (params: unknown) => {
        if (++attempts === 1) {
          host.connected = false;
          throw new GatewayProtocolRequestTimeoutError({
            method: "chat.send",
            timeoutMs: 30_000,
            requestSent: true,
          });
        }
        return { runId: requireRecord(params, "replayed send").idempotencyKey, status: "ok" };
      },
    },
  });
  const unsubscribe = chatOutboxOwner(host).subscribe(host);
  onTestFinished(unsubscribe);
  await handleSendChat(host);
  markQueuedChatSendsWaitingForReconnect(host);
  const firstSend = requestCalls(host.request, "chat.send")[0]?.[1];
  expect(firstSend).toMatchObject({
    message: "Synthetic retained input",
    sessionId: "original-physical-session",
  });
  expect(listStoredChatOutboxes(host)).toEqual([]);
  expect(host.chatQueue[0]).toMatchObject({ sendState: "waiting-reconnect", sendAttempts: 1 });
  return { host, firstSend, unsubscribe };
}

it.each([false, true])(
  "replays a memory-only send after same-account recovery (intermediate hello=%s)",
  async (intermediateHello) => {
    const { host, firstSend } = await retainMemoryOnlySend();
    const recoveryReady = vi.spyOn(host.client!, "recoveryScopeReady", "get");
    host.connectionEpoch += 1;
    host.connected = true;
    if (intermediateHello) {
      recoveryReady.mockReturnValue(false);
      await resumeStoredChatOutboxes(host);
      expect(requestCalls(host.request, "chat.send")).toHaveLength(1);
    }
    recoveryReady.mockReturnValue(true);
    await resumeStoredChatOutboxes(host);

    const sends = requestCalls(host.request, "chat.send");
    expect(sends).toHaveLength(2);
    expect(sends[1]?.[1]).toEqual(firstSend);
    expect(host.chatQueue).toEqual([]);
  },
);

it("replays a memory-only send after its conversation pane is recreated", async () => {
  const { host, firstSend, unsubscribe } = await retainMemoryOnlySend();
  unsubscribe();
  const reopened = makeChatHost({
    client: host.client,
    connected: true,
    sessionKey: host.sessionKey,
    currentSessionId: host.currentSessionId,
    connectionEpoch: host.connectionEpoch + 1,
  });
  onTestFinished(chatOutboxOwner(reopened).subscribe(reopened));

  expect(reopened.chatQueue).toMatchObject([
    { text: "Synthetic retained input", sendState: "waiting-reconnect" },
  ]);
  await resumeStoredChatOutboxes(reopened);

  const sends = requestCalls(host.request, "chat.send");
  expect(sends).toHaveLength(2);
  expect(sends[1]?.[1]).toEqual(firstSend);
  expect(reopened.chatQueue).toEqual([]);
});

it.each(["acknowledged", "rejected"] as const)(
  "publishes a late %s memory-only send to its recreated pane",
  async (outcome) => {
    useMemoryOnlyStorage();
    const response = Promise.withResolvers<unknown>();
    const started = Promise.withResolvers<string>();
    const host = makeChatHost({
      sessionKey: "agent:main:retained",
      currentSessionId: "original-physical-session",
      chatMessage: "Synthetic in-flight input",
      requestHandlers: {
        "chat.send": (params: unknown) => {
          const runId = String(requireRecord(params, "original send").idempotencyKey);
          started.resolve(runId);
          return response.promise;
        },
      },
    });
    const unsubscribe = chatOutboxOwner(host).subscribe(host);
    onTestFinished(unsubscribe);
    const sending = handleSendChat(host);
    const runId = await started.promise;
    chatOutboxOwner(host).admissions.cancelRequests(host);
    unsubscribe();
    const reopened = makeChatHost({
      client: host.client,
      connected: true,
      sessionKey: host.sessionKey,
      currentSessionId: host.currentSessionId,
      connectionEpoch: host.connectionEpoch,
    });
    onTestFinished(chatOutboxOwner(reopened).subscribe(reopened));

    try {
      expect(reopened.chatQueue).toMatchObject([
        { text: "Synthetic in-flight input", sendState: "sending" },
      ]);
      if (outcome === "rejected") {
        response.reject(
          new GatewayRequestError({ code: "INVALID_REQUEST", message: "Rejected input" }),
        );
      } else {
        response.resolve({ runId, status: "ok", messageSeq: 1 });
      }
      await sending;

      if (outcome === "rejected") {
        expect(reopened.chatQueue).toMatchObject([
          { text: "Synthetic in-flight input", sendState: "failed", sendError: "Rejected input" },
        ]);
      } else {
        expect(reopened.chatQueue).toEqual([]);
      }
    } finally {
      response.resolve({ runId, status: "ok", messageSeq: 1 });
      await sending;
    }
  },
);
