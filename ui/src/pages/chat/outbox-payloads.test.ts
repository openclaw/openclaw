/* @vitest-environment jsdom */
import { expect, it, vi } from "vitest";
import type { ChatQueueItem } from "../../lib/chat/chat-types.ts";
import * as payloadStore from "../../lib/chat/outbox-payload-store.runtime.ts";
import { createStagedAttachment } from "./chat-delivery-attachments.test-support.ts";
import { makeChatHost, requestCalls } from "./chat-host.test-support.ts";
import { handleSendChat } from "./chat-send-submit.ts";
import { useChatSendBrowserFixture } from "./outbox-browser.test-support.ts";
import { prepareOutboxPayload } from "./outbox-payloads.ts";

useChatSendBrowserFixture();

it("keeps a private attachment out of IndexedDB before session metadata arrives", async () => {
  const attachment = createStagedAttachment("private-input");
  const host = makeChatHost({
    sessionKey: "agent:main:dashboard:incognito-missing",
    selectedChatSessionIncognito: false,
    chatMessage: "Private unsent input",
    chatAttachments: [attachment],
    requestHandlers: {
      "chat.send": () => {
        throw new Error("Incognito session was not found");
      },
    },
  });
  const write = vi.spyOn(payloadStore, "writeOutboxPayload");
  await handleSendChat(host);
  expect(requestCalls(host.request, "chat.send")).toHaveLength(1);
  expect(write).not.toHaveBeenCalled();
  expect(host.chatQueue[0]).toMatchObject({ text: "Private unsent input", sendState: "failed" });
  expect(host.chatQueue[0]?.attachmentPayload).toBeUndefined();
});

it("admits an ordinary queued attachment while another selected pane is private", async () => {
  const host = makeChatHost({
    requestHandlers: {},
    sessionKey: "agent:main:dashboard:incognito-selected",
    selectedChatSessionIncognito: true,
  });
  const item: ChatQueueItem = {
    id: "ordinary-queued-input",
    text: "Ordinary input",
    createdAt: 1,
    sessionKey: "agent:main:dashboard:ordinary",
    attachments: [createStagedAttachment("ordinary-input")],
  };
  const write = vi.spyOn(payloadStore, "writeOutboxPayload");
  const result = await prepareOutboxPayload(host, item);
  expect(result).toMatchObject({
    status: "ready",
    update: { attachmentPayload: expect.anything() },
  });
  expect(write).toHaveBeenCalledTimes(1);
});
