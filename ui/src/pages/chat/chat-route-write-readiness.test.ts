// @vitest-environment node
import { expect, it } from "vitest";
import {
  clearChatHistory,
  rewindChatHistory,
  switchChatHistoryBranch,
} from "./chat-history-actions.ts";
import { loadChatHistory } from "./chat-history.ts";
import { makeChatHost } from "./chat-host.test-support.ts";
import { resumeStoredChatOutboxes } from "./chat-send-actions.ts";
import { requestChatSend } from "./chat-send-request.ts";
import { handleSendChat } from "./chat-send-submit.ts";
import { patchChatSessionSettings } from "./chat-settings-patches.ts";
import { ChatAttachmentReadLifecycle } from "./components/chat-attachment-reads.ts";
import { useChatSendBrowserFixture } from "./outbox-browser.test-support.ts";

useChatSendBrowserFixture();

it("holds history mutations without changing the cached transcript or draft", async () => {
  const host = makeChatHost({
    isRouteSessionPending: () => true,
    chatMessage: "Retain draft",
    chatMessages: [{ role: "assistant", content: "Cached transcript" }],
    requestHandlers: {},
  });
  const messages = host.chatMessages;
  const rewindHost = Object.assign(host, {
    handleChatDraftChange: (next: string) => {
      host.chatMessage = next;
    },
  });
  expect(await clearChatHistory(host)).toBe("failed");
  expect(
    await rewindChatHistory(rewindHost, "entry", new ChatAttachmentReadLifecycle(() => {})),
  ).toBeNull();
  expect(await switchChatHistoryBranch(host, "leaf")).toBe(false);
  expect(await patchChatSessionSettings(host, host.sessionKey, { model: "synthetic" })).toBeNull();
  expect(host.request).not.toHaveBeenCalled();
  expect(host.chatMessage).toBe("Retain draft");
  expect(host.chatMessages).toBe(messages);
});

it("holds a direct transport send used by realtime chat during route admission", async () => {
  const host = makeChatHost({ isRouteSessionPending: () => true, requestHandlers: {} });
  await expect(
    requestChatSend(host, { message: "Unconfirmed talk turn", runId: "talk-turn" }),
  ).rejects.toThrow();
  expect(host.request).not.toHaveBeenCalled();
});

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
