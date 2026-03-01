import { describe, it, expect } from "vitest";
import { isSilentReplyPrefixText, isSilentReplyText, stripSilentReplyToken } from "./tokens.js";

describe("isSilentReplyText", () => {
  it("returns true for exact token", () => {
    expect(isSilentReplyText("NO_REPLY")).toBe(true);
  });

  it("returns true for token with surrounding whitespace", () => {
    expect(isSilentReplyText("  NO_REPLY  ")).toBe(true);
    expect(isSilentReplyText("\nNO_REPLY\n")).toBe(true);
  });

  it("returns false for undefined/empty", () => {
    expect(isSilentReplyText(undefined)).toBe(false);
    expect(isSilentReplyText("")).toBe(false);
  });

  it("returns false for substantive text ending with token (#19537)", () => {
    const text = "Here is a helpful response.\n\nNO_REPLY";
    expect(isSilentReplyText(text)).toBe(false);
  });

  it("returns false for substantive text starting with token", () => {
    const text = "NO_REPLY but here is more content";
    expect(isSilentReplyText(text)).toBe(false);
  });

  it("returns false for token embedded in text", () => {
    expect(isSilentReplyText("Please NO_REPLY to this")).toBe(false);
  });

  it("works with custom token", () => {
    expect(isSilentReplyText("HEARTBEAT_OK", "HEARTBEAT_OK")).toBe(true);
    expect(isSilentReplyText("Checked inbox. HEARTBEAT_OK", "HEARTBEAT_OK")).toBe(false);
  });
});

describe("stripSilentReplyToken", () => {
  it("strips trailing NO_REPLY after real content", () => {
    const result = stripSilentReplyToken("Here is the answer\n\nNO_REPLY");
    expect(result.didStrip).toBe(true);
    expect(result.text).toBe("Here is the answer");
  });

  it("strips trailing NO_REPLY separated by a single space", () => {
    const result = stripSilentReplyToken("Done. NO_REPLY");
    expect(result.didStrip).toBe(true);
    expect(result.text).toBe("Done.");
  });

  it("strips trailing NO_REPLY with trailing punctuation", () => {
    const result = stripSilentReplyToken("All good.\n\nNO_REPLY.");
    expect(result.didStrip).toBe(true);
    expect(result.text).toBe("All good.");
  });

  it("strips trailing NO_REPLY with trailing whitespace", () => {
    const result = stripSilentReplyToken("Content here\nNO_REPLY\n");
    expect(result.didStrip).toBe(true);
    expect(result.text).toBe("Content here");
  });

  it("returns empty text for token-only input", () => {
    // When text is just whitespace + token, the trailing regex matches
    // (leading whitespace satisfies the \s+ prefix).  The caller
    // (normalizeReplyPayload) handles the empty-after-strip case.
    const result = stripSilentReplyToken("  NO_REPLY  ");
    expect(result.text).toBe("");
    expect(result.didStrip).toBe(true);
  });

  it("does not strip token embedded in a word", () => {
    const result = stripSilentReplyToken("PleaseNO_REPLY");
    expect(result.didStrip).toBe(false);
    expect(result.text).toBe("PleaseNO_REPLY");
  });

  it("handles undefined input", () => {
    const result = stripSilentReplyToken(undefined);
    expect(result.didStrip).toBe(false);
    expect(result.text).toBe("");
  });

  it("handles text without the token", () => {
    const result = stripSilentReplyToken("Just a normal message");
    expect(result.didStrip).toBe(false);
    expect(result.text).toBe("Just a normal message");
  });

  it("strips multiple trailing tokens", () => {
    const result = stripSilentReplyToken("Answer here\nNO_REPLY\nNO_REPLY");
    expect(result.didStrip).toBe(true);
    expect(result.text).toBe("Answer here");
  });

  it("works with custom token", () => {
    const result = stripSilentReplyToken("Check done\n\nHEARTBEAT_OK", "HEARTBEAT_OK");
    expect(result.didStrip).toBe(true);
    expect(result.text).toBe("Check done");
  });

  it("matches the exact issue scenario from #30916", () => {
    const text =
      "File's there. Same false failure as before — cron reports error but the write actually succeeded. Not urgent.\n\nNO_REPLY";
    const result = stripSilentReplyToken(text);
    expect(result.didStrip).toBe(true);
    expect(result.text).toBe(
      "File's there. Same false failure as before — cron reports error but the write actually succeeded. Not urgent.",
    );
  });
});

describe("isSilentReplyPrefixText", () => {
  it("matches uppercase underscore prefixes", () => {
    expect(isSilentReplyPrefixText("NO_")).toBe(true);
    expect(isSilentReplyPrefixText("NO_RE")).toBe(true);
    expect(isSilentReplyPrefixText("NO_REPLY")).toBe(true);
    expect(isSilentReplyPrefixText("  HEARTBEAT_", "HEARTBEAT_OK")).toBe(true);
  });

  it("rejects ambiguous natural-language prefixes", () => {
    expect(isSilentReplyPrefixText("N")).toBe(false);
    expect(isSilentReplyPrefixText("No")).toBe(false);
    expect(isSilentReplyPrefixText("Hello")).toBe(false);
  });

  it("rejects non-prefixes and mixed characters", () => {
    expect(isSilentReplyPrefixText("NO_X")).toBe(false);
    expect(isSilentReplyPrefixText("NO_REPLY more")).toBe(false);
    expect(isSilentReplyPrefixText("NO-")).toBe(false);
  });
});
