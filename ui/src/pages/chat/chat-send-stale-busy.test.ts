import { expect, it, vi } from "vitest";
import { sessionsResult } from "../../lib/sessions/session-capability.test-support.ts";
import { findChatSendPayload, makeChatHost } from "./chat-host.test-support.ts";
import { handleSendChat } from "./chat-send-submit.ts";
import { useChatSendBrowserFixture } from "./outbox-browser.test-support.ts";

useChatSendBrowserFixture();

it("rechecks stale activity when a follow-up is queued without a terminal event", async () => {
  const sessionKey = "agent:main:stale-busy";
  const sessionId = "same-session";
  const host = makeChatHost({
    sessionKey,
    currentSessionId: sessionId,
    sessionsResult: sessionsResult([
      {
        key: sessionKey,
        sessionId,
        kind: "direct",
        updatedAt: 1,
        hasActiveRun: true,
        activeRunIds: ["finished-run"],
        status: "running",
      },
    ]),
    chatRunId: "finished-run",
    chatStream: "The previous response.",
    chatMessage: "Continue with the next request.",
    requestHandlers: {
      "chat.history": {
        sessionId,
        messages: [],
        sessionInfo: {
          key: sessionKey,
          sessionId,
          kind: "direct",
          updatedAt: 2,
          hasActiveRun: false,
          activeRunIds: [],
          lastRunId: "finished-run",
          status: "done",
        },
      },
      "chat.send": { runId: "next-run", status: "started", messageSeq: 1 },
    },
  });

  await handleSendChat(host, undefined, { followUpMode: "queue" });

  await vi.waitFor(() =>
    expect(findChatSendPayload(host)).toMatchObject({
      sessionKey,
      message: "Continue with the next request.",
    }),
  );
  expect(host.request.mock.calls.filter(([method]) => method === "chat.send")).toHaveLength(1);
  expect(host.chatRunId).toBe("next-run");
  expect(host.chatQueue).toEqual([]);
});
