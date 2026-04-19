import { describe, expect, it } from "vitest";
import { extractAnnouncePayload, isAnnounceSkip, isReplySkip } from "./sessions-send-tokens.js";

describe("extractAnnouncePayload", () => {
  it("extracts inner content from valid announce tags", () => {
    expect(extractAnnouncePayload("<announce>Hello world</announce>")).toBe("Hello world");
  });

  it("extracts and trims inner whitespace", () => {
    expect(extractAnnouncePayload("<announce>  trimmed  </announce>")).toBe("trimmed");
  });

  it("extracts from text with surrounding narration", () => {
    expect(
      extractAnnouncePayload(
        "I completed the task.\n<announce>Task result summary</announce>\nDone.",
      ),
    ).toBe("Task result summary");
  });

  it("returns null for untagged text", () => {
    expect(
      extractAnnouncePayload("I completed the task successfully and here is my report."),
    ).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(extractAnnouncePayload("")).toBeNull();
  });

  it("returns null for undefined", () => {
    expect(extractAnnouncePayload(undefined)).toBeNull();
  });

  it("returns null for whitespace-only input", () => {
    expect(extractAnnouncePayload("   ")).toBeNull();
  });

  it("returns null for empty announce tags", () => {
    expect(extractAnnouncePayload("<announce></announce>")).toBeNull();
  });

  it("returns null for whitespace-only announce tags", () => {
    expect(extractAnnouncePayload("<announce>   </announce>")).toBeNull();
  });

  it("returns null for ANNOUNCE_SKIP token", () => {
    expect(extractAnnouncePayload("ANNOUNCE_SKIP")).toBeNull();
  });

  it("handles multiline content inside tags", () => {
    expect(extractAnnouncePayload("<announce>Line 1\nLine 2</announce>")).toBe("Line 1\nLine 2");
  });

  it("extracts only the first match when multiple tags exist", () => {
    expect(extractAnnouncePayload("<announce>first</announce> <announce>second</announce>")).toBe(
      "first",
    );
  });

  it("extracts from uppercase tags", () => {
    expect(extractAnnouncePayload("<ANNOUNCE>uppercase content</ANNOUNCE>")).toBe(
      "uppercase content",
    );
  });

  it("extracts from mixed-case tags", () => {
    expect(extractAnnouncePayload("<Announce>mixed case</Announce>")).toBe("mixed case");
  });

  it("extracts from mixed open/close case", () => {
    expect(extractAnnouncePayload("<announce>text</ANNOUNCE>")).toBe("text");
  });
});

describe("isAnnounceSkip", () => {
  it("returns true for exact token", () => {
    expect(isAnnounceSkip("ANNOUNCE_SKIP")).toBe(true);
  });

  it("returns true with surrounding whitespace", () => {
    expect(isAnnounceSkip("  ANNOUNCE_SKIP  ")).toBe(true);
  });

  it("returns false for other text", () => {
    expect(isAnnounceSkip("hello")).toBe(false);
  });
});

describe("isReplySkip", () => {
  it("returns true for exact token", () => {
    expect(isReplySkip("REPLY_SKIP")).toBe(true);
  });
});
