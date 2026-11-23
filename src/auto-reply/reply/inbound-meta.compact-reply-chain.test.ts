// Tests that the compact inbound context keeps reply facts a channel supplies only as ReplyChain.
import { describe, expect, it } from "vitest";
import type { TemplateContext } from "../templating.js";
import { buildCompactInboundUserContextPrefix } from "./inbound-meta.js";

const base = {
  ChatType: "group",
  MessageSid: "current",
  SenderName: "Onur",
  SenderId: "user-1",
  Timestamp: 2_000,
} as const;

describe("compact inbound reply target from ReplyChain", () => {
  it("renders a ReplyChain-only quote (Nextcloud Talk) as the reply target", () => {
    const projection = buildCompactInboundUserContextPrefix({
      ...base,
      ReplyChain: [{ messageId: "41", sender: "Alice", body: "ship it on Friday", isQuote: true }],
    } as TemplateContext);

    expect(projection.text).toContain(
      'Reply target: {"sender":"Alice","body":"ship it on Friday","is_quote":true}',
    );
  });

  it("uses the nearest ReplyChain entry that has a body", () => {
    const projection = buildCompactInboundUserContextPrefix({
      ...base,
      ReplyChain: [
        { messageId: "42", sender: "Bob" },
        { messageId: "41", sender: "Alice", body: "first question" },
        { messageId: "40", sender: "Carol", body: "older message" },
      ],
    } as TemplateContext);

    expect(projection.text).toContain('Reply target: {"sender":"Alice","body":"first question"}');
    expect(projection.text).not.toContain("older message");
  });

  it("keeps ReplyToBody and ReplyToSender ahead of ReplyChain", () => {
    const projection = buildCompactInboundUserContextPrefix({
      ...base,
      ReplyToBody: "direct reply body",
      ReplyToSender: "Dana",
      ReplyChain: [{ messageId: "41", sender: "Alice", body: "chain body" }],
    } as TemplateContext);

    expect(projection.text).toContain('Reply target: {"sender":"Dana","body":"direct reply body"}');
    expect(projection.text).not.toContain("chain body");
  });
});
