/* @vitest-environment jsdom */
import { expect, it, onTestFinished } from "vitest";
import type { ChatQueueItem } from "../../lib/chat/chat-types.ts";
import { listStoredChatOutboxes } from "../../lib/chat/outbox-store-projection.ts";
import { makeChatHost, requestCalls, requireRecord } from "./chat-host.test-support.ts";
import { chatOutboxOwner } from "./chat-outbox-owner.ts";
import { admitHostQueueItems } from "./chat-outbox-recovery.test-support.ts";
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

useChatSendBrowserFixture();

it.each(["reset", "compact"] as const)(
  "keeps a queued /%s behind an in-flight duplicate admission",
  async (command) => {
    const following = {
      id: "following-command",
      text: `/${command}`,
      localCommandName: command,
      createdAt: 101,
      sessionKey,
      sessionId,
    };
    const host = makeChatHost({
      sessionKey,
      currentSessionId: sessionId,
      chatQueue: [{ ...item, sessionId }, following],
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
    const expected = [{ id: following.id, localCommandName: command }];
    expect(host.chatQueue).toMatchObject(expected);
    expect(listStoredChatOutboxes(host)[0]?.queue).toMatchObject(expected);
  },
);
