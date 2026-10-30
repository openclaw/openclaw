/**
 * The Telegram "Current message:" block, split out of inbound-meta.test.ts so that
 * file stays under the line cap (the ratchet rejects growth on a file that is
 * already over it). Subject: src/auto-reply/reply/inbound-meta.current-message.ts.
 */
import { describe, expect, it } from "vitest";
import type { TemplateContext } from "../templating.js";
import { projectTelegramCurrentMessageCarrier } from "./inbound-meta.current-message.js";
import { buildInboundUserContextPrefix } from "./inbound-meta.js";

// The carrier projection of the inbound user-context prefix, as reply preparation
// (get-reply-run-context.ts) builds it for the separate runtime-context carrier.
function buildCarrierContext(ctx: TemplateContext): string {
  return projectTelegramCurrentMessageCarrier(
    buildInboundUserContextPrefix(ctx, { timezone: "utc" }),
    ctx,
  );
}

describe("projectTelegramCurrentMessageCarrier — Telegram current-message carrier", () => {
  it("states the current message body inside the Telegram current-message block", () => {
    const body = "What's the end result?";
    const text = buildCarrierContext({
      Provider: "telegram",
      Surface: "telegram",
      OriginatingChannel: "telegram",
      ChatType: "group",
      MessageSid: "34974",
      ReplyToId: "34971",
      ReplyToBody: "The full message should not be preferred.",
      ReplyToQuoteText: " selected quote\n",
      SenderName: "obviyus",
      Timestamp: Date.UTC(2026, 4, 10, 17, 8),
      agentText: body,
      Body: body,
      BodyForAgent: body,
    } as TemplateContext);

    // The carrier block is a separate model-facing message; a bare "#34974:"
    // header is read as an empty (elided) current-message body and real
    // instructions get treated as absent/duplicate. The body must be stated
    // inside the block itself.
    expect(text).toContain(`Current message:\n[Replying to: "selected quote"]\n#34974: ${body}`);
    const currentMessageBlock = text.split("Current message:").at(-1) ?? "";
    expect(currentMessageBlock.trimEnd().endsWith("#34974:")).toBe(false);
  });
  it("preserves the bare Telegram current-message header when the turn has no body", () => {
    const text = buildCarrierContext({
      Provider: "telegram",
      Surface: "telegram",
      OriginatingChannel: "telegram",
      ChatType: "group",
      MessageSid: "34974",
      ReplyToId: "34971",
      ReplyToQuoteText: " selected quote\n",
      SenderName: "obviyus",
    } as TemplateContext);

    expect(text).toContain('Current message:\n[Replying to: "selected quote"]\n#34974:');
    expect(text.trimEnd().endsWith("#34974:")).toBe(true);
  });

  it("states the current body without a header when the Telegram turn has no message id", () => {
    // Before the carrier fix this block rendered as quote-only: no header line and
    // no body. The body now stands where the header would be, so a turn without a
    // message id is still self-contained rather than silently bodyless.
    const text = buildCarrierContext({
      Provider: "telegram",
      Surface: "telegram",
      OriginatingChannel: "telegram",
      ChatType: "group",
      ReplyToId: "34971",
      ReplyToQuoteText: " selected quote\n",
      SenderName: "obviyus",
      Body: "ship it",
    } as TemplateContext);

    expect(text).toContain('Current message:\n[Replying to: "selected quote"]\nship it');
    expect(text).not.toMatch(/#\S*:/);
  });

  it("prefers agentText and collapses whitespace for the Telegram current-message body", () => {
    const text = buildCarrierContext({
      Provider: "telegram",
      Surface: "telegram",
      OriginatingChannel: "telegram",
      ChatType: "group",
      MessageSid: "34974",
      ReplyToId: "34971",
      ReplyToQuoteText: " selected quote\n",
      SenderName: "obviyus",
      agentText: "agent\n\n  text",
      BodyForAgent: "body for agent",
      Body: "raw body",
    } as TemplateContext);

    expect(text).toContain('Current message:\n[Replying to: "selected quote"]\n#34974: agent text');
    expect(text).not.toContain("body for agent");
    expect(text).not.toContain("raw body");
  });
});
