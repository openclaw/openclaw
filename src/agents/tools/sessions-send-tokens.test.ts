import { describe, expect, it } from "vitest";
import {
  isAnnounceSkip,
  isReplySkip,
  ANNOUNCE_SKIP_TOKEN,
  REPLY_SKIP_TOKEN,
} from "./sessions-send-tokens.js";

describe("isAnnounceSkip", () => {
  it("matches the exact token", () => {
    expect(isAnnounceSkip(ANNOUNCE_SKIP_TOKEN)).toBe(true);
  });

  it("matches with surrounding whitespace", () => {
    expect(isAnnounceSkip("  ANNOUNCE_SKIP  ")).toBe(true);
  });

  it("matches with leading/trailing newlines", () => {
    expect(isAnnounceSkip("\nANNOUNCE_SKIP\n")).toBe(true);
  });

  it("matches multi-line text ending with the token on its own line", () => {
    expect(isAnnounceSkip("DM summary block\nANNOUNCE_SKIP")).toBe(true);
  });

  it("matches multi-line text with whitespace-padded final token line", () => {
    expect(isAnnounceSkip("Some summary\n  ANNOUNCE_SKIP  ")).toBe(true);
  });

  it("matches multi-line text with multiple preceding lines", () => {
    expect(isAnnounceSkip("Line 1\nLine 2\nLine 3\nANNOUNCE_SKIP")).toBe(true);
  });

  it("returns false for undefined", () => {
    expect(isAnnounceSkip(undefined)).toBe(false);
  });

  it("returns false for empty string", () => {
    expect(isAnnounceSkip("")).toBe(false);
  });

  it("returns false for substantive text without the token", () => {
    expect(isAnnounceSkip("Hello world")).toBe(false);
  });

  it("returns false when the token is embedded mid-text", () => {
    expect(isAnnounceSkip("Please ANNOUNCE_SKIP this")).toBe(false);
  });

  it("returns false when the token is on the first line with trailing content", () => {
    expect(isAnnounceSkip("ANNOUNCE_SKIP\nMore text after")).toBe(false);
  });

  it("returns false for a partial token on the last line", () => {
    expect(isAnnounceSkip("summary\nANNOUNCE_SKI")).toBe(false);
  });
});

describe("isReplySkip", () => {
  it("matches the exact token", () => {
    expect(isReplySkip(REPLY_SKIP_TOKEN)).toBe(true);
  });

  it("matches with surrounding whitespace", () => {
    expect(isReplySkip("  REPLY_SKIP  ")).toBe(true);
  });

  it("returns false for undefined", () => {
    expect(isReplySkip(undefined)).toBe(false);
  });

  it("returns false for empty string", () => {
    expect(isReplySkip("")).toBe(false);
  });
});
