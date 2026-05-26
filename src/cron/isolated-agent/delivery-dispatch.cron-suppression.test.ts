import { describe, expect, it } from "vitest";
import { SILENT_REPLY_TOKEN } from "../../auto-reply/tokens.js";
import { normalizeCronOutboundReplyText } from "./delivery-dispatch.js";

describe("normalizeCronOutboundReplyText: cron-announce REPLY_SKIP / ANNOUNCE_SKIP suppression (#85421)", () => {
  it("drops the body when the whole reply is REPLY_SKIP", () => {
    const result = normalizeCronOutboundReplyText("REPLY_SKIP");
    expect(result.text).toBeUndefined();
    expect(result.strippedTrailingSilentToken).toBe(false);
  });

  it("drops the body when the whole reply is ANNOUNCE_SKIP", () => {
    const result = normalizeCronOutboundReplyText("ANNOUNCE_SKIP");
    expect(result.text).toBeUndefined();
    expect(result.strippedTrailingSilentToken).toBe(false);
  });

  it("drops the body when the whole reply is the silent reply token", () => {
    const result = normalizeCronOutboundReplyText(SILENT_REPLY_TOKEN);
    expect(result.text).toBeUndefined();
    expect(result.strippedTrailingSilentToken).toBe(false);
  });

  it("ignores surrounding whitespace around the control token (the chat-display path already trims)", () => {
    expect(normalizeCronOutboundReplyText("  REPLY_SKIP  ").text).toBeUndefined();
    expect(normalizeCronOutboundReplyText("\n\nANNOUNCE_SKIP\n").text).toBeUndefined();
  });

  it("does not suppress when the control token is embedded in real content (only whole-text tokens are control)", () => {
    const result = normalizeCronOutboundReplyText(
      "Daily summary: nothing urgent today. (REPLY_SKIP would suppress.)",
    );
    expect(result.text).toBe("Daily summary: nothing urgent today. (REPLY_SKIP would suppress.)");
    expect(result.strippedTrailingSilentToken).toBe(false);
  });

  it("preserves the existing partial-trailing silent-token stripping for mixed content", () => {
    const result = normalizeCronOutboundReplyText(`Here is the report.\n${SILENT_REPLY_TOKEN}`);
    expect(result.text).toBe("Here is the report.");
    expect(result.strippedTrailingSilentToken).toBe(true);
  });

  it("returns the normal reply unchanged for ordinary cron output", () => {
    const result = normalizeCronOutboundReplyText("All systems green.");
    expect(result.text).toBe("All systems green.");
    expect(result.strippedTrailingSilentToken).toBe(false);
  });

  it("passes through undefined / empty inputs", () => {
    expect(normalizeCronOutboundReplyText(undefined).text).toBeUndefined();
    expect(normalizeCronOutboundReplyText("").text).toBe("");
    expect(normalizeCronOutboundReplyText("   ").strippedTrailingSilentToken).toBe(false);
  });
});
