import { describe, expect, it } from "vitest";
import type { ContactContext } from "../../config/group-policy.js";
import type { TemplateContext } from "../templating.js";
import { buildInboundMetaSystemPrompt, buildInboundUserContextPrefix } from "./inbound-meta.js";

function parseInboundMetaPayload(text: string): Record<string, unknown> {
  const match = text.match(/```json\n([\s\S]*?)\n```/);
  if (!match?.[1]) {
    throw new Error("missing inbound meta json block");
  }
  return JSON.parse(match[1]) as Record<string, unknown>;
}

const baseCtx: TemplateContext = {
  Provider: "whatsapp",
  Surface: "whatsapp",
  OriginatingChannel: "whatsapp",
  ChatType: "direct",
  Body: "Hello",
};

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

  it("includes sender_id when provided", () => {
    const prompt = buildInboundMetaSystemPrompt({
      MessageSid: "456",
      SenderId: "289522496",
      OriginatingTo: "telegram:-1001249586642",
      OriginatingChannel: "telegram",
      Provider: "telegram",
      Surface: "telegram",
      ChatType: "group",
    } as TemplateContext);

    const payload = parseInboundMetaPayload(prompt);
    expect(payload["sender_id"]).toBe("289522496");
  });

  it("trims sender_id before storing", () => {
    const prompt = buildInboundMetaSystemPrompt({
      MessageSid: "457",
      SenderId: "  289522496  ",
      OriginatingTo: "telegram:-1001249586642",
      OriginatingChannel: "telegram",
      Provider: "telegram",
      Surface: "telegram",
      ChatType: "group",
    } as TemplateContext);

    const payload = parseInboundMetaPayload(prompt);
    expect(payload["sender_id"]).toBe("289522496");
  });

  it("omits sender_id when blank", () => {
    const prompt = buildInboundMetaSystemPrompt({
      MessageSid: "458",
      SenderId: "   ",
      OriginatingTo: "telegram:-1001249586642",
      OriginatingChannel: "telegram",
      Provider: "telegram",
      Surface: "telegram",
      ChatType: "group",
    } as TemplateContext);

    const payload = parseInboundMetaPayload(prompt);
    expect(payload["sender_id"]).toBeUndefined();
  });

  it("omits sender_id when not provided", () => {
    const prompt = buildInboundMetaSystemPrompt({
      MessageSid: "789",
      OriginatingTo: "telegram:5494292670",
      OriginatingChannel: "telegram",
      Provider: "telegram",
      Surface: "telegram",
      ChatType: "direct",
    } as TemplateContext);

    const payload = parseInboundMetaPayload(prompt);
    expect(payload["sender_id"]).toBeUndefined();
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

  it("builds basic metadata without contact context", () => {
    const payload = parseInboundMetaPayload(buildInboundMetaSystemPrompt(baseCtx));
    expect(payload["schema"]).toBe("openclaw.inbound_meta.v1");
    expect(payload["channel"]).toBe("whatsapp");
    expect(payload["chat_type"]).toBe("direct");
    expect(payload["contact"]).toBeUndefined();
  });

  it("includes contact context when provided", () => {
    const contactContext: ContactContext = {
      entry: { key: "alice", phone: "+15551234567", name: "Alice Smith" },
      groups: [
        { key: "close_friends", instructions: "Be casual." },
        { key: "family", instructions: "Share updates." },
      ],
      verified: true,
      isOwner: false,
      instructions: "Be casual.\n\nShare updates.",
    };

    const payload = parseInboundMetaPayload(
      buildInboundMetaSystemPrompt(baseCtx, { contactContext }),
    );
    const contact = payload["contact"] as Record<string, unknown>;
    expect(contact["name"]).toBe("Alice Smith");
    expect(contact["verified"]).toBe(true);
    expect(contact["groups"]).toEqual(["close_friends", "family"]);
  });

  it("injects contact instructions section", () => {
    const contactContext: ContactContext = {
      entry: { key: "alice", phone: "+15551234567", name: "Alice" },
      groups: [{ key: "friends", instructions: "Be friendly and casual." }],
      verified: true,
      isOwner: false,
      instructions: "Be friendly and casual.",
    };

    const result = buildInboundMetaSystemPrompt(baseCtx, { contactContext });
    expect(result).toContain("## Contact Instructions");
    expect(result).toContain("Be friendly and casual.");
  });

  it("does not include contact instructions section when none exist", () => {
    const contactContext: ContactContext = {
      entry: { key: "alice", phone: "+15551234567", name: "Alice" },
      groups: [{ key: "friends" }],
      verified: true,
      isOwner: false,
      instructions: undefined,
    };

    const result = buildInboundMetaSystemPrompt(baseCtx, { contactContext });
    expect(result).not.toContain("## Contact Instructions");
  });

  it("includes is_owner flag when sender is owner", () => {
    const contactContext: ContactContext = {
      entry: undefined,
      groups: [],
      verified: true,
      isOwner: true,
      instructions: undefined,
    };

    const payload = parseInboundMetaPayload(
      buildInboundMetaSystemPrompt(baseCtx, { contactContext }),
    );
    const contact = payload["contact"] as Record<string, unknown>;
    expect(contact["is_owner"]).toBe(true);
  });

  it("omits contact.name when entry is not found", () => {
    const contactContext: ContactContext = {
      entry: undefined,
      groups: [],
      verified: true,
      isOwner: false,
      instructions: undefined,
    };

    const payload = parseInboundMetaPayload(
      buildInboundMetaSystemPrompt(baseCtx, { contactContext }),
    );
    const contact = payload["contact"] as Record<string, unknown>;
    expect(contact["verified"]).toBe(true);
    expect(contact["name"]).toBeUndefined();
  });

  it("marks unverified channel correctly", () => {
    const contactContext: ContactContext = {
      entry: undefined,
      groups: [],
      verified: false,
      isOwner: false,
      instructions: undefined,
    };

    const payload = parseInboundMetaPayload(
      buildInboundMetaSystemPrompt(baseCtx, { contactContext }),
    );
    const contact = payload["contact"] as Record<string, unknown>;
    expect(contact["verified"]).toBe(false);
  });

  it("handles group chat type", () => {
    const groupCtx: TemplateContext = {
      ...baseCtx,
      ChatType: "group",
      WasMentioned: true,
    };

    const payload = parseInboundMetaPayload(buildInboundMetaSystemPrompt(groupCtx));
    expect(payload["chat_type"]).toBe("group");
    const flags = payload["flags"] as Record<string, unknown>;
    expect(flags["is_group_chat"]).toBe(true);
    expect(flags["was_mentioned"]).toBe(true);
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
