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

  it("rejects mixed-case and non-prefix text", () => {
    expect(isSilentReplyPrefixText("No")).toBe(false);
    expect(isSilentReplyPrefixText("no")).toBe(false);
    expect(isSilentReplyPrefixText("Hello")).toBe(false);
    expect(isSilentReplyPrefixText("n")).toBe(false);
  });

  it("catches all uppercase prefixes up to and including pre-underscore segment", () => {
    // Single char prefix — held back to prevent leak
    expect(isSilentReplyPrefixText("N")).toBe(true);
    // Full pre-underscore segment
    expect(isSilentReplyPrefixText("NO")).toBe(true);
    expect(isSilentReplyPrefixText("HEARTBEAT", "HEARTBEAT_OK")).toBe(true);
    // Partial pre-underscore segments also held back
    expect(isSilentReplyPrefixText("H", "HEARTBEAT_OK")).toBe(true);
    expect(isSilentReplyPrefixText("HE", "HEARTBEAT_OK")).toBe(true);
    expect(isSilentReplyPrefixText("HEART", "HEARTBEAT_OK")).toBe(true);
    // Once underscore is included, existing prefix logic applies
    expect(isSilentReplyPrefixText("HEARTBEAT_", "HEARTBEAT_OK")).toBe(true);
  });

  it("rejects non-prefixes and mixed characters", () => {
    expect(isSilentReplyPrefixText("NO_X")).toBe(false);
    expect(isSilentReplyPrefixText("NO_REPLY more")).toBe(false);
    expect(isSilentReplyPrefixText("NO-")).toBe(false);
  });

  it("T621: holds back all streaming fragments that could be silent token prefixes", () => {
    // Single char — buffered, not leaked
    expect(isSilentReplyPrefixText("N")).toBe(true);
    // Pre-underscore segment — the actual observed leak
    expect(isSilentReplyPrefixText("NO")).toBe(true);
    // Full token
    expect(isSilentReplyPrefixText("NO_REPLY")).toBe(true);
    // HEARTBEAT_OK variants
    expect(isSilentReplyPrefixText("H", "HEARTBEAT_OK")).toBe(true);
    expect(isSilentReplyPrefixText("HEARTBEAT", "HEARTBEAT_OK")).toBe(true);
    // Mixed case → not a streaming fragment, real text
    expect(isSilentReplyPrefixText("No")).toBe(false);
    expect(isSilentReplyPrefixText("no")).toBe(false);
    // Non-prefixes
    expect(isSilentReplyPrefixText("NX")).toBe(false);
    expect(isSilentReplyPrefixText("NOPE")).toBe(false);
  });
});
