import { describe, it, expect, vi } from "vitest";
import type { ReplyPayload } from "../types.js";
import { normalizeReplyPayload } from "./normalize-reply.js";

function makePayload(overrides: Partial<ReplyPayload> = {}): ReplyPayload {
  return { text: "", ...overrides };
}

describe("normalizeReplyPayload — NO_REPLY handling", () => {
  it("suppresses exact NO_REPLY (text-only)", () => {
    const onSkip = vi.fn();
    const result = normalizeReplyPayload(makePayload({ text: "NO_REPLY" }), { onSkip });
    expect(result).toBeNull();
    expect(onSkip).toHaveBeenCalledWith("silent");
  });

  it("suppresses NO_REPLY with surrounding whitespace", () => {
    const result = normalizeReplyPayload(makePayload({ text: "  NO_REPLY  " }));
    expect(result).toBeNull();
  });

  // Regression: #XXXXX — reasoning preamble before NO_REPLY must be suppressed,
  // not posted as the message content.
  it("suppresses reasoning preamble before trailing NO_REPLY (text-only)", () => {
    const onSkip = vi.fn();
    const result = normalizeReplyPayload(makePayload({ text: "not directed at me. NO_REPLY" }), {
      onSkip,
    });
    expect(result).toBeNull();
    expect(onSkip).toHaveBeenCalledWith("silent");
  });

  it("suppresses multi-sentence reasoning preamble before NO_REPLY", () => {
    const result = normalizeReplyPayload(
      makePayload({ text: "This is a message from @jentic. Not for me. Stay silent.\nNO_REPLY" }),
    );
    expect(result).toBeNull();
  });

  // (#30916, #30955) — emoji alongside channelData: strip token from text,
  // let non-text content (e.g. channel reaction) send through.
  it("strips NO_REPLY from text when non-text channelData is present", () => {
    const result = normalizeReplyPayload(
      makePayload({
        text: "😄 NO_REPLY",
        channelData: { reactions: [{ emoji: "😄" }] } as ReplyPayload["channelData"],
      }),
    );
    // Non-null because channelData carries the reaction
    expect(result).not.toBeNull();
    // The NO_REPLY token must not appear in the output text
    expect(result?.text).not.toContain("NO_REPLY");
  });

  it("strips NO_REPLY from text when media is present, sends media", () => {
    const result = normalizeReplyPayload(
      makePayload({ text: "NO_REPLY", mediaUrl: "https://example.com/image.png" }),
    );
    expect(result).not.toBeNull();
    expect(result?.mediaUrl).toBe("https://example.com/image.png");
  });
});
