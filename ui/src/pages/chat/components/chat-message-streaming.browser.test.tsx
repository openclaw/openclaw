import DOMPurify from "dompurify";
import { createEffect, useContext } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../../test/helpers/promise.js";
import {
  handleMarkdownCodeBlockClick,
  readMarkdownCodeBlockCopyText,
} from "../../../components/markdown-code-blocks.ts";
import { markdownBlocksRef } from "../../../components/markdown-element-refs-solid.ts";
import type { MarkdownRenderOptions } from "../../../components/markdown-render-options.ts";
import { releaseMarkdownTables } from "../../../components/markdown-tables.ts";
import { toSanitizedMarkdownHtml } from "../../../components/markdown.ts";
import { ContentPresentation } from "../../../lib/solid/presentation.ts";
import { restorePropertyDescriptor } from "../../../test-helpers/property-descriptor.ts";
import { renderSolidRef } from "../../../test-helpers/render-solid-ref.ts";
import { mountSolid } from "../../../test-helpers/solid-render.tsx";
import { prepareMarkdownMedia, type MarkdownMedia } from "./chat-message-media-markdown.ts";
import {
  MarkdownContent,
  MessageMarkdown,
  type MessageMarkdownProps,
} from "./chat-message-text-view.tsx";

let container: HTMLDivElement;
let blocks: ReturnType<typeof renderSolidRef>;
type PresentedMessage = MessageMarkdownProps & { presented: boolean };
type RawContent = Parameters<typeof MarkdownContent>[0];
let messageView: ReturnType<typeof mountSolid<PresentedMessage>> | undefined;
let rawView: ReturnType<typeof mountSolid<RawContent>> | undefined;
let messageProps: PresentedMessage;
const find = <T extends Element = HTMLElement>(selector: string, root: ParentNode = container) =>
  root.querySelector<T>(selector)!;
const control = (name: string, root: ParentNode = container) =>
  find<HTMLButtonElement>(`.code-block-${name}`, root);
const codeLines = (count: number) =>
  Array.from({ length: count }, (_, index) => `const value${index} = ${index};`).join("\n");

function MessageView(props: PresentedMessage) {
  return (
    <ContentPresentation value={() => props.presented}>
      <section>
        <MessageMarkdown {...props} />
      </section>
    </ContentPresentation>
  );
}

beforeEach(() => {
  container = document.createElement("div");
  blocks = renderSolidRef(() => markdownBlocksRef(() => true), { targetElement: container });
  container.addEventListener("click", handleMarkdownCodeBlockClick);
});

afterEach(() => {
  releaseMarkdownTables(container);
  container.removeEventListener("click", handleMarkdownCodeBlockClick);
  messageView?.dispose();
  rawView?.dispose();
  messageView = undefined;
  rawView = undefined;
  blocks.unmount();
  container.remove();
});

function draw(
  source: string,
  {
    streaming = true,
    key = "promotion-reply",
    media,
    options,
  }: {
    streaming?: boolean;
    key?: string;
    media?: MarkdownMedia;
    options?: MarkdownRenderOptions;
  } = {},
) {
  rawView?.dispose();
  rawView = undefined;
  messageProps = {
    markdown: source,
    messageKey: key,
    options: { role: "assistant", isStreaming: streaming },
    markdownOptions: {
      codeBlockInteraction: "interactive",
      tableInteractions: "enabled",
      ...options,
    },
    media,
    presented: true,
  };
  if (messageView) {
    messageView.update(messageProps);
  } else {
    messageView = mountSolid(MessageView, messageProps, container);
  }
}

function presentMessage(presented: boolean) {
  messageProps = { ...messageProps, presented };
  messageView!.update(messageProps);
}

function drawContent(content: RawContent["content"], media?: MarkdownMedia) {
  messageView?.dispose();
  messageView = undefined;
  const props = { content, media, incremental: true };
  if (rawView) {
    rawView.update(props);
  } else {
    rawView = mountSolid(MarkdownContent, props, container);
  }
}

describe("streaming Markdown DOM", () => {
  it.each([
    ["paragraph", "A growing reply", "p"],
    ["list", "- First item\n- Growing item", "ul"],
    ["long list", Array.from({ length: 200 }, (_, index) => `- Item ${index}`).join("\n"), "ul"],
    ["code fence", "```text\nA growing block", "pre"],
  ])("updates %s text without removing the rendered subtree", (_label, initial, selector) => {
    const suffix = " with more text";
    draw(initial);
    const existing = container.querySelector(selector);
    expect(existing).not.toBeNull();
    const records: MutationRecord[] = [];
    const observer = new MutationObserver((mutations) => records.push(...mutations));
    observer.observe(container, { childList: true, subtree: true, characterData: true });
    try {
      for (let index = 1; index <= 12; index++) {
        draw(initial + suffix.repeat(index));
      }
      records.push(...observer.takeRecords());
      expect(container.querySelector(selector)).toBe(existing);
      expect(records.flatMap((record) => [...record.removedNodes])).toHaveLength(0);
      expect(records.some((record) => record.type === "characterData")).toBe(true);
      expect(existing?.textContent).toContain(suffix.repeat(12));
    } finally {
      observer.disconnect();
    }
  });

  it.each([
    [
      "list item append",
      "- <details><summary>Evidence</summary>Retained details</details>\n- Second item",
      "\n- Third item",
      "li",
    ],
    [
      "disclosure closure",
      "<details><summary>Evidence</summary>\n\nRetained evidence",
      "\n\n</details>\n\nFollowing paragraph",
      "details",
    ],
  ])(
    "preserves reader disclosure state through %s and finalization",
    (_label, initial, suffix, selector) => {
      draw(initial);
      const retained = container.querySelector(selector);
      const details = container.querySelector("details")!;
      details.open = true;
      draw(initial + suffix);
      expect(container.querySelector(selector)).toBe(retained);
      expect(container.querySelector("details")).toBe(details);
      expect(details.open).toBe(true);
      if (selector === "li") {
        expect(container.querySelectorAll("li")).toHaveLength(3);
      }
      draw(initial + suffix, { streaming: false });
      expect(container.querySelector("details")).toBe(details);
      expect(details.open).toBe(true);
    },
  );

  it("retains table controls and updates overflow as streamed cells resize", async () => {
    container.className = "chat-text";
    const initial = "| Name | Value |\n| --- | --- |\n| First | Growing";
    draw(initial);
    await new Promise<void>(queueMicrotask);
    const table = container.querySelector("table");
    const icon = container.querySelector(".markdown-table__copy svg");
    expect(icon).not.toBeNull();
    draw(initial + " cell");
    expect(container.querySelector("table")).toBe(table);
    expect(container.querySelector(".markdown-table__copy svg")).toBe(icon);
    expect(table?.rows[1]?.cells[1]?.textContent).toBe("Growing cell");
    const shell = find(".markdown-table");
    const viewport = find(".markdown-table__viewport");
    viewport.style.cssText = "width: 300px; overflow-x: auto";
    table!.style.width = "max-content";
    for (const wide of [true, false]) {
      await new Promise<void>((resolve) => {
        const observer = new ResizeObserver(() => {
          observer.disconnect();
          resolve();
        });
        observer.observe(table!);
        if (wide) {
          draw(initial + " cell".repeat(100));
        } else {
          table!.rows[1]!.cells[1]!.textContent = "Short";
        }
      });
      expect(shell.classList.contains("markdown-table--can-scroll-right")).toBe(wide);
      expect(container.querySelector(".markdown-table__copy svg")).toBe(icon);
    }
  });

  it.each([
    { insertion: "Expand", settlement: "completed" },
    { insertion: "Expand", settlement: "reject" },
    { insertion: "JSON modes", settlement: "completed" },
    { insertion: "JSON modes", settlement: "resolve" },
    { insertion: "JSON modes", settlement: "reject" },
  ])(
    "keeps control ownership when $insertion appears after $settlement copy",
    async ({ insertion, settlement }) => {
      const json = insertion === "JSON modes";
      const initial = json
        ? '- ```json\n  {\n  "nested": {\n  "a": 1,\n  "b": 2,\n  "c": 3,\n  "d": 4,\n  "value": true\n  }\n  }'
        : "```ts\n" + codeLines(6);
      const suffix = json ? "\n  ```\n\n- following" : "\nconst seventh = 7;\nconst eighth = 8;";
      const pending = createDeferred();
      const clipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: { writeText: vi.fn().mockReturnValue(pending.promise) },
      });
      const fallback = vi.spyOn(document, "execCommand").mockReturnValue(true);
      vi.useFakeTimers();
      try {
        draw(initial);
        // Native refs deliver mutations before the queued enhancement scan.
        await new Promise<void>(queueMicrotask);
        const wrapper = find(".code-block-wrapper");
        const copy = control("copy", wrapper);
        const wrap = control("wrap", wrapper);
        const previousExpand = control("expand", wrapper);
        const viewport = find(".code-block-viewport", wrapper);
        const copyText = readMarkdownCodeBlockCopyText(copy);
        wrap.click();
        if (json) {
          previousExpand!.click();
        }
        const wrapLabel = wrap.getAttribute("aria-label");
        copy.click();
        if (settlement === "completed") {
          pending.resolve();
        }
        await vi.advanceTimersByTimeAsync(0);
        expect(copy.classList.contains("copied")).toBe(settlement === "completed");
        draw(initial + suffix);
        await new Promise<void>(queueMicrotask);
        const expand = control("expand", wrapper);
        expect(find(".code-block-wrapper")).toBe(wrapper);
        expect(control("copy", wrapper)).toBe(copy);
        expect(control("wrap", wrapper)).toBe(wrap);
        expect(expand.getAttribute("aria-controls")).toBe(find(".code-block-viewport", wrapper).id);
        expect(wrap.getAttribute("aria-pressed")).toBe("true");
        if (!json) {
          expect(wrapper.classList.contains("is-wrapped")).toBe(true);
          expect(wrapper.classList.contains("is-collapsible")).toBe(true);
          expect(find(".code-block-viewport", wrapper).id).not.toBe("");
          expect(readMarkdownCodeBlockCopyText(copy)).toBe(
            initial.slice("```ts\n".length) + suffix,
          );
        }
        if (json) {
          expect(control("json-modes", wrapper)).not.toBeNull();
          expect(expand).toBe(previousExpand);
          expect(readMarkdownCodeBlockCopyText(copy)).toBe(copyText);
          expect(find(".code-block-viewport", wrapper)).toBe(viewport);
          expect(wrapper.classList.contains("is-wrapped")).toBe(true);
          expect(wrapper.classList.contains("is-expanded")).toBe(true);
          expect(expand.getAttribute("aria-expanded")).toBe("true");
          expect(wrap.classList.contains("copied")).toBe(false);
        }
        if (!json || settlement === "reject") {
          pending.reject(new Error("Native clipboard unavailable"));
        } else {
          pending.resolve();
        }
        await vi.advanceTimersByTimeAsync(json ? 1500 : 2000);
        expect(fallback).toHaveBeenCalledTimes(json && settlement === "reject" ? 1 : 0);
        expect(wrap.getAttribute("aria-label")).toBe(wrapLabel);
        expect(copy.classList.contains("copied")).toBe(false);
        if (json) {
          expect(wrap.classList.contains("copy-failed")).toBe(false);
          const raw = find<HTMLButtonElement>('[data-json-mode="raw"]', wrapper);
          raw.click();
          draw(initial + suffix + " grows");
          expect(wrapper.querySelector('[data-json-mode="raw"]')).toBe(raw);
          expect(raw.getAttribute("aria-pressed")).toBe("true");
          expect(wrapper.classList.contains("is-json-raw")).toBe(true);
        } else {
          expect(wrap.getAttribute("aria-pressed")).toBe("true");
          expect(expand.classList.contains("copied")).toBe(false);
          expect(expand.classList.contains("copy-failed")).toBe(false);
          expand.click();
          const growth = "\nconst ninth = 9;";
          draw(initial + suffix + growth);
          expect(wrapper.classList.contains("is-expanded")).toBe(true);
          expect(expand.getAttribute("aria-expanded")).toBe("true");
          expect(readMarkdownCodeBlockCopyText(copy)).toBe(
            initial.slice("```ts\n".length) + suffix + growth,
          );
        }
      } finally {
        vi.useRealTimers();
        fallback.mockRestore();
        restorePropertyDescriptor(navigator, "clipboard", clipboard);
      }
    },
  );

  it("keeps every sibling when sanitized identity hints are missing or duplicated", () => {
    const drawItems = (items: Array<[string | null, string]>) =>
      drawContent(
        DOMPurify.sanitize(
          `<section>${items.map(([key, text]) => `<p${key === null ? "" : ` data-markdown-key="${key}"`}>${text}</p>`).join("")}</section>`,
        ),
      );
    drawItems([
      ["keep", "retained"],
      ["duplicate", "first"],
      ["duplicate", "second"],
      [null, "missing"],
      ["", "empty"],
      ["3", "numeric string"],
    ]);
    const retained = container.querySelector("p");
    drawItems([
      [null, "new"],
      ["duplicate", "second changes"],
      ["keep", "retained"],
      ["duplicate", "first changes"],
      ["3", "numeric string"],
      ["", "empty changes"],
    ]);
    expect([...container.querySelectorAll("p")].map((node) => node.textContent)).toEqual([
      "new",
      "second changes",
      "retained",
      "first changes",
      "numeric string",
      "empty changes",
    ]);
    expect(container.querySelector('[data-markdown-key="keep"]')).toBe(retained);
    drawItems([
      ["duplicate", "now unique"],
      ["keep", "retained"],
      [null, "missing again"],
    ]);
    expect([...container.querySelectorAll("p")].map((node) => node.textContent)).toEqual([
      "now unique",
      "retained",
      "missing again",
    ]);
    expect(container.querySelector('[data-markdown-key="keep"]')).toBe(retained);
  });

  it("does not turn authored identity hints into interactive markup", () => {
    const source = '<button data-markdown-key="copy" class="code-block-copy">Authored</button>';
    draw(source);
    expect(container.querySelector("button")).toBeNull();
    expect(container.textContent).toContain(source);
  });

  it.each(["wrapped", "split"])(
    "updates %s highlighter text without replacing its list",
    (mode) => {
      const initial = "- First item\n- Growing text";
      draw(initial);
      const list = container.querySelector("ul");
      const [first, growing] = container.querySelectorAll("li");
      const highlight = document.createElement("mark");
      const firstText = [...first!.childNodes].find((node) => node instanceof Text)!;
      firstText.replaceWith(highlight);
      highlight.append(firstText);
      const text = [...growing!.childNodes].find((node): node is Text => node instanceof Text)!;
      if (mode === "wrapped") {
        const wrapper = document.createElement("mark");
        text.replaceWith(wrapper);
        wrapper.append(text);
      } else {
        text.splitText(4);
      }
      draw(initial + " continues");
      expect(container.querySelector("ul")).toBe(list);
      expect(container.querySelector("li mark")).toBe(highlight);
      expect(growing?.textContent).toBe("Growing text continues");
    },
  );

  it("clears the canonical memo when a positional node becomes a media slot", () => {
    const MediaButton = () => <button>Media</button>;
    const prepared = prepareMarkdownMedia(
      [{ type: "image", image: { url: "https://example.invalid/image.png" } }],
      MediaButton,
    );
    drawContent("<p>Original</p>", prepared.media);
    drawContent(prepared.markdown, prepared.media);
    expect(container.querySelector("button")?.textContent).toBe("Media");
    drawContent("<p>Original</p>", prepared.media);
    expect(container.querySelector("p")?.textContent).toBe("Original");
    expect(container.querySelector("button")).toBeNull();
  });

  it.each([
    ["nested list", "- First", "- Growing", " item"],
    ["promoted paragraph", "Retained paragraph.", "", "\n\nFollowing paragraph"],
  ])(
    "refreshes %s media policy and releases removed media",
    async (_label, before, after, suffix) => {
      let policy = "allowed";
      const connections: boolean[] = [];
      function MediaCard(props: Parameters<MarkdownMedia["render"]>[0]) {
        const presented = useContext(ContentPresentation);
        let activated = false;
        createEffect(presented, (active) => {
          if (active) {
            if (activated) {
              connections.push(true);
            }
            activated = true;
            return () => connections.push(false);
          }
          return undefined;
        });
        const label = () => {
          void props.item;
          return policy;
        };
        return <button>{label()}</button>;
      }
      const prepared = prepareMarkdownMedia(
        [
          { type: "text", text: before },
          { type: "image", image: { url: "https://example.invalid/image.png" } },
          ...(after ? [{ type: "text" as const, text: after }] : []),
        ],
        MediaCard,
      );
      draw(prepared.markdown, { media: prepared.media });
      const paragraph = container.querySelector("p");
      const card = container.querySelector("button")!;
      expect(card.textContent).toBe("allowed");
      policy = "denied";
      draw(prepared.markdown, { media: prepared.media });
      await Promise.resolve();
      expect(container.querySelector("button")).toBe(card);
      expect(card.textContent).toBe("denied");
      const source = prepared.markdown + suffix;
      policy = "allowed";
      draw(source, { media: prepared.media });
      if (!after) {
        expect(container.querySelector("p")).toBe(paragraph);
      }
      expect(container.querySelector("button")).toBe(card);
      policy = "denied";
      draw(source, { streaming: false, media: prepared.media });
      await Promise.resolve();
      expect(container.querySelector("button")).toBe(card);
      expect(card.textContent).toBe("denied");
      presentMessage(false);
      expect(connections).toEqual([false]);
      expect(container.querySelector("button")).toBe(card);
      presentMessage(true);
      expect(connections).toEqual([false, true]);
      expect(container.querySelector("button")).toBe(card);
      policy = "allowed again";
      draw(source, { streaming: false, media: prepared.media });
      expect(card.textContent).toBe("allowed again");
      draw("Replacement without media", { streaming: Boolean(after) });
      await Promise.resolve();
      expect(container.querySelector("button")).toBeNull();
      expect(card.isConnected).toBe(false);
      expect(card.parentNode).toBeNull();
      expect(connections).toEqual([false, true, false]);
    },
  );

  it("leaves component-owned children intact and handles canonical changes", async () => {
    await import("../../../components/solid/person-reference.tsx");
    const drawMention = (label: string, tail: string) => {
      const source = `${label} ${tail}`;
      drawContent(
        toSanitizedMarkdownHtml(source, {
          humanMentions: [{ profileId: "test-person", start: 0, end: label.length }],
        }),
      );
    };
    drawMention("@Alice", "growing");
    const person = container.querySelector("openclaw-person-reference")!;
    await person.updateComplete;
    const button = person.querySelector("button");
    expect(button).not.toBeNull();
    drawMention("@Alice", "growing text");
    expect(container.querySelector("openclaw-person-reference")).toBe(person);
    expect(person.querySelector("button")).toBe(button);
    drawMention("@Bob", "new text");
    const next = container.querySelector("openclaw-person-reference")!;
    await next.updateComplete;
    expect(next.querySelector("button")?.textContent).toContain("Bob");
    expect(container.textContent).not.toContain("Alice");
  });

  it("retains enhanced Mermaid blocks until their canonical source changes", () => {
    const drawDiagram = (label: string, tail: string) =>
      drawContent(
        toSanitizedMarkdownHtml(
          `\`\`\`mermaid\nflowchart LR\nA[${label}] --> B\n\`\`\`\n\n${tail}`,
        ),
      );
    drawDiagram("First", "Growing");
    const block = container.querySelector(".markdown-mermaid")!;
    // mountMermaidBlocks hands all children to the diagram renderer.
    const diagram = document.createElement("span");
    diagram.textContent = "Enhanced diagram";
    block.replaceChildren(diagram);
    drawDiagram("First", "Growing text");
    expect(container.querySelector(".markdown-mermaid")).toBe(block);
    expect(block.firstChild).toBe(diagram);
    drawDiagram("Second", "Updated");
    expect(container.querySelector(".markdown-mermaid code")?.textContent).toContain("Second");
    expect(diagram.isConnected).toBe(false);
  });

  it("keeps the sanitizer boundary and renders void elements without swallowing siblings", () => {
    const source =
      '- [x] Checked task\n\nBefore<br>After\n\n---\n\n![Preview](data:image/png;base64,iVBORw0KGgo=)\n\n<script>alert(1)</script><img onerror="alert(1)">';
    drawContent(toSanitizedMarkdownHtml(source, { remoteImages: true }));
    expect(container.querySelector("input")?.checked).toBe(true);
    expect(container.querySelector("br")).not.toBeNull();
    expect(container.querySelector("img")).not.toBeNull();
    expect(container.querySelector("hr")).not.toBeNull();
    expect(container.textContent).toContain("After");
    expect(container.querySelector("script,[onerror]")).toBeNull();
    draw("A **corrected** reply", { streaming: false });
    expect(container.querySelector("input,img,hr")).toBeNull();
    expect(container.querySelector("strong")?.textContent).toBe("corrected");
  });
});

describe("streaming Markdown promotion", () => {
  it.each(["\n\nNext paragraph", "\n\nNext paragraph\n\nLast paragraph"])(
    "preserves highlighted text when one tail retires into stable blocks: %j",
    (suffix) => {
      const initial = "Retained paragraph.";
      draw(initial);
      const paragraph = container.querySelector("p")!;
      const text = [...paragraph.childNodes].find((node): node is Text => node instanceof Text)!;
      const highlight = document.createElement("mark");
      text.replaceWith(highlight);
      highlight.append(text);
      draw(initial + suffix);
      expect(container.querySelector("p")).toBe(paragraph);
      expect(paragraph.querySelector("mark")).toBe(highlight);
      draw(initial + suffix, { streaming: false });
      expect(container.querySelector("p")).toBe(paragraph);
      expect(highlight.firstChild).toBe(text);
      expect(container.textContent).toContain("Next paragraph");
    },
  );

  it.each([
    ["ts", codeLines(8)],
    [
      "json",
      '{\n  "nested": {\n    "a": 1,\n    "b": 2,\n    "c": 3,\n    "d": 4,\n    "ready": true\n  }\n}',
    ],
  ])("preserves %s code controls when a live fence closes and finishes", async (language, code) => {
    const initial = `\`\`\`${language}\n${code}`;
    draw(initial, { options: { linkFavicons: false } });
    await Promise.resolve();
    const wrapper = find(".code-block-wrapper");
    const wrap = control("wrap", wrapper);
    const expand = control("expand", wrapper);
    const copy = control("copy", wrapper);
    const viewport = find(".code-block-viewport", wrapper);
    wrap.click();
    expand.click();
    const closed = initial + "\n```\n\nFollowing paragraph";
    draw(closed);
    await Promise.resolve();
    expect(container.querySelector(".code-block-wrapper")).toBe(wrapper);
    expect(find(".chat-text > p:last-child").textContent).toBe("Following paragraph");
    expect(control("wrap", wrapper)).toBe(wrap);
    expect(control("expand", wrapper)).toBe(expand);
    expect(control("copy", wrapper)).toBe(copy);
    expect(find(".code-block-viewport", wrapper)).toBe(viewport);
    const raw = find<HTMLButtonElement>('[data-json-mode="raw"]', wrapper);
    raw?.click();
    const completed = closed + "\n\nMore is arriving.";
    draw(completed);
    expect(container.querySelector(".code-block-wrapper")).toBe(wrapper);
    draw(completed, { streaming: false, options: { linkFavicons: true } });
    expect(container.querySelector(".code-block-wrapper")).toBe(wrapper);
    expect(find(".chat-text > p:last-child").textContent).toBe("More is arriving.");
    expect(wrapper.classList.contains("is-wrapped")).toBe(true);
    expect(wrapper.classList.contains("is-expanded")).toBe(true);
    expect(wrap.getAttribute("aria-pressed")).toBe("true");
    expect(expand.getAttribute("aria-expanded")).toBe("true");
    expect(expand.getAttribute("aria-controls")).toBe(viewport.id);
    expect(readMarkdownCodeBlockCopyText(copy)).toBe(code);
    if (language === "json") {
      expect(raw).not.toBeNull();
      expect(wrapper.querySelector('[data-json-mode="raw"]')).toBe(raw);
      expect(raw?.getAttribute("aria-pressed")).toBe("true");
      expect(wrapper.classList.contains("is-json-raw")).toBe(true);
    }
  });

  it("retains JSON reader state when an unstable list becomes the final reply", () => {
    const source = '- ```json\n  {"nested":{"ready":true}}\n  ```\n\n- Following item';
    draw(source);
    const wrapper = find(".code-block-wrapper");
    const details = wrapper.querySelectorAll<HTMLDetailsElement>("details")[1]!;
    details.open = false;
    const raw = find<HTMLButtonElement>('[data-json-mode="raw"]', wrapper);
    raw.click();
    draw(source, { streaming: false });
    expect(container.querySelector(".code-block-wrapper")).toBe(wrapper);
    expect(wrapper.querySelectorAll("details")[1]).toBe(details);
    expect(details.open).toBe(false);
    expect(raw.getAttribute("aria-pressed")).toBe("true");
    expect(wrapper.classList.contains("is-json-raw")).toBe(true);
  });

  it.each([1, 200])(
    "keeps promoted nodes across chunks of %i characters and an empty tail",
    (size) => {
      const initial = "First paragraph.";
      const suffix = "\n\nSecond paragraph.\n\n```ts\nconst value = 1;\n```\n\nLast paragraph.\n\n";
      draw(initial);
      const paragraph = container.querySelector("p");
      for (let end = size; end < suffix.length + size; end += size) {
        draw(initial + suffix.slice(0, end));
        expect(container.querySelector("p")).toBe(paragraph);
      }
      draw(initial + suffix, { streaming: false });
      expect(container.querySelector("p")).toBe(paragraph);
      expect([...container.querySelectorAll("p")].map((node) => node.textContent)).toEqual([
        initial,
        "Second paragraph.",
        "Last paragraph.",
      ]);
      expect(container.querySelectorAll("pre")).toHaveLength(1);
      expect(container.querySelector("pre code")?.textContent).toBe("const value = 1;\n");
    },
  );

  it.each(["message", "correction", "options", "citation", "reference"])(
    "resets canonical content on %s changes",
    (change) => {
      const source =
        change === "citation"
          ? "Before \uE200cite\uE202source\n\nFollowing"
          : change === "reference"
            ? "Reference [docs][target].\n\nFollowing"
            : "```ts\nconst value = 1;\n```\n\nFollowing";
      const selector =
        change === "citation" || change === "reference" ? "p" : ".code-block-wrapper";
      draw(source);
      const previous = container.querySelector(selector);
      control("wrap")?.click();
      const next =
        change === "correction"
          ? source.replace("value", "corrected")
          : change === "citation"
            ? source + "\uE201"
            : change === "reference"
              ? source + "\n\n[target]: https://example.com/docs"
              : source;
      draw(next, {
        key: change === "message" ? "different-reply" : undefined,
        options: change === "options" ? { codeBlockInteraction: "static" } : undefined,
      });
      expect(container.querySelector(selector)).not.toBe(previous);
      if (change === "options") {
        expect(container.querySelector(".code-block-wrap")).toBeNull();
        expect(container.querySelector(".code-block-copy")).not.toBeNull();
      } else if (change === "citation") {
        expect(container.textContent?.trim()).toBe("Before");
        expect(container.textContent).not.toContain("source");
      } else if (change === "reference") {
        expect(container.querySelector("a")?.getAttribute("href")).toBe("https://example.com/docs");
        expect(container.querySelector("a")?.textContent).toBe("docs");
      } else {
        if (change === "message") {
          expect(control("wrap").getAttribute("aria-pressed")).toBe("false");
        }
        expect(container.querySelectorAll("pre code")).toHaveLength(1);
        expect(container.querySelector("pre code")?.textContent).toBe(
          change === "correction" ? "const corrected = 1;\n" : "const value = 1;\n",
        );
      }
    },
  );
});
