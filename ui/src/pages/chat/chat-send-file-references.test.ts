// @vitest-environment node
import { expect, it } from "vitest";
import { composerFileReferenceFixture } from "../../lib/chat/file-references.test-support.ts";
import { findChatSendPayload, makeChatHost } from "./chat-host.test-support.ts";
import { handleSendChat } from "./chat-send-submit.ts";
import { useChatSendBrowserFixture } from "./outbox-browser.test-support.ts";

useChatSendBrowserFixture();

it.each([
  "@src/example.ts",
  "/new @src/example.ts",
  "/btw @src/example.ts",
  "/status @src/example.ts",
])("keeps %s unsent and unqueued until identity is explicitly converted", async (message) => {
  const start = message.indexOf("@");
  const references = [{ ...composerFileReferenceFixture, start, end: start + 15 }];
  const host = makeChatHost({
    chatMessage: message,
    chatFileReferences: references,
    requestHandlers: {},
  });
  await handleSendChat(host);
  expect(host.request).not.toHaveBeenCalled();
  expect(host.chatQueue).toEqual([]);
  expect(host.chatMessage).toBe(message);
  expect(host.chatFileReferences).toEqual(references);
  expect(host.chatError).toContain("Convert file references to plain text");
});

it("delivers only the visible text after explicit identity conversion", async () => {
  const host = makeChatHost({
    chatMessage: "@src/example.ts",
    chatFileReferences: [],
    requestHandlers: { "chat.send": { status: "started" } },
  });
  await handleSendChat(host);
  expect(findChatSendPayload(host).message).toBe("@src/example.ts");
  expect(findChatSendPayload(host)).not.toHaveProperty("fileReferences");
});
