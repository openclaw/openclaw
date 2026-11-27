// @vitest-environment node
import { expect, it } from "vitest";
import { composerFileReferenceFixture } from "../../lib/chat/file-references.test-support.ts";
import { findChatSendPayload, makeChatHost } from "./chat-host.test-support.ts";
import { handleSendChat } from "./chat-send-submit.ts";
import { handleChatDraftChange } from "./input-history.ts";
import { useChatSendBrowserFixture } from "./outbox-browser.test-support.ts";

useChatSendBrowserFixture();

it.each(["", "/new ", "/btw ", "/status "])(
  "refuses a bound file reference with prefix %j",
  async (prefix) => {
    const message = prefix + "@src/example.ts";
    const references = [
      { ...composerFileReferenceFixture, start: prefix.length, end: message.length },
    ];
    const host = makeChatHost({
      chatMessage: message,
      chatFileReferences: references,
      requestHandlers: { "chat.send": { status: "started" } },
    });
    await handleSendChat(host);
    expect(host.request).not.toHaveBeenCalled();
    expect(host.chatQueue).toEqual([]);
    expect(host.chatMessage).toBe(message);
    expect(host.chatFileReferences).toEqual(references);
    expect(host.chatError).toContain("Convert file references to plain text");
    if (!prefix) {
      handleChatDraftChange(host, message, undefined, []);
      await handleSendChat(host);
      expect(findChatSendPayload(host).message).toBe(message);
      expect(findChatSendPayload(host)).not.toHaveProperty("fileReferences");
    }
  },
);
