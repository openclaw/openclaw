// @vitest-environment node
import { expect, it } from "vitest";
import { loadChatHistory } from "./chat-history.ts";
import { makeChatHost } from "./chat-host.test-support.ts";
import { resumeStoredChatOutboxes } from "./chat-send-actions.ts";
import { handleSendChat } from "./chat-send-submit.ts";
import { useChatSendBrowserFixture } from "./outbox-browser.test-support.ts";

useChatSendBrowserFixture();

it("holds direct and restored queued sends after startup until route revalidation", async () => {
  let pending = false;
  const host = makeChatHost({
    isRouteSessionPending: () => pending,
    sessionKey: "agent:main:chat:b1c2cd3c-1234-4321-9876-123456789abc",
    connected: false,
    chatMessage: "Restored queued turn",
    requestHandlers: {
      "chat.startup": { messages: [] },
      "chat.history": {
        messages: [],
        sessionInfo: {
          key: "agent:main:chat:b1c2cd3c-1234-4321-9876-123456789abc",
          sessionId: "confirmed-session",
          kind: "direct",
          updatedAt: 1,
          status: "done",
          hasActiveRun: false,
        },
      },
      "chat.send": { runId: "queued-send", status: "started" },
    },
  });
  await handleSendChat(host);
  expect(host.chatQueue).toHaveLength(1);
  host.chatMessage = "Keep this draft";
  pending = true;
  host.connected = true;
  await loadChatHistory(host, { startup: true, deferBranches: true });
  await handleSendChat(host);
  await resumeStoredChatOutboxes(host);
  expect(host.request.mock.calls.filter(([method]) => method === "chat.send")).toHaveLength(0);
  expect(host.chatMessage).toBe("Keep this draft");
  expect(host.chatQueue.map((item) => item.text)).toEqual(["Restored queued turn"]);

  pending = false;
  await resumeStoredChatOutboxes(host);
  expect(host.request.mock.calls.filter(([method]) => method === "chat.send")).toHaveLength(1);
  expect(host.chatMessage).toBe("Keep this draft");
});
