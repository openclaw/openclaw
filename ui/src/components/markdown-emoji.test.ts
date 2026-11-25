import MarkdownIt from "markdown-it";
import { full as markdownItEmoji } from "markdown-it-emoji";
import emojiDefinitions from "markdown-it-emoji/lib/data/full.mjs";
import { describe, expect, it } from "vitest";
import { installMarkdownEmoji } from "./markdown-emoji.ts";

const original = new MarkdownIt({ html: true, breaks: true, linkify: true }).use(markdownItEmoji, {
  shortcuts: {},
});
const reader = new MarkdownIt({ html: true, breaks: true, linkify: true }).use(
  installMarkdownEmoji,
);

describe("reader named emoji parity", () => {
  it("preserves every catalog shortcode byte for byte", () => {
    const corpus = Object.keys(emojiDefinitions)
      .map((name) => `:${name}:`)
      .join(" ");
    expect(reader.render(corpus)).toBe(original.render(corpus));
  });

  it.each([
    ["prose and emoticons", "Hello :smile:! **:thumbsup:** :) :-) :P <3"],
    ["adjacent names", ":smile::thumbsup: x:smile:y :+1: :-1:"],
    ["unknown names", ":unknown: :SMILE: :unknown:smile: :smile:unknown: :smile"],
    ["escaped and entity colons", String.raw`\:smile: :smile\: \\:smile: &#58;smile&#58;`],
    ["inline code", "`:smile:` and ``literal ` :smile:`` and :thumbsup:"],
    ["fenced code", "```text\n:smile:\n```\n\n~~~\n:thumbsup:\n~~~\n\n:smile:"],
    ["indented code", "    :smile:\n\n:thumbsup:"],
    [
      "authored links",
      "[:smile:](https://example.com/:thumbsup:) [ref :smile:][r]\n\n[r]: /:thumbsup:",
    ],
    ["autolinks", "<https://example.com/:smile:> https://example.com/:thumbsup: :smile:"],
    ["HTML", '<span title=":smile:">:thumbsup:</span>\n\n<div>\n:smile:\n</div>\n\n:smile:'],
    ["image labels", "![label :smile:](https://example.com/:thumbsup:.png) :smile:"],
    [
      "tables and containers",
      "> - :smile:\n\n| Name | Value |\n| --- | --- |\n| :thumbsup: | `:smile:` |",
    ],
  ])("preserves %s byte for byte", (_name, markdown) => {
    expect(reader.render(markdown)).toBe(original.render(markdown));
  });
});
