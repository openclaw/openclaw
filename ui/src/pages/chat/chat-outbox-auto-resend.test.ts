/* @vitest-environment jsdom */
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { GatewayRequestError } from "../../api/gateway.ts";
import * as outboxPayloadStore from "../../lib/chat/outbox-payload-store.runtime.ts";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import {
  createDeliveryAttachmentBatch,
  reloadChatDocumentStorage,
} from "./chat-delivery-attachments.test-support.ts";
import { handleChatGatewayEvent } from "./chat-gateway.ts";
import { makeChatHost, requestCalls, requireRecord } from "./chat-host.test-support.ts";
import {
  CHAT_OUTBOX_AUTO_RESEND_MAX,
  CHAT_OUTBOX_AUTO_RESEND_WINDOW_MS,
} from "./chat-outbox-drain.ts";
import { chatOutboxOwner } from "./chat-outbox-owner.ts";
import { admitHostQueueItems, idleChatHistory } from "./chat-outbox-recovery.test-support.ts";
import { resumeStoredChatOutboxes } from "./chat-send-actions.ts";
import { handleSendChat } from "./chat-send-submit.ts";
import { listStoredChatOutboxes } from "./composer-persistence.ts";
import { useChatSendBrowserFixture } from "./outbox-browser.test-support.ts";

useChatSendBrowserFixture();

describe("automatic reconnect resend", () => {
  it.each(["ok", "in_flight"])(
    "reuses the interrupted key, accepts %s, and releases FIFO without another resend",
    async (status) => {
      const ack = createDeferred<unknown>();
      let attempts = 0;
      const host = makeChatHost({
        chatMessage: "interrupted first",
        requestHandlers: {
          "chat.history": () => idleChatHistory(),
          "chat.send": () => {
            attempts += 1;
            if (attempts === 1) {
              throw new Error("gateway disconnected");
            }
            return attempts === 2 ? ack.promise : { status: "ok", messageSeq: 2 };
          },
        },
      });
      await handleSendChat(host);
      const first = listStoredChatOutboxes(host)[0]!.queue[0]!;
      expect(first.sendFirstAttemptAtMs).toBeGreaterThan(0);
      host.chatMessage = "queued second";
      host.connected = false;
      await handleSendChat(host);
      host.connected = true;
      host.connectionEpoch = 1;
      const resumed = resumeStoredChatOutboxes(host);
      try {
        // Observe the transport boundary, not a private retry helper.
        await waitForFast(() => expect(attempts).toBe(2));
        expect(host.chatQueue[0]).toMatchObject({
          sendState: "sending",
          sendRunId: first.sendRunId,
          sendAutoResends: 1,
        });
        expect(
          requestCalls(host.request, "chat.send").map(
            ([, p]) => requireRecord(p, "send request").message,
          ),
        ).toEqual(["interrupted first", "interrupted first"]);
      } finally {
        ack.resolve({ runId: first.sendRunId, status, messageSeq: 1 });
        await resumed;
      }
      if (status === "in_flight") {
        await resumeStoredChatOutboxes(host);
        expect(requestCalls(host.request, "chat.send")).toHaveLength(2);
        handleChatGatewayEvent(host, {
          sessionKey: host.sessionKey,
          runId: first.sendRunId!,
          seq: 1,
          state: "final",
          message: { role: "assistant", content: "Finished" },
        });
      }
      await resumeStoredChatOutboxes(host);
      const sends = requestCalls(host.request, "chat.send").map(([, p]) =>
        requireRecord(p, "send request"),
      );
      expect(sends.map((p) => p.message)).toEqual([
        "interrupted first",
        "interrupted first",
        "queued second",
      ]);
      expect(sends[1]!.idempotencyKey).toBe(sends[0]!.idempotencyKey);
      expect(listStoredChatOutboxes(host)).toEqual([]);
    },
  );

  it.each(["disconnect", "rejection"])(
    "preserves the first attempt and cap after %s",
    async (failure) => {
      let calls = 0;
      const host = makeChatHost({
        chatMessage: "keep failing",
        requestHandlers: {
          "chat.history": () => idleChatHistory(),
          "chat.send": () => {
            if (++calls > 1 && failure === "rejection") {
              throw new GatewayRequestError({
                code: "UNAVAILABLE",
                message: "busy",
                retryable: true,
                retryAfterMs: 30_000,
              });
            }
            throw new Error("gateway disconnected");
          },
        },
      });
      await handleSendChat(host);
      const first = listStoredChatOutboxes(host)[0]!.queue[0]!;
      host.connected = false;
      host.chatMessage = "wait behind failing first";
      await handleSendChat(host);
      host.connected = true;
      for (let epoch = 1; epoch <= CHAT_OUTBOX_AUTO_RESEND_MAX; epoch += 1) {
        host.connectionEpoch = epoch;
        await resumeStoredChatOutboxes(host);
        await resumeStoredChatOutboxes(host);
        expect(requestCalls(host.request, "chat.send")).toHaveLength(epoch + 1);
        expect(listStoredChatOutboxes(host)[0]!.queue[0]).toMatchObject({
          sendFirstAttemptAtMs: first.sendFirstAttemptAtMs,
          sendAutoResends: epoch,
        });
      }
      host.connectionEpoch += 1;
      await resumeStoredChatOutboxes(host);
      expect(host.chatQueue[0]).toMatchObject({ sendState: "unconfirmed" });
      expect(host.chatQueue.map((item) => item.text)).toEqual([
        "keep failing",
        "wait behind failing first",
      ]);
      expect(requestCalls(host.request, "chat.send")).toHaveLength(4);
      expect(
        requestCalls(host.request, "chat.send").map(
          ([, p]) => requireRecord(p, "send request").idempotencyKey,
        ),
      ).toEqual(Array(4).fill(first.sendRunId));
    },
  );

  it("keeps the timed retry for a retryable rejection on a live connection", async () => {
    let attempts = 0;
    const host = makeChatHost({
      chatMessage: "busy first",
      requestHandlers: {
        "chat.history": () => idleChatHistory(),
        "chat.send": () => {
          attempts += 1;
          if (attempts === 1) {
            throw new GatewayRequestError({
              code: "UNAVAILABLE",
              message: "busy",
              retryable: true,
              retryAfterMs: 20,
            });
          }
          return { status: "ok", messageSeq: 1 };
        },
      },
    });
    await handleSendChat(host);
    // The rejected attempt is rolled back, so the scheduled retry is a plain send on the
    // same connection epoch rather than an automatic resend of an uncertain delivery.
    await waitForFast(() => expect(attempts).toBe(2));
    await waitForFast(() => expect(listStoredChatOutboxes(host)).toEqual([]));
    expect(host.chatQueue.some((item) => item.sendState === "unconfirmed")).toBe(false);
  });

  it("does not automatically resend a send the Gateway rejected", async () => {
    let attempts = 0;
    const host = makeChatHost({
      chatMessage: "rejected first",
      requestHandlers: {
        "chat.history": () => idleChatHistory(),
        "chat.send": () => {
          attempts += 1;
          throw new GatewayRequestError({ code: "INVALID_REQUEST", message: "message rejected" });
        },
      },
    });
    await handleSendChat(host);
    expect(listStoredChatOutboxes(host)[0]?.queue[0]).toMatchObject({ sendState: "failed" });

    host.connectionEpoch = 1;
    await resumeStoredChatOutboxes(host);
    expect(attempts).toBe(1);
    expect(host.chatQueue[0]).toMatchObject({ sendState: "failed" });
  });

  it("parks without transport when attachment preparation outlasts the retry window", async () => {
    const { attachments } = createDeliveryAttachmentBatch();
    let sends = 0;
    const requestHandlers = {
      "chat.history": () => idleChatHistory(),
      "chat.send": () => {
        sends += 1;
        throw new Error("gateway disconnected");
      },
    };
    const source = makeChatHost({
      chatMessage: "slow attachment",
      chatAttachments: attachments,
      requestHandlers,
    });
    await handleSendChat(source);
    const first = listStoredChatOutboxes(source)[0]!.queue[0]!;
    reloadChatDocumentStorage(attachments);
    const releasePayload = createDeferred();
    const readPayload = outboxPayloadStore.readOutboxPayload;
    vi.spyOn(outboxPayloadStore, "readOutboxPayload").mockImplementation(async (...args) => {
      await releasePayload.promise;
      return readPayload(...args);
    });
    const host = makeChatHost({ requestHandlers });
    onTestFinished(chatOutboxOwner(host).subscribe(host));
    const resumed = resumeStoredChatOutboxes(host);
    try {
      await waitForFast(() =>
        expect(requestCalls(host.request, "chat.history").length).toBeGreaterThanOrEqual(2),
      );
      vi.spyOn(Date, "now").mockReturnValue(
        first.sendFirstAttemptAtMs! + CHAT_OUTBOX_AUTO_RESEND_WINDOW_MS + 1,
      );
    } finally {
      releasePayload.resolve();
      await resumed;
    }
    expect(sends).toBe(1);
    expect(host.chatQueue[0]).toMatchObject({
      sendState: "unconfirmed",
      sendAttempts: 1,
      sendRunId: first.sendRunId,
      sendFirstAttemptAtMs: first.sendFirstAttemptAtMs,
    });
  });

  it.each([undefined, Date.now() - CHAT_OUTBOX_AUTO_RESEND_WINDOW_MS - 1])(
    "keeps legacy or expired attempts as a review barrier (%s)",
    async (sendFirstAttemptAtMs) => {
      const host = makeChatHost({
        chatQueue: [
          {
            id: "first",
            text: "uncertain",
            createdAt: 1,
            sendAttempts: 1,
            sendRunId: "original",
            sendState: "waiting-reconnect",
            sendFirstAttemptAtMs,
          },
          { id: "second", text: "later", createdAt: 2, sendAttempts: 0 },
        ],
        requestHandlers: { "chat.history": () => idleChatHistory() },
      });
      admitHostQueueItems(host);
      await resumeStoredChatOutboxes(host);
      expect(host.chatQueue.map((item) => item.id)).toEqual(["first", "second"]);
      expect(host.chatQueue[0]!.sendState).toBe("unconfirmed");
      expect(requestCalls(host.request, "chat.send")).toHaveLength(0);
    },
  );

  it("retires a recent attempted message already proved by history without resending", async () => {
    const host = makeChatHost({
      chatQueue: [
        {
          id: "first",
          text: "delivered",
          createdAt: 1,
          sendAttempts: 1,
          sendRunId: "original",
          sendState: "waiting-reconnect",
          sendFirstAttemptAtMs: Date.now(),
        },
      ],
      requestHandlers: {
        "chat.history": () => ({
          ...idleChatHistory(),
          messages: [
            {
              role: "user",
              content: "delivered",
              __openclaw: { id: "user", seq: 1, idempotencyKey: "original:user" },
            },
          ],
        }),
      },
    });
    admitHostQueueItems(host);
    await resumeStoredChatOutboxes(host);
    expect(listStoredChatOutboxes(host)).toEqual([]);
    expect(requestCalls(host.request, "chat.send")).toHaveLength(0);
  });
});
