/* @vitest-environment jsdom */
import { expectDefined } from "@openclaw/normalization-core";
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

it("copies a duplicated tab's attachment without pausing its original pending submission", async () => {
  const gatewayUrl = "ws://duplicate-outbox.test";
  const host = makeChatHost({ requestHandlers: {}, settings: { gatewayUrl } });
  const recoveryScope = expectDefined(host.client?.recoveryScope, "account recovery scope");
  const blob = new Blob(["copied attachment"], { type: "text/plain" });
  const metadata = { mimeType: blob.type, fileName: "queued.txt", sizeBytes: blob.size };
  const source = await payloadStore.writeOutboxPayload(
    { gatewayOwner: gatewayUrl, recoveryScope, tabId: "source-tab", queueId: "original-input" },
    [{ ...metadata, blob }],
  );
  if (source.status !== "ready") {
    throw new Error("Source attachment was not stored");
  }
  const original: ChatQueueItem = {
    id: "original-input",
    text: "Keep the original submission",
    createdAt: 1,
    sendRunId: "original-run",
    sendAttempts: 1,
    sendState: "waiting-reconnect",
    attachmentPayload: source.value,
    attachments: [{ id: "original-attachment", ...metadata }],
  };

  const result = await prepareOutboxPayload(host, original);

  if (result.status !== "ready") {
    throw new Error("Duplicated attachment was not prepared");
  }
  expect({ ...original, ...result.update }).toMatchObject({
    id: "original-input",
    sendRunId: "original-run",
    sendAttempts: 1,
    sendState: "waiting-reconnect",
    attachments: [{ ...metadata, dataUrl: `data:${blob.type};base64,Y29waWVkIGF0dGFjaG1lbnQ=` }],
  });
  expect(result.update.attachmentPayload?.key).not.toBe(source.value.key);
  expect(result.update.attachmentPayload?.tabId).not.toBe("source-tab");
});
