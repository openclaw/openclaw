// @vitest-environment node
import { expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { ChatHistoryResult } from "./chat-history-snapshot.ts";
import {
  createBrowserAnnotationAttachment,
  findChatSendPayload,
  makeChatHost,
} from "./chat-host.test-support.ts";
import { handleSendChat } from "./chat-send-submit.ts";
import { useChatSendBrowserFixture } from "./outbox-browser.test-support.ts";
useChatSendBrowserFixture();
const recipient = (profileId: string, start = 0) => ({ profileId, start, end: start + 5 });

it("offsets selected recipients past reply and annotation", async () => {
  const host = makeChatHost({
    chatMessage: "  🔎 @Alex please review  ",
    chatMentions: [recipient("profile-alex", 5)],
    chatAttachments: [createBrowserAnnotationAttachment("mention", "@Other context")],
    chatReplyTarget: { messageId: "reply", text: "@Other quote", senderLabel: "Reader" },
    getWorkContext: () => ({ page: "chat", title: "@Other work context" }),
    requestHandlers: { "chat.send": { status: "started" } },
  });
  await handleSendChat(host);
  const expected = "> **Reader:** @Other quote\n\n@Other context\n\n🔎 @Alex please review";
  expect(findChatSendPayload(host)).toMatchObject({
    message: expected,
    mentions: [recipient("profile-alex", expected.indexOf("@Alex"))],
  });
});

it("retains replacement recipients during history loading", async () => {
  const history = createDeferred<ChatHistoryResult>();
  const host = makeChatHost({
    chatMessage: "@Alex please review",
    chatMentions: [recipient("profile-first")],
    chatLoading: true,
    currentSessionId: "existing-conversation",
    requestHandlers: {
      "chat.history": () => history.promise,
      "chat.send": { status: "started" },
    },
  });
  const sending = handleSendChat(host);
  await vi.waitFor(() =>
    expect(host.request).toHaveBeenCalledWith("chat.history", expect.anything(), {
      timeoutMs: 30_000,
      signal: expect.any(AbortSignal),
    }),
  );
  expect(host.chatMessage).toBe("");
  host.chatMessage = "@Alex please review";
  host.chatMentions = [recipient("profile-second")];
  const info: ChatHistoryResult["sessionInfo"] = {
    key: host.sessionKey,
    kind: "direct",
    updatedAt: 1,
  };
  history.resolve({
    messages: [],
    sessionInfo: { ...info, status: "done", hasActiveRun: false },
  });
  await sending;
  expect(findChatSendPayload(host).mentions).toEqual([recipient("profile-first")]);
  expect(host.chatMessage).toBe("@Alex please review");
  expect(host.chatMentions).toEqual([recipient("profile-second")]);
});

const commands = ["/new @Alex", "/status @Alex", "/btw @Alex review"];
it.each(commands)("rejects unsupported mentions in %s", async (message) => {
  const mentions = [recipient("profile-alex", message.indexOf("@Alex"))];
  const host = makeChatHost({
    chatMessage: message,
    chatMentions: mentions,
    requestHandlers: {},
  });
  await handleSendChat(host);
  expect(host.request).not.toHaveBeenCalled();
  expect(host.chatMessage).toBe(message);
  expect(host.chatMentions).toEqual(mentions);
  expect(host.chatError).toBeTruthy();
});
