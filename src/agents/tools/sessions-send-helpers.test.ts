import { describe, expect, it } from "vitest";
import { isAnnounceSkip, isReplySkip } from "./sessions-send-helpers.js";

describe("isReplySkip", () => {
  it("returns true for REPLY_SKIP", () => {
    expect(isReplySkip("REPLY_SKIP")).toBe(true);
  });

  it("returns true for REPLY_SKIP with whitespace", () => {
    expect(isReplySkip("  REPLY_SKIP  ")).toBe(true);
  });

  it("returns true for NO_REPLY (silent reply token)", () => {
    expect(isReplySkip("NO_REPLY")).toBe(true);
  });

  it("returns true for NO_REPLY with whitespace", () => {
    expect(isReplySkip("  NO_REPLY  ")).toBe(true);
  });

  it("returns false for regular text", () => {
    expect(isReplySkip("Hello, how are you?")).toBe(false);
  });

  it("returns false for text containing NO_REPLY as substring", () => {
    expect(isReplySkip("I got NO_REPLY from the server")).toBe(false);
  });

  it("returns false for undefined", () => {
    expect(isReplySkip(undefined)).toBe(false);
  });

  it("returns false for empty string", () => {
    expect(isReplySkip("")).toBe(false);
  });
});

describe("isAnnounceSkip", () => {
  it("returns true for ANNOUNCE_SKIP", () => {
    expect(isAnnounceSkip("ANNOUNCE_SKIP")).toBe(true);
  });

  it("returns true for NO_REPLY (silent reply token)", () => {
    expect(isAnnounceSkip("NO_REPLY")).toBe(true);
  });

  it("returns true for NO_REPLY with whitespace", () => {
    expect(isAnnounceSkip("  NO_REPLY  ")).toBe(true);
  });

  it("returns false for regular text", () => {
    expect(isAnnounceSkip("Here is my announcement")).toBe(false);
  });

  it("returns false for undefined", () => {
    expect(isAnnounceSkip(undefined)).toBe(false);
  });
});
