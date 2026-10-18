/* @vitest-environment jsdom */
import { GatewayProtocolRequestTimeoutError } from "@openclaw/gateway-client/browser";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { GatewayRequestError } from "../../api/gateway.ts";
import type { ChatQueueItem } from "../../lib/chat/chat-types.ts";
import { createTestGatewayClient as clientWithRequest } from "../../test-helpers/gateway-client.ts";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import {
  makeChatHost,
  makeRequestMock,
  requestCalls,
  requireRecord,
} from "./chat-host.test-support.ts";
import { chatOutboxOwner } from "./chat-outbox-owner.ts";
import { admitHostQueueItems, idleChatHistory, row } from "./chat-outbox-recovery.test-support.ts";
import { updateQueuedMessage } from "./chat-queue.ts";
import { resumeStoredChatOutboxes } from "./chat-send-actions.ts";
import { handleSendChat } from "./chat-send-submit.ts";
import { listStoredChatOutboxes } from "./composer-persistence.ts";
import { useChatSendBrowserFixture } from "./outbox-browser.test-support.ts";
useChatSendBrowserFixture();

const sessionKey = "agent:main:queued";
const sessionId = "queued-session";
const runId = "uncertain-submission";

function recoveryHost(
  requestHandlers: Record<string, unknown>,
  chatQueue: ChatQueueItem[] = [uncertainInput()],
) {
  const host = makeChatHost({ sessionKey: "agent:main:visible", chatQueue, requestHandlers });
  admitHostQueueItems(host);
  onTestFinished(chatOutboxOwner(host).subscribe(host));
  return host;
}

function uncertainInput(overrides: Partial<ChatQueueItem> = {}): ChatQueueItem {
  return {
    id: "uncertain-input",
    text: "Keep this submission",
    sendRunId: runId,
    sessionKey,
    sessionId,
    createdAt: 1,
    sendAttempts: 1,
    sendState: "unconfirmed",
    ...overrides,
  };
}

function historyRequests(host: { request: ReturnType<typeof makeRequestMock> }) {
  return requestCalls(host.request, "chat.history").map((call) =>
    requireRecord(call[1], "recovery request"),
  );
}

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

function idleSession(key = sessionKey, id = sessionId) {
  return row(key, { sessionId: id, status: "done", hasActiveRun: false });
}

function expectUnconfirmed(host: ReturnType<typeof makeChatHost>, sendRunId: string) {
  expect(host.chatQueue[0]).toMatchObject({ sendRunId, sendAttempts: 1, sendState: "unconfirmed" });
}

describe("transient outbox delivery recovery", () => {
  it.each(["receipt", "legacy"] as const)(
    "rechecks each outbox by cursor and retires newly delivered %s proof",
    async (proof) => {
      const sessionKeys = ["agent:main:queued", "agent:main:sibling"];
      let delivered = false;
      const host = recoveryHost(
        {
          "chat.history": (params: { sessionKey: string; cursor?: string }) => {
            const observedSessionId = `session-${params.sessionKey}`;
            const observedRunId = `run-${params.sessionKey}`;
            const message = {
              role: "user",
              content: "Keep this submission",
              __openclaw: { id: "stored-user", seq: 21, idempotencyKey: `${observedRunId}:user` },
            };
            return {
              ...(params.cursor ? { kind: "delta" } : {}),
              deltaCursor: `${params.sessionKey}-cursor-${params.cursor ? 2 : 1}`,
              sessionId: observedSessionId,
              sessionInfo: idleSession(params.sessionKey, observedSessionId),
              messages:
                delivered && proof === "legacy" ? [params.cursor ? { message } : message] : [],
              inputReceipts:
                delivered && proof === "receipt"
                  ? [{ runId: observedRunId, state: "consumed", consumedByEventId: "stored-user" }]
                  : [],
            };
          },
        },
        sessionKeys.map((key) =>
          uncertainInput({
            id: `input-${key}`,
            sendRunId: `run-${key}`,
            sessionKey: key,
            sessionId: `session-${key}`,
          }),
        ),
      );

      await resumeStoredChatOutboxes(host);
      await resumeStoredChatOutboxes(host);
      expect(listStoredChatOutboxes(host)).toHaveLength(2);
      for (const key of sessionKeys) {
        expect(
          historyRequests(host)
            .filter((params) => params.sessionKey === key)
            .map((params) => params.cursor),
        ).toEqual([undefined, `${key}-cursor-1`]);
      }

      delivered = true;
      await resumeStoredChatOutboxes(host);
      expect(listStoredChatOutboxes(host)).toEqual([]);
      for (const key of sessionKeys) {
        expect(
          historyRequests(host)
            .filter((params) => params.sessionKey === key)
            .map((params) => params.cursor),
        ).toEqual([undefined, `${key}-cursor-1`, `${key}-cursor-2`]);
      }
      expect(requestCalls(host.request, "chat.send")).toEqual([]);
    },
  );

  it.each(["connection", "submission", "physical-session", "reset", "reset-failure"] as const)(
    "refreshes recovery history after %s invalidates its cursor",
    async (invalidation) => {
      let failFallback = false;
      const host = recoveryHost({
        "chat.history": (params: { cursor?: string }) => {
          if (params.cursor) {
            failFallback = invalidation === "reset-failure";
            return { kind: "reset" };
          }
          if (failFallback) {
            failFallback = false;
            throw new Error("Synthetic history lookup unavailable");
          }
          return {
            deltaCursor: "cursor-1",
            messages: [],
            sessionId,
            sessionInfo: idleSession(),
          };
        },
      });
      await resumeStoredChatOutboxes(host);
      if (invalidation === "connection") {
        host.connectionEpoch += 1;
      } else if (invalidation === "submission" || invalidation === "physical-session") {
        updateQueuedMessage(host, "uncertain-input", (item) => ({
          ...item,
          ...(invalidation === "submission"
            ? { sendRunId: "replacement-submission" }
            : { sessionId: "replacement-session" }),
        }));
      }
      await resumeStoredChatOutboxes(host);
      if (invalidation === "reset-failure") {
        await resumeStoredChatOutboxes(host);
      }
      expect(historyRequests(host).map((params) => params.cursor)).toEqual(
        invalidation === "reset-failure"
          ? [undefined, "cursor-1", undefined, undefined]
          : invalidation === "reset"
            ? [undefined, "cursor-1", undefined]
            : [undefined, undefined],
      );
      expect(listStoredChatOutboxes(host)[0]?.queue).toHaveLength(1);
      expect(requestCalls(host.request, "chat.send")).toEqual([]);
    },
  );

  it.each([
    "found",
    "missing",
    "receipt",
    "reset",
    "replacement",
    "append",
    "duplicate",
    "empty",
    "duplicate-then-found",
  ] as const)("reconciles legacy proof beyond the byte-bounded tail (%s)", async (outcome) => {
    const unrelated = {
      role: "assistant",
      content: "Later reply",
      __openclaw: { id: "newer", seq: 2500 },
    };
    const host = recoveryHost({
      "chat.history": (params: { offset?: number; cursor?: string }) => {
        const older = params.offset !== undefined;
        const physicalSession =
          older && outcome === "replacement" ? "replacement-session" : sessionId;
        const sessionInfo = {
          ...idleSession(sessionKey, physicalSession),
          ...(older ? {} : { activeLeafEntryId: "held-leaf" }),
        };
        if (params.cursor) {
          return { kind: "delta", deltaCursor: "tail-cursor", messages: [], sessionInfo };
        }
        if (!older) {
          return {
            sessionId,
            sessionInfo,
            deltaCursor: "tail-cursor",
            messages: [unrelated],
            hasMore: true,
            nextOffset: 1500,
            totalMessages: 3000,
            inputReceipts:
              outcome === "receipt"
                ? [{ runId, state: "consumed", consumedByEventId: "older-user" }]
                : [],
          };
        }
        const overlap = outcome === "duplicate-then-found" && params.offset === 1500;
        return {
          sessionId: physicalSession,
          sessionInfo,
          offset: params.offset,
          hasMore: overlap,
          ...(overlap ? { nextOffset: 2000 } : {}),
          totalMessages: outcome === "append" ? 3001 : 3000,
          ...(outcome === "reset" ? { windowReset: true } : {}),
          messages:
            outcome === "empty"
              ? []
              : outcome === "duplicate" || overlap
                ? [unrelated]
                : [
                    {
                      role: "user",
                      content: "A",
                      __openclaw: {
                        id: "older-user",
                        seq: 1000,
                        ...(outcome === "missing" ? {} : { idempotencyKey: `${runId}:user` }),
                      },
                    },
                  ],
        };
      },
    });
    await resumeStoredChatOutboxes(host);
    const delivered =
      outcome === "found" || outcome === "receipt" || outcome === "duplicate-then-found";
    expect(listStoredChatOutboxes(host)).toHaveLength(delivered ? 0 : 1);
    let requests = historyRequests(host);
    expect(requests).toHaveLength(
      outcome === "receipt" ? 1 : outcome === "duplicate-then-found" ? 3 : 2,
    );
    if (outcome !== "receipt") {
      expect(requests[1]).toMatchObject({ offset: 1500, limit: 999 });
    }
    if (outcome === "duplicate-then-found") {
      expect(requests[2]).toMatchObject({ offset: 2000, limit: 999 });
    }
    if (!delivered) {
      await resumeStoredChatOutboxes(host);
      requests = historyRequests(host);
      if (outcome === "missing" || outcome === "duplicate" || outcome === "empty") {
        expect(requests).toHaveLength(3);
        expect(requests[2]?.cursor).toBe("tail-cursor");
      } else {
        expect(requests).toHaveLength(4);
        expect(requests.every((params) => params.cursor === undefined)).toBe(true);
      }
    }
    expect(requestCalls(host.request, "chat.send")).toEqual([]);
  });

  it.each(["entries", "bytes", "activity"] as const)(
    "bounds the %s recovery window including projected siblings and tool activity",
    async (bound) => {
      const sessionInfo = idleSession();
      let olderReads = 0;
      let inspectedMessages = 0;
      let inspectedBytes = 0;
      const host = recoveryHost({
        "chat.history": (params: { cursor?: string; offset?: number; limit: number }) => {
          if (params.cursor) {
            return { kind: "delta", deltaCursor: "window-cursor", messages: [], sessionInfo };
          }
          const older = params.offset !== undefined;
          if (older) {
            olderReads += 1;
          }
          const url = `https://example.test/${"x".repeat(7_000)}`;
          const pageSize = bound === "entries" ? 100 : bound === "activity" ? 24 : 4;
          const messages = Array.from(
            { length: older ? Math.min(params.limit, pageSize) : 1 },
            (_, index) => ({
              role: "assistant",
              content:
                older && bound !== "entries"
                  ? [
                      {
                        type: "toolCall",
                        id: `call-${index}`,
                        name: bound === "activity" ? "web_fetch" : "read",
                        arguments: bound === "activity" ? { url } : { input: "x".repeat(120_000) },
                      },
                    ]
                  : older
                    ? `Unrelated sibling ${index}`
                    : "Unrelated",
              __openclaw: {
                id: `message-${params.offset ?? 0}${bound === "activity" ? `-${index}` : ""}`,
              },
            }),
          );
          const activity =
            older && bound === "activity"
              ? messages.map((message, index) => ({
                  messageId: message["__openclaw"].id,
                  items: [
                    {
                      itemId: `tool:${index}`,
                      phase: "end",
                      kind: "tool",
                      title: `Fetch ${url}`,
                      meta: url,
                    },
                  ],
                }))
              : undefined;
          inspectedMessages += messages.length;
          inspectedBytes += JSON.stringify({ messages, activity }).length;
          return {
            sessionId,
            sessionInfo,
            messages,
            activity,
            hasMore: (params.offset ?? 0) + 1500 < 100_000,
            ...(older ? { offset: params.offset } : { deltaCursor: "window-cursor" }),
            nextOffset: (params.offset ?? 0) + 1500,
            totalMessages: 100_000,
          };
        },
      });
      await resumeStoredChatOutboxes(host);
      if (bound === "entries") {
        expect(inspectedMessages).toBe(1000);
        expect(olderReads).toBe(10);
      } else {
        expect(inspectedBytes).toBeGreaterThanOrEqual(6 * 1024 * 1024);
        expect(inspectedBytes).toBeLessThan(6 * 1024 * 1024 + 512 * 1024);
        expect(olderReads).toBe(bound === "activity" ? 13 : 14);
      }
      const completedReads = olderReads;
      await resumeStoredChatOutboxes(host);
      expect(olderReads).toBe(completedReads);
      expect(listStoredChatOutboxes(host)[0]?.queue).toHaveLength(1);
      expect(requestCalls(host.request, "chat.send")).toEqual([]);
    },
  );

  it.each(["backoff", "reconnect"])(
    "retries a retryable send rejection after %s",
    async (trigger) => {
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
              throw unavailable("Gateway is temporarily busy");
            }
            return { runId: payload.idempotencyKey, status: "started", messageSeq: 1 };
          },
        },
        chatMessage: "retry without disconnecting",
      });

      useFakeClock();
      await handleSendChat(host);

      expect(host.connected).toBe(true);
      expect(host.chatQueue[0]).toMatchObject({
        sendAttempts: 0,
        sendState: "waiting-reconnect",
      });
      expect(sendAttempts).toBe(1);
      if (trigger === "reconnect") {
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
      expect(listStoredChatOutboxes(host)).toStrictEqual([]);
      expect(sendRunIds[1]).toBe(sendRunIds[0]);
    },
  );

  it.each([false, true])(
    "reconciles a timed-out send without resending (receipt=%s)",
    async (received) => {
      let timeoutRunId = "";
      const host = makeChatHost({
        chatMessage: "Keep this exact submission",
        currentSessionId: "timeout-session",
        requestHandlers: {
          "chat.send": (params: unknown) => {
            timeoutRunId = String(requireRecord(params, "timeout send").idempotencyKey);
            throw requestTimeout("chat.send");
          },
          "chat.history": () => ({
            ...idleChatHistory(),
            sessionId: "timeout-session",
            sessionInfo: idleSession("agent:main", "timeout-session"),
            messages: received
              ? [
                  {
                    role: "user",
                    content: "Keep this exact submission",
                    __openclaw: { id: "timeout-receipt", idempotencyKey: timeoutRunId + ":user" },
                  },
                ]
              : [],
          }),
        },
      });
      useFakeClock();
      await handleSendChat(host);
      expectUnconfirmed(host, timeoutRunId);
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
        expectUnconfirmed(host, timeoutRunId);
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
