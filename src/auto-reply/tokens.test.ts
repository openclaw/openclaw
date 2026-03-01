import { describe, it, expect } from "vitest";
import { isSilentReplyPrefixText, isSilentReplyText } from "./tokens.js";

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

import { stripTrailingSilentToken } from "./tokens.js";

describe("stripTrailingSilentToken", () => {
  it("strips trailing NO_REPLY after substantive content", () => {
    const text = "Here is a summary of the weather.\n\nNO_REPLY";
    expect(stripTrailingSilentToken(text)).toBe("Here is a summary of the weather.");
  });

  it("strips trailing NO_REPLY with extra whitespace", () => {
    const text = "Content here\n  NO_REPLY  ";
    expect(stripTrailingSilentToken(text)).toBe("Content here");
  });

  it("does not strip when NO_REPLY is the entire text", () => {
    expect(stripTrailingSilentToken("NO_REPLY")).toBe("NO_REPLY");
    expect(stripTrailingSilentToken("  NO_REPLY  ")).toBe("  NO_REPLY  ");
  });

  it("does not strip NO_REPLY embedded in content", () => {
    const text = "This is NO_REPLY related content";
    expect(stripTrailingSilentToken(text)).toBe(text);
  });

  it("returns undefined for undefined input", () => {
    expect(stripTrailingSilentToken(undefined)).toBeUndefined();
  });

  it("returns empty string as-is", () => {
    expect(stripTrailingSilentToken("")).toBe("");
  });

  it("works with custom token", () => {
    const text = "Done checking.\nHEARTBEAT_OK";
    expect(stripTrailingSilentToken(text, "HEARTBEAT_OK")).toBe("Done checking.");
  });
});
