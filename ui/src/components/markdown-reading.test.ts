import { expect, it } from "vitest";
import { htmlFragment, toStreamingMarkdownParts } from "./markdown.test-support.ts";
import { toSanitizedMarkdownHtml } from "./markdown.ts";

it.each([5, 6])(
  "preserves level-%s headings after paragraphs in settled and streamed messages",
  (level) => {
    const source = `Before.\n\n${"#".repeat(level)} Follow-ups`;
    for (const html of [
      toSanitizedMarkdownHtml(source),
      toStreamingMarkdownParts(source).join(""),
      toStreamingMarkdownParts(`${source}<br>`).join(""),
    ]) {
      const fragment = htmlFragment(html);
      expect([...fragment.children].map((node) => [node.tagName, node.textContent])).toEqual([
        ["P", "Before."],
        [`H${level}`, "Follow-ups"],
      ]);
    }
  },
);
