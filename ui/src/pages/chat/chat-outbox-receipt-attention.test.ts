/* @vitest-environment jsdom */
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { createStoredChatOutboxReader } from "../../lib/chat/outbox-store-projection.ts";
import { makeChatHost, requestCalls } from "./chat-host.test-support.ts";
import { chatOutboxOwner } from "./chat-outbox-owner.ts";
import { admitHostQueueItems, row } from "./chat-outbox-recovery.test-support.ts";
import { updateQueuedMessage } from "./chat-queue.ts";
import { resumeStoredChatOutboxes } from "./chat-send-actions.ts";
import { listStoredChatOutboxes } from "./composer-persistence.ts";
import { useChatSendBrowserFixture } from "./outbox-browser.test-support.ts";

useChatSendBrowserFixture();

const sessionKey = "agent:main:attention";
const sessionId = "attention-session";
function attentionHost(ids: string[], requestHandlers: Record<string, unknown>) {
  const host = makeChatHost({
    sessionKey: "agent:main:visible",
    chatQueue: ids.map((id) => ({
      id,
      text: id,
      createdAt: 1,
      sendRunId: "run-" + id,
      sendAttempts: 1,
      sendState: "unconfirmed",
      sessionKey,
      sessionId,
    })),
    requestHandlers,
  });
  admitHostQueueItems(host);
  onTestFinished(chatOutboxOwner(host).subscribe(host));
  return host;
}

describe("outbox receipt attention", () => {
  it.each(["receipt", "legacy"] as const)(
    "retires delivered attention behind an uncertain FIFO head using %s proof",
    async (proof) => {
      const host = attentionHost(["uncertain", "delivered-1", "delivered-2", "delivered-3"], {
        "chat.history": (params: { inputRunIds?: string[] }) => ({
          sessionId,
          sessionInfo: row(sessionKey, { sessionId, status: "done", hasActiveRun: false }),
          messages:
            proof === "legacy"
              ? [1, 2, 3].map((id) => ({
                  role: "user",
                  content: "delivered-" + id,
                  __openclaw: {
                    id: "stored-" + id,
                    idempotencyKey: "run-delivered-" + id + ":user",
                  },
                }))
              : [],
          inputReceipts:
            proof === "receipt"
              ? (params.inputRunIds ?? [])
                  .filter((id) => id !== "run-uncertain")
                  .map((runId) => ({
                    runId,
                    state: "consumed",
                    consumedByEventId: "stored-" + runId,
                  }))
              : [],
        }),
      });
      const reader = createStoredChatOutboxReader();
      let summary = reader.read(host);
      onTestFinished(
        reader.subscribe(() => {
          summary = reader.read(host);
        }),
      );
      expect(summary.attentionCountForSession(sessionKey)).toBe(4);

      await resumeStoredChatOutboxes(host);

      expect(listStoredChatOutboxes(host)[0]?.queue.map((item) => item.id)).toEqual(["uncertain"]);
      expect(summary.attentionCountForSession(sessionKey)).toBe(1);
      expect(requestCalls(host.request, "chat.send")).toEqual([]);
    },
  );

  it.each([
    "pending",
    "pending-with-transcript",
    "run-only",
    "replacement-session",
    "edited",
    "connection",
    "cancelled",
  ] as const)("preserves delivery authority for a later %s submission", async (condition) => {
    const started = createDeferred();
    const release = createDeferred();
    const host = attentionHost(["uncertain", "later"], {
      "chat.history": async () => {
        started.resolve();
        await release.promise;
        const observedSessionId = condition === "replacement-session" ? "replacement" : sessionId;
        return {
          sessionId: observedSessionId,
          sessionInfo: row(sessionKey, {
            sessionId: observedSessionId,
            status: "done",
            hasActiveRun: false,
            lastRunId: "run-later",
          }),
          messages:
            condition === "pending-with-transcript"
              ? [
                  {
                    role: "user",
                    content: "later",
                    __openclaw: { id: "stored-later", idempotencyKey: "run-later:user" },
                  },
                ]
              : [],
          inputReceipts:
            condition === "run-only"
              ? []
              : condition === "pending" ||
                  condition === "pending-with-transcript" ||
                  condition === "cancelled"
                ? [{ runId: "run-later", state: "pending", cancelled: condition === "cancelled" }]
                : [{ runId: "run-later", state: "consumed", consumedByEventId: "stored-later" }],
        };
      },
    });
    const reader = createStoredChatOutboxReader();
    const recovering = resumeStoredChatOutboxes(host);
    await started.promise;
    if (condition === "edited") {
      updateQueuedMessage(host, "later", (item) => ({ ...item, sendRunId: "replacement-send" }));
    } else if (condition === "connection") {
      host.connectionEpoch += 1;
    }
    release.resolve();
    await recovering;
    expect(listStoredChatOutboxes(host)[0]?.queue.map((item) => item.id)).toEqual(
      condition === "cancelled" ? ["uncertain"] : ["uncertain", "later"],
    );
    if (condition === "pending" || condition === "pending-with-transcript") {
      expect(listStoredChatOutboxes(host)[0]?.queue[1]?.sendState).toBe("waiting-idle");
      expect(reader.read(host).attentionCountForSession(sessionKey)).toBe(1);
    }
    expect(requestCalls(host.request, "chat.send")).toEqual([]);
  });

  it("retains legacy delivery proof when a sibling's storage retirement fails", async () => {
    const cursors: Array<string | undefined> = [];
    const host = attentionHost(["uncertain", "delivered"], {
      "chat.history": (params: { cursor?: string }) => {
        cursors.push(params.cursor);
        return {
          sessionId,
          sessionInfo: row(sessionKey, { sessionId, status: "done", hasActiveRun: false }),
          deltaCursor: "after-delivery",
          messages: params.cursor
            ? []
            : [
                {
                  role: "user",
                  content: "delivered",
                  __openclaw: { id: "stored-user", idempotencyKey: "run-delivered:user" },
                },
              ],
        };
      },
    });
    const write = vi.spyOn(sessionStorage, "setItem").mockImplementation(() => {
      throw new Error("Synthetic storage write failure");
    });
    await resumeStoredChatOutboxes(host);
    expect(listStoredChatOutboxes(host)[0]?.queue).toHaveLength(2);
    write.mockRestore();
    await resumeStoredChatOutboxes(host);
    expect(cursors).toEqual([undefined, undefined]);
    expect(listStoredChatOutboxes(host)[0]?.queue.map((item) => item.id)).toEqual(["uncertain"]);
    expect(requestCalls(host.request, "chat.send")).toEqual([]);
  });
});
