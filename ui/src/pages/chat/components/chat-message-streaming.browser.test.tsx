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
import { SolidContentPresentation, solidContent } from "../../../lit/solid-content.tsx";
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

function MessageView(props: PresentedMessage) {
  return (
    <SolidContentPresentation value={() => props.presented}>
      <section>
        <MessageMarkdown {...props} />
      </section>
    </SolidContentPresentation>
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
    { label: "paragraph", initial: "A growing reply", suffix: " with more text", selector: "p" },
    {
      label: "list",
      initial: "- First item\n- Growing item",
      suffix: " with more text",
      selector: "ul",
    },
    {
      label: "long list",
      initial: Array.from({ length: 200 }, (_, index) => `- Item ${index}`).join("\n"),
      suffix: " with more text",
      selector: "ul",
    },
    {
      label: "code fence",
      initial: "```text\nA growing block",
      suffix: " with more text",
      selector: "pre",
    },
  ])(
    "updates $label text without removing the rendered subtree",
    ({ initial, suffix, selector }) => {
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
    },
  );

  it.each([
    {
      label: "list item append",
      initial: "- <details><summary>Evidence</summary>Retained details</details>\n- Second item",
      suffix: "\n- Third item",
      selector: "li",
    },
    {
      label: "disclosure closure",
      initial: "<details><summary>Evidence</summary>\n\nRetained evidence",
      suffix: "\n\n</details>\n\nFollowing paragraph",
      selector: "details",
    },
  ])(
    "preserves reader disclosure state through $label and finalization",
    ({ initial, suffix, selector }) => {
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

  it("keeps code wrap controls and updates copy content while a fence grows", async () => {
    const code = Array.from({ length: 6 }, (_, index) => `const value${index} = ${index};`).join(
      "\n",
    );
    const initial = `\`\`\`ts\n${code}`;
    draw(initial);
    await Promise.resolve();
    const wrapper = container.querySelector<HTMLElement>(".code-block-wrapper")!;
    const button = wrapper.querySelector<HTMLButtonElement>(".code-block-wrap")!;
    button.click();
    const extra = "\nconst seventh = 7;\nconst eighth = 8;";
    draw(initial + extra);
    await Promise.resolve();
    expect(container.querySelector(".code-block-wrapper")).toBe(wrapper);
    expect(wrapper.classList.contains("is-wrapped")).toBe(true);
    expect(wrapper.classList.contains("is-collapsible")).toBe(true);
    expect(button.getAttribute("aria-pressed")).toBe("true");
    const expand = wrapper.querySelector<HTMLButtonElement>(".code-block-expand")!;
    const viewport = wrapper.querySelector<HTMLElement>(".code-block-viewport")!;
    expect(viewport.id).not.toBe("");
    expect(expand.getAttribute("aria-controls")).toBe(viewport.id);
    expand.click();
    draw(initial + extra + "\nconst ninth = 9;");
    expect(wrapper.classList.contains("is-expanded")).toBe(true);
    expect(expand.getAttribute("aria-expanded")).toBe("true");
    expect(readMarkdownCodeBlockCopyText(wrapper.querySelector(".code-block-copy")!)).toBe(
      code + extra + "\nconst ninth = 9;",
    );
  });

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
    const shell = container.querySelector<HTMLElement>(".markdown-table")!;
    const viewport = container.querySelector<HTMLElement>(".markdown-table__viewport")!;
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
        : "```ts\n" +
          Array.from({ length: 6 }, (_, index) => `const value${index} = ${index};`).join("\n");
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
        const wrapper = container.querySelector<HTMLElement>(".code-block-wrapper")!;
        const copy = wrapper.querySelector<HTMLButtonElement>(".code-block-copy")!;
        const wrap = wrapper.querySelector<HTMLButtonElement>(".code-block-wrap")!;
        const previousExpand = wrapper.querySelector<HTMLButtonElement>(".code-block-expand");
        const viewport = wrapper.querySelector(".code-block-viewport");
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
        const expand = wrapper.querySelector<HTMLButtonElement>(".code-block-expand")!;
        expect(container.querySelector(".code-block-wrapper")).toBe(wrapper);
        expect(wrapper.querySelector(".code-block-copy")).toBe(copy);
        expect(wrapper.querySelector(".code-block-wrap")).toBe(wrap);
        expect(expand.getAttribute("aria-controls")).toBe(
          wrapper.querySelector(".code-block-viewport")?.id,
        );
        expect(wrap.getAttribute("aria-pressed")).toBe("true");
        if (json) {
          expect(wrapper.querySelector(".code-block-json-modes")).not.toBeNull();
          expect(expand).toBe(previousExpand);
          expect(readMarkdownCodeBlockCopyText(copy)).toBe(copyText);
          expect(wrapper.querySelector(".code-block-viewport")).toBe(viewport);
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
          const raw = wrapper.querySelector<HTMLButtonElement>('[data-json-mode="raw"]')!;
          raw.click();
          draw(initial + suffix + " grows");
          expect(wrapper.querySelector('[data-json-mode="raw"]')).toBe(raw);
          expect(raw.getAttribute("aria-pressed")).toBe("true");
          expect(wrapper.classList.contains("is-json-raw")).toBe(true);
        } else {
          expect(wrap.getAttribute("aria-pressed")).toBe("true");
          expect(expand.classList.contains("copied")).toBe(false);
          expect(expand.classList.contains("copy-failed")).toBe(false);
        }
      } finally {
        vi.useRealTimers();
        fallback.mockRestore();
        if (clipboard) {
          Object.defineProperty(navigator, "clipboard", clipboard);
        } else {
          Reflect.deleteProperty(navigator, "clipboard");
        }
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
      () => solidContent(MediaButton, {}),
    );
    drawContent("<p>Original</p>", prepared.media);
    drawContent(prepared.markdown, prepared.media);
    expect(container.querySelector("button")?.textContent).toBe("Media");
    drawContent("<p>Original</p>", prepared.media);
    expect(container.querySelector("p")?.textContent).toBe("Original");
    expect(container.querySelector("button")).toBeNull();
  });

  it.each([
    { label: "nested list", before: "- First", after: "- Growing", suffix: " item" },
    {
      label: "promoted paragraph",
      before: "Retained paragraph.",
      after: "",
      suffix: "\n\nFollowing paragraph",
    },
  ])(
    "refreshes $label media policy and releases removed media",
    async ({ before, after, suffix }) => {
      let policy = "allowed";
      const connections: boolean[] = [];
      function MediaCard(props: { label: string }) {
        const presented = useContext(SolidContentPresentation);
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
        return <button>{props.label}</button>;
      }
      const prepared = prepareMarkdownMedia(
        [
          { type: "text", text: before },
          { type: "image", image: { url: "https://example.invalid/image.png" } },
          ...(after ? [{ type: "text" as const, text: after }] : []),
        ],
        () => solidContent(MediaCard, { label: policy }),
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
    await import("../../../components/person-reference.ts");
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
    {
      language: "ts",
      code: Array.from({ length: 8 }, (_, index) => `const value${index} = ${index};`).join("\n"),
    },
    {
      language: "json",
      code: '{\n  "nested": {\n    "a": 1,\n    "b": 2,\n    "c": 3,\n    "d": 4,\n    "ready": true\n  }\n}',
    },
  ])(
    "preserves $language code controls when a live fence closes and finishes",
    async ({ language, code }) => {
      const initial = `\`\`\`${language}\n${code}`;
      draw(initial);
      await Promise.resolve();
      const wrapper = container.querySelector<HTMLElement>(".code-block-wrapper")!;
      const wrap = wrapper.querySelector<HTMLButtonElement>(".code-block-wrap")!;
      const expand = wrapper.querySelector<HTMLButtonElement>(".code-block-expand")!;
      const copy = wrapper.querySelector<HTMLButtonElement>(".code-block-copy")!;
      const viewport = wrapper.querySelector(".code-block-viewport")!;
      wrap.click();
      expand.click();
      const closed = initial + "\n```\n\nFollowing paragraph";
      draw(closed);
      await Promise.resolve();
      expect(container.querySelector(".code-block-wrapper")).toBe(wrapper);
      expect(wrapper.querySelector(".code-block-wrap")).toBe(wrap);
      expect(wrapper.querySelector(".code-block-expand")).toBe(expand);
      expect(wrapper.querySelector(".code-block-copy")).toBe(copy);
      expect(wrapper.querySelector(".code-block-viewport")).toBe(viewport);
      const raw = wrapper.querySelector<HTMLButtonElement>('[data-json-mode="raw"]');
      raw?.click();
      draw(closed, { streaming: false });
      expect(container.querySelector(".code-block-wrapper")).toBe(wrapper);
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
    },
  );

  it("retains JSON reader state when an unstable list becomes the final reply", () => {
    const source = '- ```json\n  {"nested":{"ready":true}}\n  ```\n\n- Following item';
    draw(source);
    const wrapper = container.querySelector<HTMLElement>(".code-block-wrapper")!;
    const details = wrapper.querySelectorAll<HTMLDetailsElement>("details")[1]!;
    details.open = false;
    const raw = wrapper.querySelector<HTMLButtonElement>('[data-json-mode="raw"]')!;
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
      } else if (change === "citation") {
        expect(container.textContent?.trim()).toBe("Before");
        expect(container.textContent).not.toContain("source");
      } else if (change === "reference") {
        expect(container.querySelector("a")?.getAttribute("href")).toBe("https://example.com/docs");
        expect(container.querySelector("a")?.textContent).toBe("docs");
      } else {
        expect(container.querySelector("pre code")?.textContent).toContain(
          change === "correction" ? "corrected" : "value",
        );
      }
    },
  );
});
