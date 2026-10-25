/* @vitest-environment jsdom */
import { GatewayProtocolRequestTimeoutError } from "@openclaw/gateway-client/browser";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { GatewayPendingRequests } from "../../../../packages/gateway-client/src/pending-request.js";
import type { RequestFrame } from "../../../../packages/gateway-protocol/src/schema/frames.js";
import { GatewayRequestError } from "../../api/gateway.ts";
import { listStoredChatOutboxes } from "../../lib/chat/outbox-store-projection.ts";
import { createTestGatewayClient as clientWithRequest } from "../../test-helpers/gateway-client.ts";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import {
  makeChatHost,
  makeRequestMock,
  requestCalls,
  requireRecord,
} from "./chat-host.test-support.ts";
import { admitHostQueueItems, idleChatHistory } from "./chat-outbox-recovery.test-support.ts";
import { markQueuedChatSendsWaitingForReconnect } from "./chat-queue-reconnect.ts";
import { updateQueuedMessage } from "./chat-queue.ts";
import { resumeStoredChatOutboxes } from "./chat-send-actions.ts";
import { handleSendChat } from "./chat-send-submit.ts";
import { useChatSendBrowserFixture } from "./outbox-browser.test-support.ts";
useChatSendBrowserFixture();

function useFakeClock() {
  vi.useFakeTimers();
  onTestFinished(() => {
    vi.useRealTimers();
  });
}
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

describe("transient outbox delivery recovery", () => {
  it.each([undefined, "steer"] as const)(
    "parks %s delivery until Gateway work resumes",
    async (queueMode) => {
      const host = makeChatHost({
        chatMessage: "Keep this input while the Gateway is suspended",
        ...(queueMode ? { chatRunId: "active-run", chatFollowUpMode: queueMode } : {}),
        requestHandlers: {
          "chat.history": idleChatHistory(),
          "chat.send": (params: unknown) => ({
            runId: requireRecord(params, "resumed payload").idempotencyKey,
            status: "started",
            messageSeq: 1,
          }),
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
      expect(requestCalls(host.request, "chat.send")).toHaveLength(1);
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
        vi.spyOn(sessionStorage, "setItem").mockImplementation(() => {
          throw new Error("quota");
        });
      }
      const sends: unknown[] = [];
      const host = makeChatHost({
        sessionKey: "agent:main",
        currentSessionId: "physical-session",
        chatMessage: "Retain this input",
        requestHandlers: {
          "chat.send": (params: unknown) => {
            sends.push(params);
            if (sends.length === 1) {
              throw requestTimeout("chat.send");
            }
            return { runId: requireRecord(params, "retry").idempotencyKey, status: "ok" };
          },
        },
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
      expect(sends).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);
      if (mode === "changed connection") {
        expect(sends).toHaveLength(1);
        expect(host.chatQueue[0]?.sendState).toBe("waiting-reconnect");
        return;
      }
      await waitForFast(() => {
        expect(sends).toHaveLength(2);
        expect(host.chatQueue).toEqual([]);
      });
      expect(sends[1]).toEqual(sends[0]);
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
          expect(methods).toEqual(["chat.send", "chat.send"]);
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
      const methods: string[] = [];
      const host = makeChatHost({
        client: clientWithRequest((method, params, options) => {
          methods.push(method);
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
        expect(host.chatQueue).toEqual([]);
        expect(listStoredChatOutboxes(host)).toEqual([]);
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
        vi.spyOn(sessionStorage, "setItem").mockImplementation(() => {
          throw new Error("quota");
        });
      }
      const sendRunIds: string[] = [];
      let sendAttempts = 0;

      const host = makeChatHost({
        requestHandlers: {
          "chat.history": idleChatHistory(),
          "chat.send": (params: unknown) => {
            const payload = requireRecord(params, "retryable send payload");
            sendRunIds.push(String(payload.idempotencyKey));
            sendAttempts += 1;
            if (sendAttempts === 1) {
              throw trigger === "suspension"
                ? new GatewayRequestError({
                    code: "UNAVAILABLE",
                    message: "chat.send unavailable during gateway suspension",
                    retryable: true,
                    retryAfterMs: 100,
                    details: { reason: "gateway-suspending" },
                  })
                : unavailable("Gateway is temporarily busy");
            }
            return { runId: payload.idempotencyKey, status: "started", messageSeq: 1 };
          },
        },
        chatMessage: "retry without disconnecting",
      });

      useFakeClock();
      await handleSendChat(host);

      expect(host.connected).toBe(true);
      expect(host.chatMessage).toBe("");
      expect(host.chatQueue[0]).toMatchObject({
        sendAttempts: 0,
        sendState: "waiting-reconnect",
      });
      expect(sendAttempts).toBe(1);
      if (trigger === "suspension") {
        expect(host.chatQueue[0]?.sendError).toBeUndefined();
        expect(host.chatError).toBeNull();
        host.gatewayWorkPaused = true;
        await vi.advanceTimersByTimeAsync(100);
        expect(sendAttempts).toBe(1);
        host.gatewayWorkPaused = false;
        await resumeStoredChatOutboxes(host);
      } else if (trigger === "reconnect") {
        host.connectionEpoch += 1;
        await resumeStoredChatOutboxes(host);
      } else {
        await vi.advanceTimersByTimeAsync(100);
        // The timer starts a fire-and-forget drain; join its observable outcome.
        await waitForFast(() => {
          expect(sendAttempts).toBe(2);
          expect(listStoredChatOutboxes(host)).toStrictEqual([]);
        });
      }
      expect(sendAttempts).toBe(2);
      expect(host.chatQueue).toEqual([]);
      expect(listStoredChatOutboxes(host)).toStrictEqual([]);
      expect(sendRunIds[1]).toBe(sendRunIds[0]);
    },
  );

  it.each(["response", "timeout"])(
    "retries reconnect history after a retryable %s without a socket close",
    async (failure) => {
      const host = makeChatHost({
        requestHandlers: {},
        connected: false,
        chatMessage: "retry history while connected",
      });
      await handleSendChat(host);
      let historyAttempts = 0;
      let sendAttempts = 0;
      const request = makeRequestMock({
        "chat.history": () => {
          historyAttempts += 1;
          if (historyAttempts === 1) {
            if (failure === "timeout") {
              throw requestTimeout("chat.history");
            }
            throw unavailable();
          }
          return idleChatHistory();
        },
        "chat.send": (params: unknown) => {
          sendAttempts += 1;
          const payload = requireRecord(params, "history retry send payload");
          return { runId: payload.idempotencyKey, status: "started", messageSeq: 1 };
        },
      });
      host.client = clientWithRequest(request);
      host.connected = true;

      useFakeClock();
      await resumeStoredChatOutboxes(host);

      expect(historyAttempts).toBe(1);
      expect(sendAttempts).toBe(0);
      await Promise.all(Array.from({ length: 20 }, () => resumeStoredChatOutboxes(host)));
      expect(historyAttempts).toBe(1);
      await vi.advanceTimersByTimeAsync(failure === "timeout" ? 500 : 100);
      await waitForFast(() => {
        expect(sendAttempts).toBe(1);
        expect(historyAttempts).toBeGreaterThanOrEqual(2);
        expect(listStoredChatOutboxes(host)).toStrictEqual([]);
      });
    },
  );

  it("does not apply a stale readiness rejection to an edited queued input", async () => {
    const historyStarted = Promise.withResolvers<void>();
    const firstHistory = Promise.withResolvers<ReturnType<typeof idleChatHistory>>();
    const sends: unknown[] = [];
    let historyReads = 0;
    const host = makeChatHost({
      chatQueue: [
        {
          id: "edited-during-readiness",
          text: "Original draft",
          createdAt: 1,
          sendRunId: "original-submission",
          sendState: "waiting-reconnect",
          sessionKey: "agent:main",
        },
      ],
      requestHandlers: {
        "chat.history": () => {
          if (++historyReads === 1) {
            historyStarted.resolve();
            return firstHistory.promise;
          }
          return idleChatHistory();
        },
        "chat.send": (params: unknown) => {
          sends.push(params);
          return {
            runId: requireRecord(params, "edited input").idempotencyKey,
            status: "started",
            messageSeq: 1,
          };
        },
      },
    });
    admitHostQueueItems(host);
    const draining = resumeStoredChatOutboxes(host);
    try {
      await historyStarted.promise;
      expect(
        updateQueuedMessage(host, "edited-during-readiness", (item) => ({
          ...item,
          text: "Revised draft",
          sendRunId: "revised-submission",
        })),
      ).not.toBeNull();
      firstHistory.reject(
        new GatewayRequestError({
          code: "INVALID_REQUEST",
          message: "Rejection for the original draft",
        }),
      );
      await draining;
      expect(sends).toEqual([
        expect.objectContaining({
          message: "Revised draft",
          idempotencyKey: "revised-submission",
        }),
      ]);
      expect(host.lastError).toBeNull();
      expect(listStoredChatOutboxes(host)).toEqual([]);
    } finally {
      firstHistory.resolve(idleChatHistory());
      await draining;
    }
  });

  it("transfers an active retry backoff to a sibling pane without bypassing it", async () => {
    let historyAttempts = 0;
    const owner = makeChatHost({
      connectionEpoch: 1,
      requestHandlers: {
        "chat.history": () => {
          historyAttempts += 1;
          throw unavailable();
        },
      },
      chatQueue: [
        {
          id: "shared-retry",
          text: "wait for backoff",
          createdAt: 1,
          sendRunId: "shared-retry-run",
          sendState: "waiting-reconnect",
          sessionKey: "agent:main",
        },
      ],
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
    expect(historyAttempts).toBe(1);
    await vi.advanceTimersByTimeAsync(100);
    await waitForFast(() => expect(historyAttempts).toBe(2));
  });
});
