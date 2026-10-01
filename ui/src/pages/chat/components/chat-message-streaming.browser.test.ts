import DOMPurify from "dompurify";
import { html, nothing, render } from "lit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../../test/helpers/promise.js";
import { markdownBlocks } from "../../../components/markdown-blocks.ts";
import {
  handleMarkdownCodeBlockClick,
  readMarkdownCodeBlockCopyText,
} from "../../../components/markdown-code-blocks.ts";
import {
  enhanceMarkdownTables,
  releaseMarkdownTables,
} from "../../../components/markdown-tables.ts";
import { toSanitizedMarkdownHtml } from "../../../components/markdown.ts";
import {
  prepareMarkdownMedia,
  renderMarkdownMedia,
  type MarkdownMedia,
} from "./chat-message-media-markdown.ts";
import { renderMessageMarkdown } from "./chat-message-text.ts";

let container: HTMLDivElement;

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
});

afterEach(() => {
  releaseMarkdownTables(container);
  render(nothing, container);
  container.remove();
});

function renderReply(text: string, isStreaming = true, media?: MarkdownMedia) {
  render(
    html`<section ${markdownBlocks()}>
      ${renderMessageMarkdown(
        text,
        "streaming-reply",
        { role: "assistant", isStreaming },
        { codeBlockInteraction: "interactive", tableInteractions: "enabled" },
        undefined,
        media,
      )}
    </section>`,
    container,
  );
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
      renderReply(initial);
      const existing = container.querySelector(selector);
      expect(existing).not.toBeNull();
      const records: MutationRecord[] = [];
      const observer = new MutationObserver((mutations) => records.push(...mutations));
      observer.observe(container, { childList: true, subtree: true, characterData: true });
      try {
        for (let index = 1; index <= 12; index++) {
          renderReply(initial + suffix.repeat(index));
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

  it("keeps earlier list items and reader disclosure state while appending another item", () => {
    const initial =
      "- <details><summary>Evidence</summary>Retained details</details>\n- Second item";
    renderReply(initial);
    const firstItem = container.querySelector("li");
    const details = container.querySelector("details")!;
    details.open = true;
    renderReply(`${initial}\n- Third item`);
    expect(container.querySelector("li")).toBe(firstItem);
    expect(container.querySelector("details")).toBe(details);
    expect(details.open).toBe(true);
    expect(container.querySelectorAll("li")).toHaveLength(3);
  });

  it("keeps code wrap controls and updates copy content while a fence grows", async () => {
    const code = Array.from({ length: 6 }, (_, index) => `const value${index} = ${index};`).join(
      "\n",
    );
    const initial = `\`\`\`ts\n${code}`;
    renderReply(initial);
    await Promise.resolve();
    const wrapper = container.querySelector<HTMLElement>(".code-block-wrapper")!;
    const button = wrapper.querySelector<HTMLButtonElement>(".code-block-wrap")!;
    container.addEventListener("click", handleMarkdownCodeBlockClick);
    try {
      button.click();
      const extra = "\nconst seventh = 7;\nconst eighth = 8;";
      renderReply(initial + extra);
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
      renderReply(initial + extra + "\nconst ninth = 9;");
      expect(wrapper.classList.contains("is-expanded")).toBe(true);
      expect(expand.getAttribute("aria-expanded")).toBe("true");
      expect(readMarkdownCodeBlockCopyText(wrapper.querySelector(".code-block-copy")!)).toBe(
        code + extra + "\nconst ninth = 9;",
      );
    } finally {
      container.removeEventListener("click", handleMarkdownCodeBlockClick);
    }
  });

  it("retains table controls and updates overflow as streamed cells resize", async () => {
    container.className = "chat-text";
    const initial = "| Name | Value |\n| --- | --- |\n| First | Growing";
    renderReply(initial);
    enhanceMarkdownTables(container);
    const table = container.querySelector("table");
    const icon = container.querySelector(".markdown-table__copy svg");
    expect(icon).not.toBeNull();
    renderReply(initial + " cell");
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
          renderReply(initial + " cell".repeat(100));
        } else {
          table!.rows[1]!.cells[1]!.textContent = "Short";
        }
      });
      expect(shell.classList.contains("markdown-table--can-scroll-right")).toBe(wide);
      expect(container.querySelector(".markdown-table__copy svg")).toBe(icon);
    }
  });

  it.each([true, false])(
    "keeps copy ownership when Expand appears (settled=%s)",
    async (settled) => {
      const initial =
        "```ts\n" +
        Array.from({ length: 6 }, (_, index) => `const value${index} = ${index};`).join("\n");
      const pending = createDeferred();
      const clipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: { writeText: vi.fn().mockReturnValue(pending.promise) },
      });
      const fallback = vi.spyOn(document, "execCommand").mockReturnValue(true);
      vi.useFakeTimers();
      container.addEventListener("click", handleMarkdownCodeBlockClick);
      try {
        renderReply(initial);
        await Promise.resolve();
        const copy = container.querySelector<HTMLButtonElement>(".code-block-copy")!;
        const wrap = container.querySelector<HTMLButtonElement>(".code-block-wrap")!;
        wrap.click();
        const label = wrap.getAttribute("aria-label");
        copy.click();
        if (settled) {
          pending.resolve();
          await vi.advanceTimersByTimeAsync(0);
          expect(copy.classList.contains("copied")).toBe(true);
        }
        renderReply(initial + "\nconst seventh = 7;\nconst eighth = 8;");
        await Promise.resolve();
        const expand = container.querySelector<HTMLButtonElement>(".code-block-expand")!;
        expect(container.querySelector(".code-block-copy")).toBe(copy);
        expect(container.querySelector(".code-block-wrap")).toBe(wrap);
        expect(expand.getAttribute("aria-controls")).toBe(
          container.querySelector(".code-block-viewport")?.id,
        );
        pending.reject(new Error("Native clipboard unavailable"));
        await vi.advanceTimersByTimeAsync(2000);
        expect(fallback).not.toHaveBeenCalled();
        expect(wrap.getAttribute("aria-label")).toBe(label);
        expect(wrap.getAttribute("aria-pressed")).toBe("true");
        expect(expand.classList.contains("copied")).toBe(false);
        expect(expand.classList.contains("copy-failed")).toBe(false);
        expect(copy.classList.contains("copied")).toBe(false);
      } finally {
        vi.useRealTimers();
        fallback.mockRestore();
        container.removeEventListener("click", handleMarkdownCodeBlockClick);
        if (clipboard) {
          Object.defineProperty(navigator, "clipboard", clipboard);
        } else {
          Reflect.deleteProperty(navigator, "clipboard");
        }
      }
    },
  );

  it.each(["completed", "resolve", "reject"])(
    "retains control ownership when JSON controls appear after %s copy",
    async (settlement) => {
      const initial =
        '- ```json\n  {\n  "nested": {\n  "a": 1,\n  "b": 2,\n  "c": 3,\n  "d": 4,\n  "value": true\n  }\n  }';
      const pending = createDeferred();
      const clipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: { writeText: vi.fn().mockReturnValue(pending.promise) },
      });
      const fallback = vi.spyOn(document, "execCommand").mockReturnValue(true);
      vi.useFakeTimers();
      container.addEventListener("click", handleMarkdownCodeBlockClick);
      try {
        renderReply(initial);
        await Promise.resolve();
        const wrapper = container.querySelector<HTMLElement>(".code-block-wrapper")!;
        const wrap = wrapper.querySelector<HTMLButtonElement>(".code-block-wrap")!;
        const expand = wrapper.querySelector<HTMLButtonElement>(".code-block-expand")!;
        const copy = wrapper.querySelector<HTMLButtonElement>(".code-block-copy")!;
        const copyText = readMarkdownCodeBlockCopyText(copy);
        const viewport = wrapper.querySelector(".code-block-viewport");
        wrap.click();
        expand.click();
        copy.click();
        if (settlement === "completed") {
          pending.resolve();
        }
        await vi.advanceTimersByTimeAsync(0);
        expect(copy.classList.contains("copied")).toBe(settlement === "completed");
        const wrapLabel = wrap.getAttribute("aria-label");
        renderReply(initial + "\n  ```\n\n- following");
        await Promise.resolve();
        expect(wrapper.querySelector(".code-block-json-modes")).not.toBeNull();
        expect(container.querySelector(".code-block-wrapper")).toBe(wrapper);
        expect(wrapper.querySelector(".code-block-wrap")).toBe(wrap);
        expect(wrapper.querySelector(".code-block-expand")).toBe(expand);
        expect(wrapper.querySelector(".code-block-copy")).toBe(copy);
        expect(readMarkdownCodeBlockCopyText(copy)).toBe(copyText);
        expect(wrapper.querySelector(".code-block-viewport")).toBe(viewport);
        expect(wrapper.classList.contains("is-wrapped")).toBe(true);
        expect(wrapper.classList.contains("is-expanded")).toBe(true);
        expect(wrap.getAttribute("aria-pressed")).toBe("true");
        expect(expand.getAttribute("aria-expanded")).toBe("true");
        expect(wrap.classList.contains("copied")).toBe(false);
        if (settlement === "reject") {
          pending.reject(new Error("Native clipboard unavailable"));
        } else {
          pending.resolve();
        }
        await vi.advanceTimersByTimeAsync(1500);
        expect(wrap.getAttribute("aria-label")).toBe(wrapLabel);
        expect(wrap.classList.contains("copy-failed")).toBe(false);
        expect(copy.classList.contains("copied")).toBe(false);
        expect(fallback).toHaveBeenCalledTimes(settlement === "reject" ? 1 : 0);
        const raw = wrapper.querySelector<HTMLButtonElement>('[data-json-mode="raw"]')!;
        raw.click();
        renderReply(initial + "\n  ```\n\n- following grows");
        expect(wrapper.querySelector('[data-json-mode="raw"]')).toBe(raw);
        expect(raw.getAttribute("aria-pressed")).toBe("true");
        expect(wrapper.classList.contains("is-json-raw")).toBe(true);
      } finally {
        vi.useRealTimers();
        fallback.mockRestore();
        container.removeEventListener("click", handleMarkdownCodeBlockClick);
        if (clipboard) {
          Object.defineProperty(navigator, "clipboard", clipboard);
        } else {
          Reflect.deleteProperty(navigator, "clipboard");
        }
      }
    },
  );

  it("keeps every sibling when sanitized identity hints are missing or duplicated", () => {
    const draw = (items: Array<[string | null, string]>) =>
      render(
        renderMarkdownMedia(
          DOMPurify.sanitize(
            `<section>${items.map(([key, text]) => `<p${key === null ? "" : ` data-markdown-key="${key}"`}>${text}</p>`).join("")}</section>`,
          ),
          undefined,
          true,
        ),
        container,
      );
    draw([
      ["keep", "retained"],
      ["duplicate", "first"],
      ["duplicate", "second"],
      [null, "missing"],
      ["", "empty"],
      ["3", "numeric string"],
    ]);
    const retained = container.querySelector("p");
    draw([
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
    draw([
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
    renderReply(source);
    expect(container.querySelector("button")).toBeNull();
    expect(container.textContent).toContain(source);
  });

  it.each(["wrapped", "split"])(
    "updates %s highlighter text without replacing its list",
    (mode) => {
      const initial = "- First item\n- Growing text";
      renderReply(initial);
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
      renderReply(initial + " continues");
      expect(container.querySelector("ul")).toBe(list);
      expect(container.querySelector("li mark")).toBe(highlight);
      expect(growing?.textContent).toBe("Growing text continues");
    },
  );

  it("clears the canonical memo when a positional node becomes a media slot", () => {
    const prepared = prepareMarkdownMedia(
      [{ type: "image", image: { url: "https://example.invalid/image.png" } }],
      () => html`<button>Media</button>`,
    );
    const draw = (source: string) =>
      render(renderMarkdownMedia(source, prepared.media, true), container);
    draw("<p>Original</p>");
    draw(prepared.markdown);
    expect(container.querySelector("button")?.textContent).toBe("Media");
    draw("<p>Original</p>");
    expect(container.querySelector("p")?.textContent).toBe("Original");
    expect(container.querySelector("button")).toBeNull();
  });

  it("refreshes media bindings with unchanged Markdown and retires removed slots", async () => {
    let policy = "allowed";
    const prepared = prepareMarkdownMedia(
      [
        { type: "text", text: "- First" },
        { type: "image", image: { url: "https://example.invalid/image.png" } },
        { type: "text", text: "- Growing" },
      ],
      () => html`<button>${policy}</button>`,
    );
    renderReply(prepared.markdown, true, prepared.media);
    const card = container.querySelector("button")!;
    expect(card.textContent).toBe("allowed");
    policy = "denied";
    renderReply(prepared.markdown, true, prepared.media);
    await Promise.resolve();
    expect(container.querySelector("button")).toBe(card);
    expect(card.textContent).toBe("denied");
    renderReply(prepared.markdown + " item", true, prepared.media);
    expect(container.querySelector("button")).toBe(card);
    renderReply(prepared.markdown + " item", false, prepared.media);
    expect(container.querySelector("button")).toBe(card);
    renderReply("Replacement without media");
    await Promise.resolve();
    expect(container.querySelector("button")).toBeNull();
    expect(card.isConnected).toBe(false);
    expect(card.parentNode).toBeNull();
  });

  it("leaves component-owned children intact and handles canonical changes", async () => {
    await import("../../../components/person-reference.ts");
    const draw = (label: string, tail: string) => {
      const source = `${label} ${tail}`;
      render(
        renderMarkdownMedia(
          toSanitizedMarkdownHtml(source, {
            humanMentions: [{ profileId: "test-person", start: 0, end: label.length }],
          }),
          undefined,
          true,
        ),
        container,
      );
    };
    draw("@Alice", "growing");
    const person = container.querySelector("openclaw-person-reference")!;
    await person.updateComplete;
    const button = person.querySelector("button");
    expect(button).not.toBeNull();
    draw("@Alice", "growing text");
    expect(container.querySelector("openclaw-person-reference")).toBe(person);
    expect(person.querySelector("button")).toBe(button);
    draw("@Bob", "new text");
    const next = container.querySelector("openclaw-person-reference")!;
    await next.updateComplete;
    expect(next.querySelector("button")?.textContent).toContain("Bob");
    expect(container.textContent).not.toContain("Alice");
  });

  it("retains enhanced Mermaid blocks until their canonical source changes", () => {
    const draw = (label: string, tail: string) =>
      render(
        renderMarkdownMedia(
          toSanitizedMarkdownHtml(
            `\`\`\`mermaid\nflowchart LR\nA[${label}] --> B\n\`\`\`\n\n${tail}`,
          ),
          undefined,
          true,
        ),
        container,
      );
    draw("First", "Growing");
    const block = container.querySelector(".markdown-mermaid")!;
    // mountMermaidBlocks hands all children to the diagram renderer.
    const diagram = document.createElement("span");
    diagram.textContent = "Enhanced diagram";
    block.replaceChildren(diagram);
    draw("First", "Growing text");
    expect(container.querySelector(".markdown-mermaid")).toBe(block);
    expect(block.firstChild).toBe(diagram);
    draw("Second", "Updated");
    expect(container.querySelector(".markdown-mermaid code")?.textContent).toContain("Second");
    expect(diagram.isConnected).toBe(false);
  });

  it("keeps the sanitizer boundary and renders void elements without swallowing siblings", () => {
    const source =
      '- [x] Checked task\n\nBefore<br>After\n\n---\n\n![Preview](data:image/png;base64,iVBORw0KGgo=)\n\n<script>alert(1)</script><img onerror="alert(1)">';
    render(
      renderMarkdownMedia(toSanitizedMarkdownHtml(source, { remoteImages: true }), undefined, true),
      container,
    );
    expect(container.querySelector("input")?.checked).toBe(true);
    expect(container.querySelector("br")).not.toBeNull();
    expect(container.querySelector("img")).not.toBeNull();
    expect(container.querySelector("hr")).not.toBeNull();
    expect(container.textContent).toContain("After");
    expect(container.querySelector("script,[onerror]")).toBeNull();
    renderReply("A **corrected** reply", false);
    expect(container.querySelector("input,img,hr")).toBeNull();
    expect(container.querySelector("strong")?.textContent).toBe("corrected");
  });
});
