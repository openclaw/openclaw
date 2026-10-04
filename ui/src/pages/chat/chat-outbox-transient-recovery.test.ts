/* @vitest-environment jsdom */
import { GatewayProtocolRequestTimeoutError } from "@openclaw/gateway-client/browser";
import { describe, expect, it, vi } from "vitest";
import { GatewayRequestError } from "../../api/gateway.ts";
import { createTestGatewayClient as clientWithRequest } from "../../test-helpers/gateway-client.ts";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import {
  makeChatHost,
  makeRequestMock,
  requestCalls,
  requireRecord,
} from "./chat-host.test-support.ts";
import { admitHostQueueItems, idleChatHistory, row } from "./chat-outbox-recovery.test-support.ts";
import { resumeStoredChatOutboxes } from "./chat-send-actions.ts";
import { handleSendChat } from "./chat-send-submit.ts";
import { listStoredChatOutboxes } from "./composer-persistence.ts";
import { useChatSendBrowserFixture } from "./outbox-browser.test-support.ts";
useChatSendBrowserFixture();

describe("transient outbox delivery recovery", () => {
  it("retries an explicitly retryable send rejection while still connected", async () => {
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
            throw new GatewayRequestError({
              code: "UNAVAILABLE",
              message: "Gateway is temporarily busy",
              retryable: true,
              retryAfterMs: 100,
            });
          }
          return { runId: payload.idempotencyKey, status: "started", messageSeq: 1 };
        },
      },
      chatMessage: "retry without disconnecting",
    });

    vi.useFakeTimers();
    try {
      await handleSendChat(host);

      expect(host.connected).toBe(true);
      expect(host.chatQueue[0]).toMatchObject({
        sendAttempts: 0,
        sendState: "waiting-reconnect",
      });
      expect(sendAttempts).toBe(1);
      await vi.advanceTimersByTimeAsync(100);
      // The retry timer only kicks off a fire-and-forget drain, so the resend
      // lands after the tick returns. Wait for the outcome, not the tick.
      await waitForFast(() => {
        expect(sendAttempts).toBe(2);
        expect(listStoredChatOutboxes(host)).toStrictEqual([]);
      });
      expect(sendRunIds[1]).toBe(sendRunIds[0]);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([false, true])(
    "reconciles a timed-out send without resending (receipt=%s)",
    async (received) => {
      let runId = "";
      const host = makeChatHost({
        chatMessage: "Keep this exact submission",
        currentSessionId: "timeout-session",
        requestHandlers: {
          "chat.send": (params: unknown) => {
            runId = String(requireRecord(params, "timeout send").idempotencyKey);
            throw new GatewayProtocolRequestTimeoutError({
              method: "chat.send",
              timeoutMs: 30_000,
              requestSent: true,
            });
          },
          "chat.history": () => ({
            ...idleChatHistory(),
            sessionId: "timeout-session",
            sessionInfo: row("agent:main", {
              sessionId: "timeout-session",
              hasActiveRun: false,
              status: "done",
            }),
            messages: received
              ? [
                  {
                    role: "user",
                    content: "Keep this exact submission",
                    __openclaw: { id: "timeout-receipt", idempotencyKey: runId + ":user" },
                  },
                ]
              : [],
          }),
        },
      });
      vi.useFakeTimers();
      try {
        await handleSendChat(host);
        expect(host.chatQueue[0]).toMatchObject({
          sendRunId: runId,
          sendAttempts: 1,
          sendState: "unconfirmed",
        });
        expect(host.chatError).toBeNull();
        host.chatMessage = "A newer offline draft";
        await vi.advanceTimersByTimeAsync(500);
        await resumeStoredChatOutboxes(host);
        expect(requestCalls(host.request, "chat.history").length).toBeGreaterThan(0);
        expect(requestCalls(host.request, "chat.send")).toHaveLength(1);
        expect(host.chatMessage).toBe("A newer offline draft");
        if (received) {
          expect(listStoredChatOutboxes(host)).toEqual([]);
        } else {
          expect(host.chatQueue[0]).toMatchObject({
            sendRunId: runId,
            sendAttempts: 1,
            sendState: "unconfirmed",
          });
        }
      } finally {
        vi.useRealTimers();
      }
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
              throw new GatewayProtocolRequestTimeoutError({
                method: "chat.history",
                timeoutMs: 30_000,
                requestSent: true,
              });
            }
            throw new GatewayRequestError({
              code: "UNAVAILABLE",
              message: "History is temporarily unavailable",
              retryable: true,
              retryAfterMs: 100,
            });
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

      vi.useFakeTimers();
      try {
        await resumeStoredChatOutboxes(host);

        expect(historyAttempts).toBe(1);
        expect(sendAttempts).toBe(0);
        await Promise.all(Array.from({ length: 20 }, () => resumeStoredChatOutboxes(host)));
        expect(historyAttempts).toBe(1);
        await vi.advanceTimersByTimeAsync(failure === "timeout" ? 500 : 100);
        // Same fire-and-forget retry hand-off as the send-rejection case above.
        await waitForFast(() => {
          expect(sendAttempts).toBe(1);
          expect(historyAttempts).toBeGreaterThanOrEqual(2);
          expect(listStoredChatOutboxes(host)).toStrictEqual([]);
        });
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it("retries after reconnecting with the same Gateway client", async () => {
    let sendAttempts = 0;
    const host = makeChatHost({
      requestHandlers: {
        "chat.history": idleChatHistory(),
        "chat.send": (params: unknown) => {
          sendAttempts += 1;
          if (sendAttempts === 1) {
            throw new GatewayRequestError({
              code: "UNAVAILABLE",
              message: "Gateway is temporarily busy",
              retryable: true,
              retryAfterMs: 100,
            });
          }
          const payload = requireRecord(params, "reconnected send payload");
          return { runId: payload.idempotencyKey, status: "started", messageSeq: 1 };
        },
      },
      chatMessage: "retry after reconnecting",
    });

    vi.useFakeTimers();
    try {
      await handleSendChat(host);
      expect(sendAttempts).toBe(1);

      host.connectionEpoch += 1;
      await resumeStoredChatOutboxes(host);

      expect(sendAttempts).toBe(2);
      expect(listStoredChatOutboxes(host)).toStrictEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("transfers an active retry backoff to a sibling pane without bypassing it", async () => {
    let historyAttempts = 0;
    const owner = makeChatHost({
      connectionEpoch: 1,
      requestHandlers: {
        "chat.history": () => {
          historyAttempts += 1;
          throw new GatewayRequestError({
            code: "UNAVAILABLE",
            message: "History is temporarily unavailable",
            retryable: true,
            retryAfterMs: 100,
          });
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

    vi.useFakeTimers();
    try {
      await resumeStoredChatOutboxes(owner);
      owner.sessionKey = "agent:main:other";
      await resumeStoredChatOutboxes(sibling);
      expect(historyAttempts).toBe(1);
      await vi.advanceTimersByTimeAsync(100);
      await waitForFast(() => expect(historyAttempts).toBe(2));
    } finally {
      vi.useRealTimers();
    }
  });
});
