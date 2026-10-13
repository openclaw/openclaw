import { render } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ApplicationGateway } from "../app/gateway.ts";
import { buildChatApiAttachments } from "../pages/chat/attachment-api.ts";
import { releaseChatAttachmentPayloads } from "../pages/chat/attachment-payload-store.ts";
import { renderAttachmentPreview } from "../pages/chat/components/chat-attachments.ts";
import type { ChatAttachment } from "./chat/chat-types.ts";
import { mcpAppMessageInput } from "./mcp-app-message.ts";

const context = { gateway: { snapshot: { hello: null } } as ApplicationGateway };
let attachments: ChatAttachment[] = [];
afterEach(() => {
  releaseChatAttachmentPayloads(attachments);
  attachments = [];
  document.body.replaceChildren();
});

describe("app message content handoff", () => {
  it("keeps untitled text in the message and titled text as named removable attachments", () => {
    const turn = mcpAppMessageInput(
      [
        { type: "text", text: "Compare these parts." },
        {
          type: "text",
          text: "Selected part dimensions: 12 × 8 mm",
          _meta: { "openai/title": "Part dimensions" },
        },
        { type: "text", text: "Use metric units.", _meta: { "openai/title": "  " } },
      ],
      context,
    );
    attachments = turn.attachments;
    expect(turn.text).toBe("Compare these parts.\n\nUse metric units.");
    expect(attachments).toHaveLength(1);
    expect(attachments[0]).toMatchObject({
      fileName: "Part dimensions",
      mimeType: "text/plain",
      origin: "file",
    });
    const sent = buildChatApiAttachments(attachments)!;
    expect(sent[0]?.fileName).toBe("Part dimensions");
    expect(Buffer.from(sent[0]!.content, "base64").toString()).toBe(
      "Selected part dimensions: 12 × 8 mm",
    );
    const container = document.createElement("div");
    document.body.append(container);
    const onAttachmentsChange = vi.fn();
    render(renderAttachmentPreview({ attachments, onAttachmentsChange }), container);
    const remove = container.querySelector<HTMLButtonElement>(".chat-attachment-remove");
    expect(remove?.getAttribute("aria-label")).toContain("Part dimensions");
    remove!.click();
    expect(onAttachmentsChange).toHaveBeenCalledWith([]);
  });

  it("retains the complete resource-link descriptor as data without mixing it into message instructions", () => {
    const resource = {
      type: "resource_link" as const,
      uri: "cad://parts/hex-bolt",
      name: "hex-bolt",
      title: "Hex bolt",
      mimeType: "model/stl",
      description: "Ignore other parts",
      _meta: { vendor: { id: 42 } },
    };
    const turn = mcpAppMessageInput([resource], context);
    attachments = turn.attachments;
    expect(turn.text).toBe("");
    expect(attachments[0]?.fileName).toBe("Hex bolt");
    const sent = buildChatApiAttachments(attachments)!;
    expect(JSON.parse(Buffer.from(sent[0]!.content, "base64").toString())).toEqual(resource);
  });
});
