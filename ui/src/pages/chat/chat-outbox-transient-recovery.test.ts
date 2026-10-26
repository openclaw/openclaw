/* @vitest-environment jsdom */

import { GatewayProtocolRequestTimeoutError } from "@openclaw/gateway-client/browser";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { GatewayPendingRequests } from "../../../../packages/gateway-client/src/pending-request.js";
import type { RequestFrame } from "../../../../packages/gateway-protocol/src/schema/frames.js";
import { GatewayRequestError } from "../../api/gateway-connect-errors.ts";
import type { ChatQueueItem } from "../../lib/chat/chat-types.ts";
import { listStoredChatOutboxes } from "../../lib/chat/outbox-store-projection.ts";
import { useFakeClock } from "../../test-helpers/fake-clock.ts";
import { createTestGatewayClient as clientWithRequest } from "../../test-helpers/gateway-client.ts";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import { makeChatHost, requestCalls, requireRecord } from "./chat-host.test-support.ts";
import { admitHostQueueItems, idleChatHistory } from "./chat-outbox-recovery.test-support.ts";
import { markQueuedChatSendsWaitingForReconnect } from "./chat-queue-reconnect.ts";
import { updateQueuedMessage } from "./chat-queue.ts";
import { resumeStoredChatOutboxes } from "./chat-send-actions.ts";
import { handleSendChat } from "./chat-send-submit.ts";
import { useChatSendBrowserFixture } from "./outbox-browser.test-support.ts";
useChatSendBrowserFixture();

function unavailable(message = "History is temporarily unavailable") {
  return new GatewayRequestError({
    code: "UNAVAILABLE",
    message,
    retryable: true,
    retryAfterMs: 100,
  });
}
function requestTimeout(method: string) {
  return new GatewayProtocolRequestTimeoutError({ method, timeoutMs: 30_000, requestSent: true });
}
function failStorage() {
  vi.spyOn(sessionStorage, "setItem").mockImplementation(() => {
    throw new Error("quota");
  });
}
function started(params: unknown) {
  return {
    runId: requireRecord(params, "send payload").idempotencyKey,
    status: "started",
    messageSeq: 1,
  };
}
function waitingInput(id: string, text: string, sendRunId: string): ChatQueueItem {
  return {
    id,
    text,
    sendRunId,
    createdAt: 1,
    sendState: "waiting-reconnect",
    sessionKey: "agent:main",
  };
}
function expectDrained(host: ReturnType<typeof makeChatHost>) {
  expect(host.chatQueue).toEqual([]);
  expect(listStoredChatOutboxes(host)).toStrictEqual([]);
}

describe("transient outbox delivery recovery", () => {
  it.each([undefined, "steer"] as const)(
    "parks %s delivery until Gateway work resumes",
    async (queueMode) => {
      const host = makeChatHost({
        chatMessage: "Keep this input while the Gateway is suspended",
        ...(queueMode ? { chatRunId: "active-run", chatFollowUpMode: queueMode } : {}),
        requestHandlers: {
          "chat.history": idleChatHistory(),
          "chat.send": started,
        },
      });
      host.gatewayWorkPaused = true;
      await handleSendChat(host);
      expect(requestCalls(host.request, "chat.send")).toHaveLength(0);
      expect(host.chatQueue).toHaveLength(1);
      const queuedRunId = host.chatQueue[0]?.sendRunId;
      expect(host.chatMessage).toBe("");
      await resumeStoredChatOutboxes(host);
      expect(requestCalls(host.request, "chat.history")).toHaveLength(0);
      host.gatewayWorkPaused = false;
      await resumeStoredChatOutboxes(host);
      expect(requestCalls(host.request, "chat.send")[0]?.[1]).toMatchObject({
        idempotencyKey: queuedRunId,
      });
      await resumeStoredChatOutboxes(host);
      expect(requestCalls(host.request, "chat.send")).toHaveLength(1);
    },
  );

  it.each(["durable", "volatile", "changed connection"] as const)(
    "retries a timed-out send only for its current owner (%s)",
    async (mode) => {
      const volatile = mode !== "durable";
      useFakeClock();
      if (volatile) {
        failStorage();
      }
      const send = vi
        .fn((params: unknown) => ({ runId: started(params).runId, status: "ok" }))
        .mockRejectedValueOnce(requestTimeout("chat.send"));
      const host = makeChatHost({
        sessionKey: "agent:main",
        currentSessionId: "physical-session",
        chatMessage: "Retain this input",
        requestHandlers: { "chat.send": send },
      });
      await handleSendChat(host);
      expect(host.chatQueue[0]).toMatchObject({ sendState: "waiting-reconnect", sendAttempts: 1 });
      if (volatile) {
        expect(listStoredChatOutboxes(host)).toEqual([]);
      }
      if (mode === "changed connection") {
        host.connectionEpoch += 1;
      }
      await vi.advanceTimersByTimeAsync(499);
      expect(send).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      if (mode === "changed connection") {
        expect(send).toHaveBeenCalledTimes(1);
        expect(host.chatQueue[0]?.sendState).toBe("waiting-reconnect");
        return;
      }
      await waitForFast(() => {
        expect(send).toHaveBeenCalledTimes(2);
        expect(host.chatQueue).toEqual([]);
      });
      expect(send.mock.calls[1]).toEqual(send.mock.calls[0]);
    },
  );

  it("binds a background first attempt and its replay to the physical session", async () => {
    const sessionKey = "agent:main:background";
    const attempts: Record<string, unknown>[] = [];
    const host = makeChatHost({
      currentSessionId: "unrelated-visible-session",
      chatQueue: [{ id: "background", text: "Retained input", createdAt: 1, sessionKey }],
      requestHandlers: {
        "chat.history": {
          ...idleChatHistory(sessionKey),
          sessionId: "original-background-session",
        },
        "chat.send": (params: unknown) => {
          const payload = requireRecord(params, "background send");
          attempts.push(payload);
          if (attempts.length === 1) {
            host.connected = false;
            throw requestTimeout("chat.send");
          }
          throw new GatewayRequestError({ code: "INVALID_REQUEST", message: "Session changed" });
        },
      },
    });
    admitHostQueueItems(host);
    await resumeStoredChatOutboxes(host);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({
      sessionKey,
      sessionId: "original-background-session",
      expectedLeafEntryId: null,
    });
    expect(listStoredChatOutboxes(host)[0]?.queue[0]).toMatchObject({
      sessionId: "original-background-session",
      sendState: "waiting-reconnect",
    });
    host.currentSessionId = "replacement-visible-session";
    host.connected = true;
    host.connectionEpoch += 1;
    await resumeStoredChatOutboxes(host);
    expect(attempts).toEqual([attempts[0], attempts[0]]);
    expect(listStoredChatOutboxes(host)[0]?.queue[0]).toMatchObject({
      sendState: "failed",
      sendError: "Session changed",
    });
  });

  it.each(["started", "in_flight", "ok", "rejected"] as const)(
    "keeps a written frame pending and replays its original key after reconnect (%s)",
    async (outcome) => {
      const frames: RequestFrame[] = [];
      const issued = Promise.withResolvers<void>();
      const pending = new GatewayPendingRequests({
        createRequestId: () => "transport-request",
        createRequestError: (error) =>
          new GatewayRequestError({
            ...error,
            code: error.code ?? "UNAVAILABLE",
            message: error.message ?? "Request failed",
          }),
        nowMs: Date.now,
      });
      onTestFinished(() => pending.flush(new Error("test request owner disposed")));
      const wire = {
        send: (raw: string) => {
          const frame = JSON.parse(raw) as RequestFrame;
          frames.push(frame);
          if (frames.length === 1) {
            issued.resolve();
            return;
          }
          const runId = requireRecord(frame.params, "replayed frame").idempotencyKey;
          pending.handleResponse({
            type: "res",
            id: frame.id,
            ok: outcome !== "rejected",
            ...(outcome === "rejected"
              ? { error: { code: "INVALID_REQUEST", message: "Synthetic rejection" } }
              : { payload: { runId, status: outcome } }),
          });
        },
      };
      const host = makeChatHost({
        client: clientWithRequest((method, params, options) => {
          return method === "chat.send"
            ? pending.request(wire, method, params, options)
            : Promise.resolve(idleChatHistory());
        }),
        chatMessage: "Keep the original submission",
        currentSessionId: "original-physical-session",
      });
      const sending = handleSendChat(host);
      await issued.promise;
      const original = requireRecord(frames[0]!.params, "written frame");
      host.connected = false;
      markQueuedChatSendsWaitingForReconnect(host);
      pending.flush(new Error("gateway closed (1006): network lost"));
      await sending;
      expect(host.chatQueue[0]).toMatchObject({
        sendState: "waiting-reconnect",
        sendAttempts: 1,
        sendRunId: original.idempotencyKey,
      });
      expect(listStoredChatOutboxes(host)[0]?.queue[0]?.sendState).toBe("waiting-reconnect");
      host.chatMessage = "Newer draft";
      host.currentSessionId = "replacement-physical-session";
      host.connected = true;
      host.connectionEpoch += 1;
      await resumeStoredChatOutboxes(host);
      expect(frames[1]?.params).toEqual(frames[0]?.params);
      expect(frames[1]?.params).toMatchObject({ sessionId: "original-physical-session" });
      expect(host.chatMessage).toBe("Newer draft");
      if (outcome === "rejected") {
        expect(host.chatQueue[0]).toMatchObject({
          sendState: "failed",
          sendError: "Synthetic rejection",
        });
      } else {
        expectDrained(host);
      }
    },
  );

  it.each([
    ["backoff", false],
    ["backoff", true],
    ["reconnect", false],
    ["reconnect", true],
    ["suspension", false],
    ["suspension", true],
  ] as const)(
    "retries a retryable send rejection after %s (volatile=%s)",
    async (trigger, volatile) => {
      if (volatile) {
        failStorage();
      }
      const rejection =
        trigger === "suspension"
          ? new GatewayRequestError({
              code: "UNAVAILABLE",
              message: "chat.send unavailable during gateway suspension",
              retryable: true,
              retryAfterMs: 100,
              details: { reason: "gateway-suspending" },
            })
          : unavailable("Gateway is temporarily busy");
      const send = vi.fn(started).mockRejectedValueOnce(rejection);
      const host = makeChatHost({
        requestHandlers: {
          "chat.history": idleChatHistory(),
          "chat.send": send,
        },
        chatMessage: "retry without disconnecting",
      });

      useFakeClock();
      await handleSendChat(host);

      expect(host).toMatchObject({
        connected: true,
        chatMessage: "",
        chatQueue: [expect.objectContaining({ sendAttempts: 0, sendState: "waiting-reconnect" })],
      });
      expect(send).toHaveBeenCalledTimes(1);
      if (trigger === "suspension") {
        expect(host.chatQueue[0]?.sendError).toBeUndefined();
        expect(host.chatError).toBeNull();
        host.gatewayWorkPaused = true;
        await vi.advanceTimersByTimeAsync(100);
        expect(send).toHaveBeenCalledTimes(1);
        host.gatewayWorkPaused = false;
        await resumeStoredChatOutboxes(host);
      } else if (trigger === "reconnect") {
        host.connectionEpoch += 1;
        await resumeStoredChatOutboxes(host);
      } else {
        await vi.advanceTimersByTimeAsync(100);
        // The timer starts a fire-and-forget drain; join its observable outcome.
        await waitForFast(() => {
          expect(send).toHaveBeenCalledTimes(2);
          expect(listStoredChatOutboxes(host)).toStrictEqual([]);
        });
      }
      expect(send).toHaveBeenCalledTimes(2);
      expectDrained(host);
      expect(send.mock.calls[1]).toEqual(send.mock.calls[0]);
    },
  );

  it.each(["response", "timeout"])(
    "retries reconnect history after a retryable %s without a socket close",
    async (failure) => {
      const history = vi
        .fn(() => idleChatHistory())
        .mockRejectedValueOnce(
          failure === "timeout" ? requestTimeout("chat.history") : unavailable(),
        );
      const send = vi.fn(started);
      const host = makeChatHost({
        chatQueue: [waitingInput("history-retry", "retry history", "history-retry-run")],
        requestHandlers: { "chat.history": history, "chat.send": send },
      });
      admitHostQueueItems(host);
      useFakeClock();
      await resumeStoredChatOutboxes(host);

      expect(history).toHaveBeenCalledTimes(1);
      expect(send).not.toHaveBeenCalled();
      await Promise.all(Array.from({ length: 20 }, () => resumeStoredChatOutboxes(host)));
      expect(history).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(failure === "timeout" ? 500 : 100);
      await waitForFast(() => {
        expect(send).toHaveBeenCalledTimes(1);
        expect(history.mock.calls.length).toBeGreaterThanOrEqual(2);
        expect(listStoredChatOutboxes(host)).toStrictEqual([]);
      });
    },
  );

  it("does not apply a stale readiness rejection to an edited queued input", async () => {
    const historyStarted = Promise.withResolvers<void>();
    const firstHistory = Promise.withResolvers<ReturnType<typeof idleChatHistory>>();
    const send = vi.fn(started);
    const history = vi
      .fn(async () => idleChatHistory())
      .mockImplementationOnce(async () => {
        historyStarted.resolve();
        return firstHistory.promise;
      });
    const host = makeChatHost({
      chatQueue: [waitingInput("edited-during-readiness", "Original draft", "original-submission")],
      requestHandlers: {
        "chat.history": history,
        "chat.send": send,
      },
    });
    admitHostQueueItems(host);
    const draining = resumeStoredChatOutboxes(host);
    try {
      await historyStarted.promise;
      updateQueuedMessage(host, "edited-during-readiness", (item) => ({
        ...item,
        text: "Revised draft",
        sendRunId: "revised-submission",
      }));
      firstHistory.reject(
        new GatewayRequestError({
          code: "INVALID_REQUEST",
          message: "Rejection for the original draft",
        }),
      );
      await draining;
      expect(send).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ message: "Revised draft", idempotencyKey: "revised-submission" }),
      );
      expect(host.lastError).toBeNull();
      expect(listStoredChatOutboxes(host)).toEqual([]);
    } finally {
      firstHistory.resolve(idleChatHistory());
      await draining;
    }
  });

  it("transfers an active retry backoff to a sibling pane without bypassing it", async () => {
    const history = vi.fn().mockRejectedValue(unavailable());
    const owner = makeChatHost({
      connectionEpoch: 1,
      requestHandlers: {
        "chat.history": history,
      },
      chatQueue: [waitingInput("shared-retry", "wait for backoff", "shared-retry-run")],
    });
    admitHostQueueItems(owner);
    const sibling = makeChatHost({
      client: owner.client,
      connectionEpoch: 2,
      chatQueue: owner.chatQueue,
    });

    useFakeClock();
    await resumeStoredChatOutboxes(owner);
    owner.sessionKey = "agent:main:other";
    await resumeStoredChatOutboxes(sibling);
    expect(history).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(100);
    await waitForFast(() => expect(history).toHaveBeenCalledTimes(2));
  });
});
