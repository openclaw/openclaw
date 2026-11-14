import { createMemo, createSignal } from "solid-js";
import { expect, it, vi } from "vitest";
import { markdownContentHtml } from "../lib/markdown-content.ts";
import { prepareMessageMarkdown } from "../pages/chat/components/chat-message-text-preparation.ts";
import { MessageJson } from "../pages/chat/components/chat-message-text-view.tsx";
import { mountSolid } from "../test-helpers/mount-solid.ts";
import { waitForSolid } from "../test-helpers/solid-settle.ts";
import { LinkReaderMarkdown } from "./link-reader-markdown.tsx";
import { handleMarkdownCodeBlockClick } from "./markdown-code-blocks.ts";
import { createMarkdownRef } from "./markdown-dom-ref.ts";
import { parseMarkdownJson } from "./markdown-json.ts";
import { toStreamingMarkdownDomParts } from "./markdown-live.ts";
import type { MarkdownRenderOptions } from "./markdown-render-options.ts";
import corpus from "./markdown-transcript-corpus.json" with { type: "json" };
import { toStreamingMarkdownParts } from "./markdown.test-support.ts";
import { toSanitizedMarkdownHtml } from "./markdown.ts";
import { MarkdownHtml } from "./solid/markdown-html.tsx";
import { SanitizedHtml } from "./solid/sanitized-html.tsx";

const chunk = vi.hoisted(() => Promise.withResolvers<void>());
vi.mock("./markdown-highlight-runtime.ts", async (importOriginal) => {
  await chunk.promise;
  return importOriginal();
});

it("preserves readable code and node state across lazy highlighting", async () => {
  expect(toSanitizedMarkdownHtml("Plain **text**")).toBe("<p>Plain <strong>text</strong></p>\n");
  const sample = corpus[0]!;
  const initial = "Intro\n\n```ts\n" + "const value = 1;\n".repeat(12);
  const [stream, setStream] = createSignal(initial);
  const [streaming, setStreaming] = createSignal(true);
  const proseRuns = { cached: 0, streaming: 0 };
  function Prose() {
    const cached = createMemo(() => {
      proseRuns.cached++;
      return prepareMessageMarkdown(
        "Plain **text**",
        "plain-history",
        { role: "assistant", isStreaming: false },
        {},
      )
        .parts()
        .map(markdownContentHtml)
        .join("");
    });
    const streamed = createMemo(() => {
      proseRuns.streaming++;
      return toStreamingMarkdownParts("Plain **streamed** prose", {}, "plain-stream").join("");
    });
    return [<SanitizedHtml html={cached()} />, <SanitizedHtml html={streamed()} />];
  }
  const json = parseMarkdownJson(JSON.stringify({ lines: Array(12).fill("value") }, null, 2))!;
  function TranscriptMarkdown(props: { streaming: boolean; history?: boolean }) {
    const ref = createMarkdownRef(() => ({
      content: prepareMessageMarkdown(
        props.history ? initial + "```" : stream(),
        props.history ? "lazy-history" : "lazy-stream",
        { role: "assistant", isStreaming: props.streaming },
        { codeBlockInteraction: "interactive" },
        props.streaming ? toStreamingMarkdownDomParts : undefined,
      ),
    }));
    return <div class="retained-fixture" ref={ref} onClick={handleMarkdownCodeBlockClick} />;
  }
  const view = mountSolid(() => (
    <>
      <Prose />
      <TranscriptMarkdown streaming={streaming()} />
      <TranscriptMarkdown streaming={false} history={true} />
      <div class="retained-fixture" onClick={handleMarkdownCodeBlockClick}>
        <MessageJson
          json={json}
          messageKey="lazy-json"
          options={{ role: "assistant", isStreaming: false }}
          markdownOptions={{ codeBlockInteraction: "interactive" }}
        />
      </div>
      <MarkdownHtml class="static-fixture" markdown={sample.source} />
      <SanitizedHtml
        class="streaming-fixture"
        html={toStreamingMarkdownParts(sample.source, {}, "lazy-code").join("")}
      />
      <LinkReaderMarkdown body={sample.source} base="https://example.com/guide" />
    </>
  ));
  const find = (selector: string) => view.container.querySelector<HTMLElement>(selector);
  expect(view.container.querySelectorAll("code")).toHaveLength(6);
  expect(find(".static-fixture code")?.textContent).toContain('console.log("<safe>", answer)');
  expect(find(".hljs-keyword")).toBeNull();
  expect(find(".streaming-fixture")?.innerHTML).not.toContain("hljs-keyword");
  expect(find("safe")).toBeNull();
  expect(proseRuns).toEqual({ cached: 1, streaming: 1 });
  toStreamingMarkdownParts("▀▀▀▀\n\n", {}, "pending-block-art");
  expect(
    toStreamingMarkdownParts("▀▀▀▀\n\n▄▄▄▄\n\nIntro", {}, "pending-block-art").join(""),
  ).toContain('<code class="markdown-block-art">▀▀▀▀\n\n▄▄▄▄\n\n');

  const wrappers = view.container.querySelectorAll<HTMLElement>(
    ".retained-fixture .code-block-wrapper",
  );
  expect(wrappers).toHaveLength(3);
  for (const wrapper of wrappers) {
    wrapper.querySelector<HTMLButtonElement>(".code-block-expand")!.click();
    wrapper.querySelector<HTMLButtonElement>(".code-block-wrap")!.click();
  }
  wrappers[2]!.querySelector<HTMLButtonElement>('[data-json-mode="raw"]')!.click();
  setStream(initial + "```\n\nReady.");
  await waitForSolid(() => expect(find(".retained-fixture")?.textContent).toContain("Ready."));
  setStreaming(false);
  await waitForSolid(() => {
    for (const wrapper of wrappers) {
      expect(wrapper.isConnected).toBe(true);
    }
  });

  chunk.resolve();
  await waitForSolid(() =>
    expect(view.container.querySelectorAll(".hljs-keyword")).toHaveLength(27),
  );
  for (const wrapper of wrappers) {
    expect(wrapper.isConnected).toBe(true);
    expect(wrapper.matches(".is-expanded.is-wrapped")).toBe(true);
  }
  expect(wrappers[2]!.classList.contains("is-json-raw")).toBe(true);
  expect(proseRuns).toEqual({ cached: 1, streaming: 1 });
  expect(find(".static-fixture")?.innerHTML).toBe(sample.html);
  expect(find(".streaming-fixture")?.innerHTML).toBe(sample.html);
});

it.each(corpus)("preserves transcript $name byte for byte", ({ source, html, options }) => {
  // SAFETY: This checked-in corpus was captured with these renderer options at the merge base.
  expect(toSanitizedMarkdownHtml(source, options as MarkdownRenderOptions)).toBe(html);
});
