import { describe, it, expect } from "vitest";
import {
  isSilentReplyPrefixText,
  isSilentReplyText,
  stripTrailingSilentReplyToken,
} from "./tokens.js";

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

describe("stripTrailingSilentReplyToken", () => {
  it("strips trailing NO_REPLY after newline", () => {
    const { text, didStrip } = stripTrailingSilentReplyToken("File's there.\n\nNO_REPLY");
    expect(didStrip).toBe(true);
    expect(text).toBe("File's there.");
  });

  it("strips trailing NO_REPLY with whitespace", () => {
    const { text, didStrip } = stripTrailingSilentReplyToken("Done.\n NO_REPLY ");
    expect(didStrip).toBe(true);
    expect(text).toBe("Done.");
  });

  it("does not strip exact NO_REPLY", () => {
    const { text, didStrip } = stripTrailingSilentReplyToken("NO_REPLY");
    expect(didStrip).toBe(false);
    expect(text).toBe("NO_REPLY");
  });

  it("does not strip mid-sentence NO_REPLY", () => {
    const { text, didStrip } = stripTrailingSilentReplyToken("Please NO_REPLY to this");
    expect(didStrip).toBe(false);
    expect(text).toBe("Please NO_REPLY to this");
  });
});
