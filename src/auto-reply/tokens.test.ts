import { describe, it, expect } from "vitest";
import {
  isSilentReplyPrefixText,
  isSilentReplyText,
  isSilentTokenOnOwnLine,
  stripSilentToken,
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

describe("isSilentTokenOnOwnLine", () => {
  it("matches token on its own line after text (#42472)", () => {
    expect(isSilentTokenOnOwnLine("Checked inbox.\n\nNO_REPLY")).toBe(true);
    expect(isSilentTokenOnOwnLine("All done.\nNO_REPLY")).toBe(true);
    expect(isSilentTokenOnOwnLine("tasks:\n• email: ok\n• wa: ok\nNO_REPLY")).toBe(true);
  });

  it("matches token with leading whitespace on its line", () => {
    expect(isSilentTokenOnOwnLine("Some text.\n  NO_REPLY")).toBe(true);
    expect(isSilentTokenOnOwnLine("Some text.\n  NO_REPLY  ")).toBe(true);
  });

  it("matches standalone token (no preceding text)", () => {
    expect(isSilentTokenOnOwnLine("NO_REPLY")).toBe(true);
  });

  it("does not match inline token (same line as content)", () => {
    expect(isSilentTokenOnOwnLine("😄 NO_REPLY")).toBe(false);
    expect(isSilentTokenOnOwnLine("ok NO_REPLY")).toBe(false);
  });

  it("does not match token in the middle of text", () => {
    expect(isSilentTokenOnOwnLine("NO_REPLY but here is more")).toBe(false);
    expect(isSilentTokenOnOwnLine("Please NO_REPLY to this")).toBe(false);
  });

  it("returns false for empty/undefined input", () => {
    expect(isSilentTokenOnOwnLine("")).toBe(false);
  });

  it("works with custom token", () => {
    expect(isSilentTokenOnOwnLine("done\nHEARTBEAT_OK", "HEARTBEAT_OK")).toBe(true);
    expect(isSilentTokenOnOwnLine("done HEARTBEAT_OK", "HEARTBEAT_OK")).toBe(false);
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
});
