import { describe, expect, it } from "vitest";
import { toSanitizedMarkdownHtml } from "../../../components/markdown.ts";
import { createForwardedMessagePreview } from "./chat-forwarded-preview.ts";

function preview(markdown: string) {
  const html = createForwardedMessagePreview(toSanitizedMarkdownHtml(markdown));
  expect(html).not.toBeNull();
  const element = document.createElement("div");
  element.innerHTML = html!;
  return element;
}

const tail =
  " More supporting context stays available when the reader opens the complete message.".repeat(8);

describe("forwarded message previews", () => {
  it("ends on a full sentence across Markdown inline boundaries", () => {
    const sentence = "The **layout** review includes [the notes](https://example.com/notes).";
    const element = preview(sentence + tail);
    expect(element.textContent).toBe(
      "The layout review includes the notes." +
        " More supporting context stays available when the reader opens the complete message.".repeat(
          2,
        ),
    );
    expect(element.querySelector("strong")?.textContent).toBe("layout");
    expect(element.querySelector("a")?.getAttribute("href")).toBe("https://example.com/notes");
  });

  it("counts visible link text rather than its long Markdown destination", () => {
    expect(
      createForwardedMessagePreview(
        toSanitizedMarkdownHtml(
          "Read [the notes](https://example.com/" + "long-path/".repeat(100) + ").",
        ),
      ),
    ).toBeNull();
  });

  it.each([
    {
      markdown: "First paragraph.\n\nSecond paragraph.\n\nThird paragraph.\n\nFourth paragraph.",
      selector: "p",
    },
    { markdown: "- First item.\n- Second item.\n- Third item.\n- Fourth item.", selector: "li" },
    { markdown: "First line.\nSecond line.\nThird line.\nFourth line.", selector: "p" },
  ])("bounds separate blocks and explicit lines: $selector", ({ markdown, selector }) => {
    const element = preview(markdown);
    expect(element.textContent).not.toContain("Fourth");
    expect(element.textContent?.trim()).toMatch(/Third (paragraph|item|line)\.$/u);
    expect(element.querySelector(selector)).not.toBeNull();
  });

  it("preserves a bounded code excerpt without misleading copy or expand controls", () => {
    const element = preview(
      "~~~ts\nconst first = 1;\nconst second = 2;\nconst third = 3;\nconst fourth = 4;\n~~~",
    );
    expect(element.querySelector("pre code")).not.toBeNull();
    expect(element.textContent).toContain("const first = 1;");
    expect(element.textContent).not.toContain("fourth");
    expect(element.querySelector("button")).toBeNull();
  });

  it.each(["word ".repeat(200), "👩🏽‍💻".repeat(500), "x".repeat(1000)])(
    "bounds punctuation-free content without splitting graphemes",
    (source) => {
      const element = preview(source);
      expect(element.textContent!.length).toBeLessThan(source.length);
      expect(element.textContent).toMatch(/…$/u);
      expect(element.textContent).not.toContain("�");
      expect(source.startsWith(element.textContent!.slice(0, -1).trimEnd())).toBe(true);
    },
  );

  it("segments CJK sentences and keeps quoted punctuation intact", () => {
    const element = preview("「確認は完了しました。」次の手順を確認してください。".repeat(30));
    expect(element.textContent).toMatch(/[。」]$/u);
    expect(element.textContent!.length).toBeLessThanOrEqual(280);
  });
});

it("allows a moderately long first sentence but does not add an empty disclosure", () => {
  const sentence = "The review covers " + "useful context ".repeat(20) + "and is complete.";
  expect(sentence.length).toBeGreaterThan(280);
  expect(createForwardedMessagePreview(toSanitizedMarkdownHtml(sentence))).toBeNull();
  expect(preview(sentence + tail).textContent).toBe(sentence);
});

it("keeps the full destination when a long link label needs a grapheme fallback", () => {
  const url = "https://example.com/" + "longpath".repeat(100);
  const element = preview(url);
  expect(element.querySelector("a")?.getAttribute("href")).toBe(url);
  expect(element.querySelector("a")?.textContent?.length).toBe(280);
  expect(element.textContent).toMatch(/…$/u);
});

it.each(["\n".repeat(100), "first\n" + "\n".repeat(100) + "second\nthird\nfourth"])(
  "counts preserved blank code rows toward the compact excerpt",
  (code) => {
    const element = preview("~~~\n" + code + "\n~~~");
    expect(element.querySelector("pre code")?.textContent?.split("\n").length).toBeLessThanOrEqual(
      3,
    );
    expect(element.textContent).not.toContain("fourth");
  },
);

it("uses a label for image content and never exposes media markers", () => {
  const element = document.createElement("div");
  element.innerHTML = createForwardedMessagePreview(
    '<p>A chart.</p><button><img src="data:image/png;base64,iVBORw0KGgo=" alt="Release chart"></button>',
  )!;
  expect(element.textContent).toBe("A chart.Release chart");
  expect(element.querySelector("img, button")).toBeNull();
  const media = createForwardedMessagePreview(
    "<p>Notes. OPENCLAWMEDIASLOT0END</p>",
    "OPENCLAWMEDIASLOT",
  );
  expect(media).toContain("Attached file");
  expect(media).not.toContain("OPENCLAWMEDIASLOT");
});

it.each(["---\n\n".repeat(100), "~~~\n\n~~~\n\n".repeat(100)])(
  "bounds zero-text Markdown blocks as well as visible text",
  (markdown) => {
    const element = preview(markdown);
    expect(element.querySelectorAll("hr, pre")).toHaveLength(3);
  },
);
