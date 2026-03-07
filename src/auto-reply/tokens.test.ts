import { describe, it, expect } from "vitest";
import {
  couldBeSilentTokenStart,
  isSilentReplyPrefixText,
  isSilentReplyText,
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

describe("couldBeSilentTokenStart", () => {
  it("matches uppercase-only prefixes shorter than token", () => {
    expect(couldBeSilentTokenStart("N")).toBe(true);
    expect(couldBeSilentTokenStart("NO")).toBe(true);
    expect(couldBeSilentTokenStart("NO_")).toBe(true);
    expect(couldBeSilentTokenStart("NO_RE")).toBe(true);
  });

  it("returns false for exact full token (not a strict prefix)", () => {
    expect(couldBeSilentTokenStart("NO_REPLY")).toBe(false);
  });

  it("rejects lowercase / mixed case", () => {
    expect(couldBeSilentTokenStart("No")).toBe(false);
    expect(couldBeSilentTokenStart("no")).toBe(false);
    expect(couldBeSilentTokenStart("No_Reply")).toBe(false);
  });

  it("rejects non-prefix matches", () => {
    expect(couldBeSilentTokenStart("NO_X")).toBe(false);
    expect(couldBeSilentTokenStart("NX")).toBe(false);
    expect(couldBeSilentTokenStart("HELLO")).toBe(false);
  });

  it("rejects text with non-token characters", () => {
    expect(couldBeSilentTokenStart("NO ")).toBe(false);
    expect(couldBeSilentTokenStart("NO:")).toBe(false);
    expect(couldBeSilentTokenStart("NO_REPLY: reason")).toBe(false);
  });

  it("works with HEARTBEAT_OK token", () => {
    expect(couldBeSilentTokenStart("HEART", "HEARTBEAT_OK")).toBe(true);
    expect(couldBeSilentTokenStart("HEARTBEAT_OK", "HEARTBEAT_OK")).toBe(false);
  });

  it("handles undefined/empty", () => {
    expect(couldBeSilentTokenStart(undefined)).toBe(false);
    expect(couldBeSilentTokenStart("")).toBe(false);
  });
});
