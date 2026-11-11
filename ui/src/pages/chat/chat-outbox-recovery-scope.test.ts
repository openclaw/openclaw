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

function reopen(host: ReturnType<typeof makeChatHost>, connectionEpoch = host.connectionEpoch) {
  const reopened = makeChatHost({
    client: host.client,
    connected: true,
    sessionKey: host.sessionKey,
    currentSessionId: host.currentSessionId,
    connectionEpoch,
  });
  onTestFinished(chatOutboxOwner(reopened).subscribe(reopened));
  return reopened;
}
function sendingHost(chatMessage: string, send: (params: unknown) => unknown) {
  vi.useFakeTimers();
  onTestFinished(() => {
    vi.useRealTimers();
  });
  vi.spyOn(sessionStorage, "setItem").mockImplementation(() => {
    throw new Error("quota");
  });
  const host = makeChatHost({
    sessionKey: "agent:main:retained",
    currentSessionId: "original-physical-session",
    chatMessage,
    requestHandlers: { "chat.send": send },
  });
  const unsubscribe = chatOutboxOwner(host).subscribe(host);
  onTestFinished(unsubscribe);
  return { host, unsubscribe };
}

async function retainMemoryOnlySend() {
  let attempts = 0;
  const { host, unsubscribe } = sendingHost("Synthetic retained input", (params) => {
    if (++attempts === 1) {
      host.connected = false;
      throw new GatewayProtocolRequestTimeoutError({
        method: "chat.send",
        timeoutMs: 30_000,
        requestSent: true,
      });
    }
    return { runId: requireRecord(params, "replayed send").idempotencyKey, status: "ok" };
  });
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

it.each(["retained", "recreated"] as const)(
  "replays a memory-only send after recovery in a %s pane",
  async (pane) => {
    const { host, firstSend, unsubscribe } = await retainMemoryOnlySend();
    if (pane === "recreated") {
      unsubscribe();
    }
    const target = pane === "recreated" ? reopen(host) : host;
    const recoveryReady = vi.spyOn(host.client!, "recoveryScopeReady", "get");
    target.connectionEpoch += 1;
    target.connected = true;
    expect(target.chatQueue).toMatchObject([
      { text: "Synthetic retained input", sendState: "waiting-reconnect" },
    ]);
    recoveryReady.mockReturnValue(false);
    await resumeStoredChatOutboxes(target);
    expect(requestCalls(host.request, "chat.send")).toHaveLength(1);
    recoveryReady.mockReturnValue(true);
    await resumeStoredChatOutboxes(target);

    const sends = requestCalls(host.request, "chat.send");
    expect(sends).toHaveLength(2);
    expect(sends[1]?.[1]).toEqual(firstSend);
    expect(target.chatQueue).toEqual([]);
  },
);

it.each(["acknowledged", "rejected"] as const)(
  "publishes a late %s memory-only send to its recreated pane",
  async (outcome) => {
    const response = Promise.withResolvers<unknown>();
    const started = Promise.withResolvers<string>();
    const { host, unsubscribe } = sendingHost("Synthetic in-flight input", (params) => {
      const runId = String(requireRecord(params, "original send").idempotencyKey);
      started.resolve(runId);
      return response.promise;
    });
    const sending = handleSendChat(host);
    const runId = await started.promise;
    chatOutboxOwner(host).admissions.cancelRequests(host);
    unsubscribe();
    const reopened = reopen(host);

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

      expect(reopened.chatQueue).toMatchObject(
        outcome === "rejected"
          ? [
              {
                text: "Synthetic in-flight input",
                sendState: "failed",
                sendError: "Rejected input",
              },
            ]
          : [],
      );
    } finally {
      response.resolve({ runId, status: "ok", messageSeq: 1 });
      await sending;
    }
  },
);
