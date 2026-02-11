import { describe, expect, it } from "vitest";
import type { ContactContext } from "../../config/group-policy.js";
import type { TemplateContext } from "../templating.js";
import { buildInboundMetaSystemPrompt } from "./inbound-meta.js";

const baseCtx: TemplateContext = {
  Provider: "whatsapp",
  Surface: "whatsapp",
  OriginatingChannel: "whatsapp",
  ChatType: "direct",
  Body: "Hello",
};

describe("buildInboundMetaSystemPrompt", () => {
  it("builds basic metadata without contact context", () => {
    const result = buildInboundMetaSystemPrompt(baseCtx);

    expect(result).toContain('"schema": "openclaw.inbound_meta.v1"');
    expect(result).toContain('"channel": "whatsapp"');
    expect(result).toContain('"chat_type": "direct"');
    expect(result).not.toContain('"contact":');
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

    const result = buildInboundMetaSystemPrompt(baseCtx, { contactContext });

    expect(result).toContain('"name": "Alice Smith"');
    expect(result).toContain('"groups": [');
    expect(result).toContain('"close_friends"');
    expect(result).toContain('"family"');
    expect(result).toContain('"verified": true');
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

  it("does not include instructions section when none exist", () => {
    const contactContext: ContactContext = {
      entry: { key: "alice", phone: "+15551234567", name: "Alice" },
      groups: [{ key: "friends" }], // No instructions
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

    const result = buildInboundMetaSystemPrompt(baseCtx, { contactContext });

    expect(result).toContain('"is_owner": true');
  });

  it("omits contact.name when entry is not found", () => {
    const contactContext: ContactContext = {
      entry: undefined,
      groups: [],
      verified: true,
      isOwner: false,
      instructions: undefined,
    };

    const result = buildInboundMetaSystemPrompt(baseCtx, { contactContext });

    // Should have contact block with verified but no name
    expect(result).toContain('"verified": true');
    expect(result).not.toContain('"name":');
  });

  it("marks unverified channel correctly", () => {
    const contactContext: ContactContext = {
      entry: undefined,
      groups: [],
      verified: false,
      isOwner: false,
      instructions: undefined,
    };

    const result = buildInboundMetaSystemPrompt(baseCtx, { contactContext });

    expect(result).toContain('"verified": false');
  });

  it("handles group chat type", () => {
    const groupCtx: TemplateContext = {
      ...baseCtx,
      ChatType: "group",
      WasMentioned: true,
    };

    const result = buildInboundMetaSystemPrompt(groupCtx);

    expect(result).toContain('"chat_type": "group"');
    expect(result).toContain('"is_group_chat": true');
    expect(result).toContain('"was_mentioned": true');
  });
});
