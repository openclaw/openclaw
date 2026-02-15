import { describe, expect, it } from "vitest";
import type { TemplateContext } from "../templating.js";
import { buildInboundUserContextPrefix } from "./inbound-meta.js";

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
    expect(text).toContain('"conversation_label":"ops-room"');
  });
});

describe("buildInboundUserContextPrefix", () => {
  it("includes message_time from ctx.Timestamp using envelope formatting", () => {
    const text = buildInboundUserContextPrefix(
      {
        ChatType: "group",
        ConversationLabel: "Ops",
        Timestamp: 1700000000000,
      } satisfies TemplateContext,
      { envelope: { timezone: "utc" } },
    );

    expect(text).toContain("Conversation info (untrusted metadata):");
    expect(text).toContain('"message_time":"Tue 2023-11-14T22:13Z"');
  });

  it("omits message_time when Timestamp is missing", () => {
    const text = buildInboundUserContextPrefix({
      ChatType: "group",
      ConversationLabel: "Ops",
    } satisfies TemplateContext);

    expect(text).toContain("Conversation info (untrusted metadata):");
    expect(text).not.toContain('"message_time"');
  });

  it("respects envelopeTimestamp=off and omits message_time", () => {
    const text = buildInboundUserContextPrefix(
      {
        ChatType: "group",
        ConversationLabel: "Ops",
        Timestamp: 1700000000000,
      } satisfies TemplateContext,
      { envelope: { timezone: "utc", includeTimestamp: false } },
    );

    expect(text).not.toContain('"message_time"');
  });
});
