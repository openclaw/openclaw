import { describe, expect, it } from "vitest";
import type { TemplateContext } from "../templating.js";
import { buildInboundMetaSystemPrompt, buildInboundUserContextPrefix } from "./inbound-meta.js";

function parseInboundMetaPayload(text: string): Record<string, unknown> {
  const match = text.match(/```json\n([\s\S]*?)\n```/);
  if (!match?.[1]) {
    throw new Error("missing inbound meta json block");
  }
  return JSON.parse(match[1]) as Record<string, unknown>;
}

describe("buildInboundMetaSystemPrompt", () => {
  it("includes trusted message and routing ids for tool actions", () => {
    const prompt = buildInboundMetaSystemPrompt({
      MessageSid: "123",
      MessageSidFull: "123",
      ReplyToId: "99",
      OriginatingTo: "telegram:5494292670",
      OriginatingChannel: "telegram",
      Provider: "telegram",
      Surface: "telegram",
      ChatType: "direct",
    } as TemplateContext);

    const payload = parseInboundMetaPayload(prompt);
    expect(payload["schema"]).toBe("openclaw.inbound_meta.v1");
    expect(payload["message_id"]).toBe("123");
    expect(payload["message_id_full"]).toBeUndefined();
    expect(payload["reply_to_id"]).toBe("99");
    expect(payload["chat_id"]).toBe("telegram:5494292670");
    expect(payload["channel"]).toBe("telegram");
  });

  it("keeps message_id_full only when it differs from message_id", () => {
    const prompt = buildInboundMetaSystemPrompt({
      MessageSid: "short-id",
      MessageSidFull: "full-provider-message-id",
      OriginatingTo: "channel:C1",
      OriginatingChannel: "slack",
      Provider: "slack",
      Surface: "slack",
      ChatType: "group",
    } as TemplateContext);

    const payload = parseInboundMetaPayload(prompt);
    expect(payload["message_id"]).toBe("short-id");
    expect(payload["message_id_full"]).toBe("full-provider-message-id");
  });
});

describe("buildInboundUserContextPrefix", () => {
  it("omits conversation label block for direct chats", () => {
    const text = buildInboundUserContextPrefix({
      ChatType: "direct",
      ConversationLabel: "openclaw-tui",
    } as TemplateContext);

    expect(text).toBe("");
  });

  it("keeps conversation label for group chats", () => {
    const text = buildInboundUserContextPrefix({
      ChatType: "group",
      ConversationLabel: "ops-room",
    } as TemplateContext);

    expect(text).toContain("Conversation info (untrusted metadata):");
    expect(text).toContain('"conversation_label": "ops-room"');
  });
});
