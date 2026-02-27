import { describe, it, expect } from "vitest";
import { isSilentReplyPrefixText, isSilentReplyText, stripSilentToken } from "./tokens.js";

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

  // Regression: \W and \b anchors match all non-ASCII chars, causing CJK messages
  // containing the token to be silently dropped (#24773).
  it("returns false for CJK text containing the token (#24773)", () => {
    expect(isSilentReplyText("好的，NO_REPLY 只是一个例子")).toBe(false);
    expect(isSilentReplyText("NO_REPLY 只是一个例子")).toBe(false);
    expect(isSilentReplyText("好的 NO_REPLY")).toBe(false);
    expect(isSilentReplyText("HEARTBEAT_OK 确认", "HEARTBEAT_OK")).toBe(false);
    expect(isSilentReplyText("返事なし NO_REPLY")).toBe(false);
    expect(isSilentReplyText("NO_REPLY 返事なし")).toBe(false);
  });

  // Unicode whitespace (e.g. U+3000 ideographic space, U+00A0 non-breaking space)
  // must be accepted around the bare token, not just ASCII spaces.
  it("returns true for token surrounded by Unicode whitespace", () => {
    // U+3000 ideographic space (common in CJK input methods)
    expect(isSilentReplyText("\u3000NO_REPLY\u3000")).toBe(true);
    expect(isSilentReplyText("\u3000NO_REPLY")).toBe(true);
    expect(isSilentReplyText("NO_REPLY\u3000")).toBe(true);
    // U+00A0 non-breaking space
    expect(isSilentReplyText("\u00A0NO_REPLY\u00A0")).toBe(true);
    // Mixed Unicode and ASCII whitespace
    expect(isSilentReplyText(" \u3000 NO_REPLY \u3000 ")).toBe(true);
  });

  // CJK text with Unicode whitespace around the token must NOT be treated as silent.
  it("returns false for CJK text with Unicode whitespace around the token (#24773)", () => {
    expect(isSilentReplyText("好的\u3000NO_REPLY")).toBe(false);
    expect(isSilentReplyText("NO_REPLY\u3000返事なし")).toBe(false);
    expect(isSilentReplyText("\u3000好的 NO_REPLY\u3000")).toBe(false);
  });
});

describe("stripSilentToken", () => {
  it("strips token from end of text", () => {
    expect(stripSilentToken("Done.\n\nNO_REPLY")).toBe("Done.");
  });

  it("does not strip token from start of text", () => {
    expect(stripSilentToken("NO_REPLY 👍")).toBe("NO_REPLY 👍");
  });

  it("strips token with emoji (#30916)", () => {
    expect(stripSilentToken("😄 NO_REPLY")).toBe("😄");
  });

  it("does not strip embedded token suffix without whitespace delimiter", () => {
    expect(stripSilentToken("interject.NO_REPLY")).toBe("interject.NO_REPLY");
  });

  it("strips only trailing occurrence", () => {
    expect(stripSilentToken("NO_REPLY ok NO_REPLY")).toBe("NO_REPLY ok");
  });

  it("returns empty string when only token remains", () => {
    expect(stripSilentToken("NO_REPLY")).toBe("");
    expect(stripSilentToken("  NO_REPLY  ")).toBe("");
  });

  it("strips token preceded by bold markdown formatting", () => {
    expect(stripSilentToken("**NO_REPLY")).toBe("");
    expect(stripSilentToken("some text **NO_REPLY")).toBe("some text");
    expect(stripSilentToken("reasoning**NO_REPLY")).toBe("reasoning");
  });

  it("works with custom token", () => {
    expect(stripSilentToken("done HEARTBEAT_OK", "HEARTBEAT_OK")).toBe("done");
  });
});

describe("isSilentReplyPrefixText", () => {
  it("matches uppercase token lead fragments", () => {
    expect(isSilentReplyPrefixText("NO")).toBe(true);
    expect(isSilentReplyPrefixText("NO_")).toBe(true);
    expect(isSilentReplyPrefixText("NO_RE")).toBe(true);
    expect(isSilentReplyPrefixText("NO_REPLY")).toBe(true);
    expect(isSilentReplyPrefixText("  HEARTBEAT_", "HEARTBEAT_OK")).toBe(true);
  });

  it("rejects ambiguous natural-language prefixes", () => {
    expect(isSilentReplyPrefixText("N")).toBe(false);
    expect(isSilentReplyPrefixText("No")).toBe(false);
    expect(isSilentReplyPrefixText("no")).toBe(false);
    expect(isSilentReplyPrefixText("Hello")).toBe(false);
  });

  it("keeps underscore guard for non-NO_REPLY tokens", () => {
    expect(isSilentReplyPrefixText("HE", "HEARTBEAT_OK")).toBe(false);
    expect(isSilentReplyPrefixText("HEART", "HEARTBEAT_OK")).toBe(false);
    expect(isSilentReplyPrefixText("HEARTBEAT", "HEARTBEAT_OK")).toBe(false);
    expect(isSilentReplyPrefixText("HEARTBEAT_", "HEARTBEAT_OK")).toBe(true);
  });

  it("rejects non-prefixes and mixed characters", () => {
    expect(isSilentReplyPrefixText("NO_X")).toBe(false);
    expect(isSilentReplyPrefixText("NO_REPLY more")).toBe(false);
    expect(isSilentReplyPrefixText("NO-")).toBe(false);
  });

  // trimStart() in modern JS handles Unicode whitespace (U+3000, U+00A0, etc.)
  it("accepts prefix with leading Unicode whitespace", () => {
    expect(isSilentReplyPrefixText("\u3000NO_")).toBe(true);
    expect(isSilentReplyPrefixText("\u00A0NO_RE")).toBe(true);
  });
});
