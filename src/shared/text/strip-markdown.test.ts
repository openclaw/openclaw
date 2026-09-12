import { describe, expect, it } from "vitest";
import { stripMarkdown } from "./strip-markdown.js";

describe("stripMarkdown HTML projection", () => {
  it.each([
    ["<b>Checking</b><br>results<hr>Next", "Checking\nresults\nNext"],
    ["Before <!-- hidden <b>note</b> --> after", "Before  after"],
    ["Before <script>ignored()</script><style>hidden</style> after", "Before  after"],
    ["Before <script>\nconst tag = `</script>`;\nAfter", "Before `;\nAfter"],
    ["Before <script>unfinished", "Before"],
    ["Checking<style>\n\n.hidden { color: red }\n\n</style> results", "Checking results"],
    ["Checking <!-- hidden\n\nprivate renderer note\n\n--> results", "Checking  results"],
    ["Use `<progress>` and &lt;progress&gt; literally", "Use <progress> and <progress> literally"],
    ["Use \\<progress> literally", "Use <progress> literally"],
    ["```html\n<script>example()</script>\n```", "<script>example()</script>"],
    ['Checking [results](https://example.com "<script>") next.', "Checking results next."],
    [
      'Checking [results][r] next.\n\n[r]: https://example.com "<script>"',
      "Checking results next.",
    ],
    [
      'Checking ![<progress>](https://example.com/image.png "<script>") next.',
      "Checking <progress> next.",
    ],
    ["Checking [<b>results</b>](https://example.com) next.", "Checking results next."],
  ])("omits authored HTML while preserving visible text: %s", (input, expected) => {
    expect(stripMarkdown(input, { stripHtml: true, linkStyle: "label" })).toBe(expected);
  });
});
