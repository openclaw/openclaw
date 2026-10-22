// @vitest-environment node
import { expect, it } from "vitest";
import { loadChatHistory } from "./chat-history.ts";
import { makeChatHost } from "./chat-host.test-support.ts";
import { resumeStoredChatOutboxes } from "./chat-send-actions.ts";
import { requestChatSend } from "./chat-send-request.ts";
import { handleSendChat } from "./chat-send-submit.ts";
import { restoreChatComposerState } from "./composer-persistence.ts";
import { useChatSendBrowserFixture } from "./outbox-browser.test-support.ts";

useChatSendBrowserFixture();

it("holds a direct transport send used by realtime chat during route admission", async () => {
  const host = makeChatHost({ isRouteSessionPending: () => true, requestHandlers: {} });
  await expect(
    requestChatSend(host, { message: "Unconfirmed talk turn", runId: "talk-turn" }),
  ).rejects.toThrow();
  expect(host.request).not.toHaveBeenCalled();
  await requestChatSend(host, {
    message: "Independent confirmed outbox",
    runId: "background-turn",
    sessionKey: "agent:main:other",
  });
  expect(host.request).toHaveBeenCalledWith(
    "chat.send",
    expect.objectContaining({ sessionKey: "agent:main:other" }),
    expect.anything(),
  );
});

it("holds direct and restored queued sends after startup until route revalidation", async () => {
  let pending = false;
  const sessionKey = "agent:main:chat:b1c2cd3c-1234-4321-9876-123456789abc";
  const original = makeChatHost({
    sessionKey,
    connected: false,
    chatMessage: "Restored queued turn",
    requestHandlers: {},
  });
  await handleSendChat(original);
  expect(original.chatQueue).toHaveLength(1);
  pending = true;
  const host = makeChatHost({
    isRouteSessionPending: () => pending,
    sessionKey: "agent:main:chat:b1c2cd3c-1234-4321-9876-123456789abc",
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
  expect(restoreChatComposerState(host)).toBe(true);
  expect(host.chatQueue).toHaveLength(1);
  expect(host.chatQueue[0]?.id).toBe(original.chatQueue[0]?.id);
  host.chatMessage = "Keep this draft";
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
