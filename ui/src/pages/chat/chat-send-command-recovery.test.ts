// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { GatewayRequestError } from "../../api/gateway-connect-errors.ts";
import {
  captureChatOutboxAdmission,
  storedChatOutboxScopeKey,
} from "../../lib/chat/outbox-store.ts";
import { getChatAttachmentDataUrl } from "./attachment-payload-store.ts";
import { createStagedAttachment } from "./chat-delivery-attachments.test-support.ts";
import { findChatSendPayload, makeChatHost } from "./chat-host.test-support.ts";
import { handleSendChat } from "./chat-send-submit.ts";
import { useChatSendBrowserFixture } from "./outbox-browser.test-support.ts";

const attachmentDataUrl = "data:application/pdf;base64,JVBERi0xLjQK";
const sentAttachments = [
  {
    type: "file",
    mimeType: "application/pdf",
    fileName: "brief.pdf",
    content: "JVBERi0xLjQK",
  },
];

useChatSendBrowserFixture();

describe.each(["steer", "redirect"] as const)("handleSendChat /%s recovery", (command) => {
  const draft = `/${command} correction`;
  const commandHost = (response: unknown, overrides: Parameters<typeof makeChatHost>[0] = {}) =>
    makeChatHost({ chatMessage: draft, requestHandlers: { "chat.send": response }, ...overrides });

  it.each(["timeout", "error", "rejected", "started", "in_flight", "ok"] as const)(
    "settles a %s command ACK",
    async (status) => {
      const failed = ["timeout", "error", "rejected"].includes(status);
      const attachment = createStagedAttachment(`${command}-${status}`);
      const host = commandHost(
        () => {
          if (status === "rejected") {
            throw new GatewayRequestError({ code: "UNAVAILABLE", message: "Request rejected" });
          }
          return { runId: "command-run", status };
        },
        { chatAttachments: [attachment], ...(failed ? {} : { chatRunId: "active-run" }) },
      );
      await handleSendChat(host);
      expect(findChatSendPayload(host)).toMatchObject({
        message: "correction",
        queueMode: command === "steer" ? "steer" : "interrupt",
        attachments: sentAttachments,
      });
      expect(host).toMatchObject({
        chatMessage: failed ? draft : "",
        chatAttachments: failed ? [{ id: attachment.id }] : [],
      });
      expect(getChatAttachmentDataUrl(failed ? host.chatAttachments[0]! : attachment)).toBe(
        failed ? attachmentDataUrl : null,
      );
      if (failed) {
        expect(host.chatQueue).toEqual([]);
        expect(host.chatError).toBeTruthy();
      } else {
        expect(host.chatRunId).toBe(
          command === "redirect" && status !== "ok" ? "command-run" : "active-run",
        );
        expect(host.chatComposerFallbackByScope).toEqual({});
        expect(host.chatError).toBeFalsy();
      }
    },
  );

  it.each([false, true])("preserves edits (navigated: %s)", async (navigated) => {
    const acknowledgment = createDeferred<{ runId: string; status: "timeout" }>();
    const attachment = createStagedAttachment("submitted-file");
    const host = commandHost(
      () => acknowledgment.promise,
      navigated ? { sessionKey: "agent:main:first", chatAttachments: [attachment] } : {},
    );
    const submittedScopeKey = storedChatOutboxScopeKey(
      captureChatOutboxAdmission(host, host.sessionKey).scope,
    );

    const send = handleSendChat(host);
    await vi.waitFor(() => expect(findChatSendPayload(host)).toBeDefined());
    if (navigated) {
      host.sessionKey = "agent:main:second";
      host.chatMessage = "Other draft";
      host.chatError = "Other error";
    } else {
      host.chatMessage = "Newer draft";
      host.chatAttachments = [attachment];
    }
    acknowledgment.resolve({ runId: "command-run", status: "timeout" });
    await send;

    if (navigated) {
      expect(host).toMatchObject({ chatMessage: "Other draft", chatError: "Other error" });
      const fallbacks = host.chatComposerFallbackByScope;
      expect(Object.keys(fallbacks)).toEqual([submittedScopeKey]);
      const fallback = fallbacks[submittedScopeKey]!;
      expect(fallback.message).toBe(draft);
      expect(getChatAttachmentDataUrl(fallback.attachments[0]!)).toBe(attachmentDataUrl);
    } else {
      expect(host).toMatchObject({ chatMessage: "Newer draft", chatAttachments: [attachment] });
      expect(getChatAttachmentDataUrl(attachment)).toBe(attachmentDataUrl);
    }
  });

  if (command === "redirect") {
    it("does not send files after navigation", async () => {
      const attachment = createStagedAttachment("redirect-route");
      const host = commandHost({ status: "ok" }, { chatAttachments: [attachment] });
      const send = handleSendChat(host);
      host.sessionKey = "agent:main:other";
      await send;
      expect(host.request.mock.calls.filter(([method]) => method === "chat.send")).toEqual([]);
      expect(host).toMatchObject({ chatMessage: draft, chatAttachments: [attachment] });
      expect(getChatAttachmentDataUrl(attachment)).toBe(attachmentDataUrl);
    });
  }
});
