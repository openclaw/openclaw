/* @vitest-environment jsdom */
import { describe, expect, it, onTestFinished } from "vitest";
import type { ChatPendingInputsPage } from "../../../../packages/gateway-protocol/src/schema/logs-chat.js";
import type { ChatQueueItem } from "../../lib/chat/chat-types.ts";
import { listStoredChatOutboxes } from "../../lib/chat/outbox-store-projection.ts";
import { captureChatOutboxAdmission } from "../../lib/chat/outbox-store.ts";
import { makeChatHost, requestCalls, requireRecord } from "./chat-host.test-support.ts";
import { admitQueuedMessageForSession } from "./chat-outbox-admission.test-support.ts";
import { chatOutboxOwner } from "./chat-outbox-owner.ts";
import { admitHostQueueItems } from "./chat-outbox-recovery.test-support.ts";
import { applyChatPendingInputs } from "./chat-pending-inputs.ts";
import { resumeStoredChatOutboxes } from "./chat-send-actions.ts";
import { useChatSendBrowserFixture } from "./outbox-browser.test-support.ts";

const sessionKey = "agent:main:restart-input";
const sessionId = "restart-input-session";
const item: ChatQueueItem = {
  id: "browser-input",
  sendRunId: "accepted-input",
  sessionKey,
  text: "Continue after the update",
  createdAt: 100,
  sendAttempts: 1,
  sendState: "waiting-reconnect",
};
function pending(state: "queued" | "interrupted" | "cancelled"): ChatPendingInputsPage {
  return {
    total: 1,
    items: [
      {
        id: "durable-input",
        runId: item.sendRunId,
        acceptedAt: 100,
        state,
        message: { role: "user", content: item.text },
      },
    ],
  };
}

useChatSendBrowserFixture();

describe("accepted input restart handoff", () => {
  it.each(["reset", "compact"] as const)(
    "keeps a queued /%s behind an in-flight duplicate admission",
    async (command) => {
      const host = makeChatHost({
        sessionKey,
        currentSessionId: sessionId,
        chatQueue: [
          { ...item, sessionId },
          {
            id: "following-command",
            text: `/${command}`,
            localCommandName: command,
            createdAt: 101,
            sessionKey,
            sessionId,
          },
        ],
        requestHandlers: {
          "chat.send": (params: unknown) => ({
            runId: requireRecord(params, "duplicate admission").idempotencyKey,
            status: "in_flight",
          }),
        },
      });
      admitHostQueueItems(host);
      onTestFinished(chatOutboxOwner(host).subscribe(host));

      await resumeStoredChatOutboxes(host);

      expect(requestCalls(host.request, "chat.send")).toHaveLength(1);
      expect(requestCalls(host.request, "sessions.compact")).toEqual([]);
      expect(host.chatRunId).toBe(item.sendRunId);
      expect(host.chatQueue).toMatchObject([
        { id: "following-command", localCommandName: command },
      ]);
      expect(listStoredChatOutboxes(host)[0]?.queue).toMatchObject([
        { id: "following-command", localCommandName: command },
      ]);
    },
  );

  it.each(["queued", "interrupted", "cancelled", "consumed"] as const)(
    "transfers browser custody when the Gateway reports %s input",
    (state) => {
      const host = makeChatHost({ sessionKey, currentSessionId: sessionId, requestHandlers: {} });
      expect(
        admitQueuedMessageForSession(host, captureChatOutboxAdmission(host, sessionKey), item),
      ).toBe(true);
      expect(listStoredChatOutboxes(host)[0]?.queue[0]?.sendRunId).toBe(item.sendRunId);
      if (state === "consumed") {
        applyChatPendingInputs(
          host,
          { items: [], total: 0 },
          {
            receipts: [
              { runId: item.sendRunId!, state: "consumed", consumedByEventId: "aggregate" },
            ],
          },
        );
      } else {
        applyChatPendingInputs(host, pending(state));
      }
      expect(listStoredChatOutboxes(host)).toEqual([]);
    },
  );
});
