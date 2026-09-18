import { describe, expect, it } from "vitest";
import { toSanitizedMarkdownHtml, toStreamingMarkdownParts } from "./markdown.ts";

describe("Markdown destination presentation", () => {
  it.each([
    { kind: "complete", renderMarkdown: toSanitizedMarkdownHtml },
    {
      kind: "streaming",
      renderMarkdown: (text: string) => toStreamingMarkdownParts(text).join(""),
    },
  ])(
    "preserves $kind authored links without product navigation indicators",
    ({ renderMarkdown }) => {
      const container = document.createElement("div");
      container.innerHTML = renderMarkdown(
        "[Read **the guide**](https://example.test/guide)\n\nhttps://example.test/printed\n\nhttps://github.com/openclaw/openclaw/issues/150454\n\n[![Build status](data:image/png;base64,x)](https://example.test/build)",
      );
      expect(container.querySelectorAll("a")).toHaveLength(4);
      expect(container.querySelector('a[href="https://example.test/guide"]')?.textContent).toBe(
        "Read the guide",
      );
      expect(container.querySelector("a.markdown-github-item")?.textContent).toBe("#150454");
      expect(container.querySelector("img")?.getAttribute("alt")).toBe("Build status");
      expect(
        container.querySelector("openclaw-external-link, .external-link-indicator"),
      ).toBeNull();
      expect(container.querySelector('[aria-label*="opens in a new tab"]')).toBeNull();
    },
  );
});
