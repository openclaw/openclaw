import { describe, expect, it } from "vitest";
import { splitOnSplitTags, stripSplitTags } from "./split-tag.js";

describe("splitOnSplitTags", () => {
  it("returns single-element array when no split tags", () => {
    expect(splitOnSplitTags("hello world")).toEqual(["hello world"]);
  });

  it("returns empty array for empty string", () => {
    expect(splitOnSplitTags("")).toEqual([]);
  });

  it("splits on [[SPLIT]]", () => {
    expect(splitOnSplitTags("hello [[SPLIT]] world")).toEqual(["hello", "world"]);
  });

  it("splits on case-insensitive variants", () => {
    expect(splitOnSplitTags("a [[split]] b [[Split]] c")).toEqual(["a", "b", "c"]);
  });

  it("handles whitespace inside brackets", () => {
    expect(splitOnSplitTags("a [[ split ]] b")).toEqual(["a", "b"]);
  });

  it("trims segments and drops empty ones", () => {
    expect(splitOnSplitTags("[[SPLIT]] hello [[SPLIT]] [[SPLIT]] world [[SPLIT]]")).toEqual([
      "hello",
      "world",
    ]);
  });

  it("does NOT split inside fenced code blocks", () => {
    const text = "before\n```\ncode [[SPLIT]] here\n```\nafter";
    expect(splitOnSplitTags(text)).toEqual([text]);
  });

  it("does NOT split inside inline code", () => {
    const text = "use `[[SPLIT]]` to split messages";
    expect(splitOnSplitTags(text)).toEqual([text]);
  });

  it("splits outside code but preserves code blocks intact", () => {
    const text = "hello [[SPLIT]]\n```\ncode [[SPLIT]] block\n```\n[[SPLIT]] world";
    const result = splitOnSplitTags(text);
    expect(result).toEqual(["hello", "```\ncode [[SPLIT]] block\n```", "world"]);
  });

  it("handles multiple splits in conversational text", () => {
    const text = "yo that's fire 🔥 [[SPLIT]] btw check this out [[SPLIT]] lmk what you think";
    expect(splitOnSplitTags(text)).toEqual([
      "yo that's fire 🔥",
      "btw check this out",
      "lmk what you think",
    ]);
  });

  it("handles split on its own line", () => {
    const text = "first message\n[[SPLIT]]\nsecond message";
    expect(splitOnSplitTags(text)).toEqual(["first message", "second message"]);
  });
});

describe("stripSplitTags", () => {
  it("strips all split tags", () => {
    expect(stripSplitTags("hello [[SPLIT]] world")).toBe("hello  world");
  });

  it("collapses excessive newlines after stripping", () => {
    expect(stripSplitTags("hello\n\n[[SPLIT]]\n\nworld")).toBe("hello\n\nworld");
  });

  it("returns original text when no tags", () => {
    expect(stripSplitTags("hello world")).toBe("hello world");
  });
});
