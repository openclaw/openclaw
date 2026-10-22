import { expect, it } from "vitest";
import { GatewayPayloadLimitError } from "../../api/gateway.ts";
import { makeChatHost } from "./chat-host.test-support.js";
import { handleSendChat } from "./chat-send-submit.ts";

export function registerChatSendPayloadLimitTests(): void {
  it("restores input and attachments when a payload limit rejects before transport", async () => {
    const attachment = {
      id: "oversized-attachment",
      dataUrl: "data:text/plain;base64,SGVsbG8=",
      fileName: "note.txt",
      mimeType: "text/plain",
      sizeBytes: 5,
    };
    const host = makeChatHost({
      requestHandlers: {
        "chat.send": () => {
          throw new GatewayPayloadLimitError();
        },
      },
      chatAttachments: [attachment],
      chatMessage: "keep this draft",
    });

    await handleSendChat(host);

    expect(host.chatMessage).toBe("keep this draft");
    expect(host.chatAttachments).toStrictEqual([attachment]);
    expect(host.chatQueue).toStrictEqual([]);
    expect(host.lastError).toContain("Request exceeds the Gateway payload limit");
  });
}
