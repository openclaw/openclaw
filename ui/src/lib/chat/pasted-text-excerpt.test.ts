import { describe, expect, it } from "vitest";
import { derivePastedTextExcerpt } from "./pasted-text-excerpt.ts";

describe("derivePastedTextExcerpt", () => {
  it.each([
    [
      "HTML blocks and entities",
      "<p>Hello <strong>world</strong></p><div>&amp; friends</div>",
      "Hello world & friends",
    ],
    ["HTML breaks", "one<br>two", "one two"],
    ["inert HTML", "<script>hidden()</script><style>.hidden {}</style><p>Visible</p>", "Visible"],
    ["headings and emphasis", "# **Heading**\n_italic_ ~~old~~", "Heading italic old"],
    ["links and images", "[Guide](https://example.com) ![logo](image.png)", "Guide logo"],
    ["reference links", "[Guide][docs]\n\n[docs]: https://example.com", "Guide"],
    ["list markers", "- first\n1. second\n> third", "first second third"],
    ["task lists", "- [x] done\n- [ ] next", "done next"],
    ["code fences", "```ts\nconst x = 1;\n```\n~~~\nsecond\n~~~", "const x = 1; second"],
    ["inline code", "Use `foo_bar` now", "Use foo_bar now"],
    ["Markdown inside HTML", "<div>**Bold** [label](https://example.com)</div>", "Bold label"],
    ["whitespace", " \tFirst\n\r\n second\u00a0third  ", "First second third"],
    ["only whitespace", " \n\t\r\n\u00a0 ", ""],
    ["only markup", "<div></div>\n\n---\n\n<!-- hidden -->", ""],
    [
      "exactly thirty characters",
      "123456789012345678901234567890",
      "123456789012345678901234567890",
    ],
    ["truncated prose", "123456789012345678901234567890x", "123456789012345678901234567890…"],
    ["emoji sequences", "👩🏽‍💻".repeat(31), `${"👩🏽‍💻".repeat(30)}…`],
    ["combining marks", "e\u0301".repeat(31), `${"e\u0301".repeat(30)}…`],
    ["CJK", "漢字".repeat(16), `${"漢字".repeat(15)}…`],
    ["RTL", "مرحبا".repeat(7), `${"مرحبا".repeat(6)}…`],
  ])("previews %s as readable text", (_label, input, expected) => {
    expect(derivePastedTextExcerpt(input)).toBe(expected);
  });
});
