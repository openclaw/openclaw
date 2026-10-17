import { describe, expect, it, vi } from "vitest";
import { mountSolid } from "../test-helpers/mount-solid.ts";
import { waitForSolid } from "../test-helpers/solid-settle.ts";
import { LinkReaderMarkdown } from "./link-reader-markdown.tsx";
import { loadMarkdownHighlighter } from "./markdown-code-blocks.ts";
import type { MarkdownRenderOptions } from "./markdown-render-options.ts";
import corpus from "./markdown-transcript-corpus.json";
import { toSanitizedMarkdownHtml, toStreamingMarkdownParts } from "./markdown.ts";
import { MarkdownHtml } from "./solid/markdown-html.tsx";
import { SanitizedHtml } from "./solid/sanitized-html.tsx";

const chunk = vi.hoisted(() => {
  let release!: () => void;
  return {
    waiting: new Promise<void>((resolve) => {
      release = resolve;
    }),
    release: () => release(),
  };
});
vi.mock("./markdown-highlight-runtime.ts", async (importOriginal) => {
  await chunk.waiting;
  return importOriginal();
});

it("keeps code readable while loading and refreshes cached, streamed, and reader HTML", async () => {
  expect(toSanitizedMarkdownHtml("Plain **text**")).toBe("<p>Plain <strong>text</strong></p>\n");
  const sample = corpus[0]!;
  const view = mountSolid(() => {
    return (
      <>
        <MarkdownHtml markdown={sample.source} />
        <SanitizedHtml
          class="streaming-fixture"
          html={toStreamingMarkdownParts(sample.source, {}, "lazy-code").join("")}
        />
        <LinkReaderMarkdown body={sample.source} base="https://example.com/guide" />
      </>
    );
  });
  expect(view.container.querySelectorAll("code")).toHaveLength(3);
  expect(view.container.querySelector("code")?.textContent).toContain(
    'console.log("<safe>", answer)',
  );
  expect(view.container.querySelector(".hljs-keyword")).toBeNull();
  expect(view.container.querySelector(".streaming-fixture")?.innerHTML).not.toContain(
    "hljs-keyword",
  );
  expect(view.container.querySelector("safe")).toBeNull();

  chunk.release();
  await loadMarkdownHighlighter();
  await waitForSolid(() =>
    expect(view.container.querySelectorAll(".hljs-keyword")).toHaveLength(3),
  );
  expect(view.container.firstElementChild?.innerHTML).toBe(sample.html);
  expect(view.container.querySelector(".streaming-fixture")?.innerHTML).toBe(sample.html);
});

describe("transcript HTML corpus captured before the loading change", () => {
  it.each(corpus)("preserves $name byte for byte", ({ source, html, options }) => {
    // SAFETY: This checked-in corpus was captured with these renderer options at the merge base.
    expect(toSanitizedMarkdownHtml(source, options as MarkdownRenderOptions)).toBe(html);
  });
});
