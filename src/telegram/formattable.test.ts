import { describe, expect, it } from "vitest";
import {
  FormattableString,
  bold,
  italic,
  underline,
  strikethrough,
  spoiler,
  code,
  blockquote,
  pre,
  link,
  customEmoji,
  format,
  join,
} from "./formattable.js";

describe("FormattableString", () => {
  it("constructs with text and no entities", () => {
    const fs = new FormattableString("hello");
    expect(fs.text).toBe("hello");
    expect(fs.entities).toEqual([]);
  });

  it("toString returns text", () => {
    const fs = new FormattableString("hello");
    expect(fs.toString()).toBe("hello");
  });
});

describe("customEmoji", () => {
  it("creates a FormattableString with custom_emoji entity", () => {
    const result = customEmoji("⚔️", "5222106016283378623");
    expect(result).toBeInstanceOf(FormattableString);
    expect(result.text).toBe("⚔️");
    expect(result.entities).toHaveLength(1);
    expect(result.entities[0]).toEqual({
      type: "custom_emoji",
      offset: 0,
      length: 2, // ⚔️ is 2 UTF-16 code units (base char + variation selector)
      custom_emoji_id: "5222106016283378623",
    });
  });
});

describe("simple formatters", () => {
  it("bold wraps text", () => {
    const result = bold("hello");
    expect(result.text).toBe("hello");
    expect(result.entities).toEqual([{ type: "bold", offset: 0, length: 5 }]);
  });

  it("italic wraps text", () => {
    const result = italic("world");
    expect(result.text).toBe("world");
    expect(result.entities).toEqual([{ type: "italic", offset: 0, length: 5 }]);
  });

  it("underline wraps text", () => {
    const result = underline("test");
    expect(result.text).toBe("test");
    expect(result.entities).toEqual([{ type: "underline", offset: 0, length: 4 }]);
  });

  it("strikethrough wraps text", () => {
    const result = strikethrough("old");
    expect(result.text).toBe("old");
    expect(result.entities).toEqual([{ type: "strikethrough", offset: 0, length: 3 }]);
  });

  it("spoiler wraps text", () => {
    const result = spoiler("secret");
    expect(result.text).toBe("secret");
    expect(result.entities).toEqual([{ type: "spoiler", offset: 0, length: 6 }]);
  });

  it("code wraps text", () => {
    const result = code("x = 1");
    expect(result.text).toBe("x = 1");
    expect(result.entities).toEqual([{ type: "code", offset: 0, length: 5 }]);
  });

  it("blockquote wraps text", () => {
    const result = blockquote("quoted");
    expect(result.text).toBe("quoted");
    expect(result.entities).toEqual([{ type: "blockquote", offset: 0, length: 6 }]);
  });

  it("accepts FormattableString as input", () => {
    const inner = new FormattableString("text", [{ type: "italic", offset: 0, length: 4 }]);
    const result = bold(inner);
    expect(result.text).toBe("text");
    expect(result.entities).toHaveLength(2);
    expect(result.entities[0]).toEqual({ type: "bold", offset: 0, length: 4 });
    expect(result.entities[1]).toEqual({ type: "italic", offset: 0, length: 4 });
  });
});

describe("formatters with arguments", () => {
  it("pre creates pre entity with language", () => {
    const result = pre("console.log(1)", "javascript");
    expect(result.text).toBe("console.log(1)");
    expect(result.entities).toEqual([
      { type: "pre", offset: 0, length: 14, language: "javascript" },
    ]);
  });

  it("link creates text_link entity with url", () => {
    const result = link("click here", "https://example.com");
    expect(result.text).toBe("click here");
    expect(result.entities).toEqual([
      { type: "text_link", offset: 0, length: 10, url: "https://example.com" },
    ]);
  });
});

describe("format template tag", () => {
  it("composes plain strings", () => {
    const result = format`hello world`;
    expect(result.text).toBe("hello world");
    expect(result.entities).toEqual([]);
  });

  it("composes with formatted parts", () => {
    const result = format`Hello ${bold("world")}!`;
    expect(result.text).toBe("Hello world!");
    expect(result.entities).toEqual([{ type: "bold", offset: 6, length: 5 }]);
  });

  it("computes offsets correctly with multiple parts", () => {
    const result = format`${bold("A")} and ${italic("B")}`;
    expect(result.text).toBe("A and B");
    expect(result.entities).toEqual([
      { type: "bold", offset: 0, length: 1 },
      { type: "italic", offset: 6, length: 1 },
    ]);
  });

  it("handles customEmoji in format tag", () => {
    const result = format`Hello ${customEmoji("⚔️", "123")}!`;
    expect(result.text).toBe("Hello ⚔️!");
    expect(result.entities).toEqual([
      { type: "custom_emoji", offset: 6, length: 2, custom_emoji_id: "123" },
    ]);
  });

  it("accepts plain strings as interpolated values", () => {
    const name = "Alice";
    const result = format`Hello ${name}`;
    expect(result.text).toBe("Hello Alice");
    expect(result.entities).toEqual([]);
  });

  it("skips null/undefined values", () => {
    const result = format`A${null as unknown as string}B`;
    expect(result.text).toBe("AB");
    expect(result.entities).toEqual([]);
  });
});

describe("nesting", () => {
  it("bold wrapping customEmoji preserves both entities", () => {
    const result = bold(customEmoji("⚔️", "id123"));
    expect(result.text).toBe("⚔️");
    expect(result.entities).toHaveLength(2);
    expect(result.entities[0]).toEqual({ type: "bold", offset: 0, length: 2 });
    expect(result.entities[1]).toEqual({
      type: "custom_emoji",
      offset: 0,
      length: 2,
      custom_emoji_id: "id123",
    });
  });

  it("italic wrapping bold text preserves both entities", () => {
    const result = italic(bold("text"));
    expect(result.text).toBe("text");
    expect(result.entities).toHaveLength(2);
    expect(result.entities[0]).toEqual({ type: "italic", offset: 0, length: 4 });
    expect(result.entities[1]).toEqual({ type: "bold", offset: 0, length: 4 });
  });
});

describe("join", () => {
  it("joins items with separator", () => {
    const result = join(["a", "b", "c"], (item) => bold(item), ", ");
    expect(result.text).toBe("a, b, c");
    expect(result.entities).toEqual([
      { type: "bold", offset: 0, length: 1 },
      { type: "bold", offset: 3, length: 1 },
      { type: "bold", offset: 6, length: 1 },
    ]);
  });

  it("handles empty array", () => {
    const result = join([], (item: string) => bold(item), ", ");
    expect(result.text).toBe("");
    expect(result.entities).toEqual([]);
  });

  it("handles single element", () => {
    const result = join(["only"], (item) => italic(item), ", ");
    expect(result.text).toBe("only");
    expect(result.entities).toEqual([{ type: "italic", offset: 0, length: 4 }]);
  });

  it("handles FormattableString separator", () => {
    const sep = bold(" | ");
    const result = join(["a", "b"], (item) => item, sep);
    expect(result.text).toBe("a | b");
    expect(result.entities).toEqual([{ type: "bold", offset: 1, length: 3 }]);
  });

  it("passes index to callback", () => {
    const result = join([10, 20], (item, idx) => `${idx}:${item}`, " ");
    expect(result.text).toBe("0:10 1:20");
    expect(result.entities).toEqual([]);
  });

  it("recalculates offsets for complex items", () => {
    const items = [
      { name: "Sword", emojiId: "111" },
      { name: "Shield", emojiId: "222" },
    ];
    const result = join(
      items,
      (item) => format`${customEmoji("⚔️", item.emojiId)} ${bold(item.name)}`,
      "\n",
    );
    // "⚔️ Sword\n⚔️ Shield"
    const line1 = "⚔️ Sword";
    const line2 = "⚔️ Shield";
    expect(result.text).toBe(`${line1}\n${line2}`);

    // Line 1: customEmoji at 0, bold at 3
    expect(result.entities[0]).toEqual({
      type: "custom_emoji",
      offset: 0,
      length: 2,
      custom_emoji_id: "111",
    });
    expect(result.entities[1]).toEqual({ type: "bold", offset: 3, length: 5 });

    // Line 2: customEmoji at 9 (8 + 1 newline), bold at 12
    const offset2 = line1.length + 1; // newline separator
    expect(result.entities[2]).toEqual({
      type: "custom_emoji",
      offset: offset2,
      length: 2,
      custom_emoji_id: "222",
    });
    expect(result.entities[3]).toEqual({
      type: "bold",
      offset: offset2 + 3,
      length: 6,
    });
  });
});
