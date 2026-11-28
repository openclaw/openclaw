import { expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { sessionsResult } from "../../lib/sessions/session-capability.test-support.ts";
import { expectRequestCounts, makeChatHost } from "./chat-host.test-support.ts";
import { resumeStoredChatOutboxes } from "./chat-send-actions.ts";
import { handleSendChat } from "./chat-send-submit.ts";
import { useChatSendBrowserFixture } from "./outbox-browser.test-support.ts";

useChatSendBrowserFixture();

it.each([false, true])(
  "consumes foreground reconciliation before a pending history response (new follow-up: %s)",
  async (newFollowUp) => {
    const sessionKey = "agent:main:active-follow-up";
    const sessionId = "same-session";
    const row = {
      key: sessionKey,
      sessionId,
      kind: "direct" as const,
      updatedAt: 1,
      hasActiveRun: true,
      activeRunIds: ["active-run"],
      status: "running" as const,
    };
    const history = {
      sessionId,
      messages: [],
      sessionInfo: row,
      inFlightRun: { runId: "active-run", text: "Still working." },
    };
    const pendingHistory = createDeferred<typeof history>();
    const readHistory = vi
      .fn()
      .mockImplementationOnce(() => pendingHistory.promise)
      .mockResolvedValue(history);
    const host = makeChatHost({
      sessionKey,
      currentSessionId: sessionId,
      sessionsResult: sessionsResult([row]),
      chatRunId: "active-run",
      chatStream: "Still working.",
      chatMessage: "First follow-up",
      requestHandlers: { "chat.history": readHistory },
    });
    await handleSendChat(host, undefined, { followUpMode: "queue" });
    await vi.waitFor(() => expect(readHistory).toHaveBeenCalledTimes(1));
    if (newFollowUp) {
      host.chatMessage = "Second follow-up";
      await handleSendChat(host, undefined, { followUpMode: "queue" });
    }
    const draining = resumeStoredChatOutboxes(host, {
      type: "event",
      event: "sessions.changed",
      payload: { sessionKey, ...row },
    });
    pendingHistory.resolve(history);
    await draining;
    expectRequestCounts(host.request, { "chat.history": newFollowUp ? 2 : 1, "chat.send": 0 });
    expect(host.chatQueue.map((item) => item.text)).toEqual(
      newFollowUp ? ["First follow-up", "Second follow-up"] : ["First follow-up"],
    );
    expect(host.chatRunId).toBe("active-run");
  },
);
