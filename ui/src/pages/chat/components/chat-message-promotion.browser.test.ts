import { html, nothing, render } from "lit";
import { AsyncDirective, directive } from "lit/async-directive.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { markdownBlocks } from "../../../components/markdown-blocks.ts";
import {
  handleMarkdownCodeBlockClick,
  readMarkdownCodeBlockCopyText,
} from "../../../components/markdown-code-blocks.ts";
import type { MarkdownRenderOptions } from "../../../components/markdown-render-options.ts";
import { releaseMarkdownTables } from "../../../components/markdown-tables.ts";
import { prepareMarkdownMedia, type MarkdownMedia } from "./chat-message-media-markdown.ts";
import { renderMessageMarkdown } from "./chat-message-text.ts";

let container: HTMLDivElement;

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  container.addEventListener("click", handleMarkdownCodeBlockClick);
});

afterEach(() => {
  releaseMarkdownTables(container);
  container.removeEventListener("click", handleMarkdownCodeBlockClick);
  render(nothing, container);
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
  return render(
    html`<section ${markdownBlocks()}>
      ${renderMessageMarkdown(
        source,
        key,
        { role: "assistant", isStreaming: streaming },
        { codeBlockInteraction: "interactive", tableInteractions: "enabled", ...options },
        undefined,
        media,
      )}
    </section>`,
    container,
  );
}

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

  it("preserves an opened disclosure through closing markup, promotion, and finalization", () => {
    const initial = "<details><summary>Evidence</summary>\n\nRetained evidence";
    draw(initial);
    const details = container.querySelector("details")!;
    details.open = true;
    const closed = initial + "\n\n</details>\n\nFollowing paragraph";
    draw(closed);
    expect(container.querySelector("details")).toBe(details);
    expect(details.open).toBe(true);
    draw(closed, { streaming: false });
    expect(container.querySelector("details")).toBe(details);
    expect(details.open).toBe(true);
  });

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

  it("refreshes media policy after promotion and releases removed media", async () => {
    let policy = "allowed";
    const connections: boolean[] = [];
    const mediaContent = directive(
      class extends AsyncDirective {
        render(label: string) {
          return html`<button>${label}</button>`;
        }
        protected override disconnected() {
          connections.push(false);
        }
        protected override reconnected() {
          connections.push(true);
        }
      },
    );
    const prepared = prepareMarkdownMedia(
      [
        { type: "text", text: "Retained paragraph." },
        { type: "image", image: { url: "https://example.invalid/image.png" } },
      ],
      () => mediaContent(policy),
    );
    const part = draw(prepared.markdown, { media: prepared.media });
    const paragraph = container.querySelector("p");
    const card = container.querySelector("button");
    const source = prepared.markdown + "\n\nFollowing paragraph";
    draw(source, { media: prepared.media });
    expect(container.querySelector("p")).toBe(paragraph);
    expect(container.querySelector("button")).toBe(card);
    policy = "denied";
    draw(source, { streaming: false, media: prepared.media });
    await Promise.resolve();
    expect(container.querySelector("button")).toBe(card);
    expect(card?.textContent).toBe("denied");
    part.setConnected(false);
    part.setConnected(true);
    expect(connections).toEqual([false, true]);
    policy = "allowed again";
    draw(source, { streaming: false, media: prepared.media });
    expect(card?.textContent).toBe("allowed again");
    draw("Replacement without media", { streaming: false });
    await Promise.resolve();
    expect(card?.parentNode).toBeNull();
    expect(connections).toEqual([false, true, false]);
  });

  it.each(["message", "correction", "options"])(
    "resets canonical content on %s changes",
    (change) => {
      const source = "```ts\nconst value = 1;\n```\n\nFollowing";
      draw(source);
      const wrapper = container.querySelector(".code-block-wrapper");
      draw(change === "correction" ? source.replace("value", "corrected") : source, {
        key: change === "message" ? "different-reply" : undefined,
        options: change === "options" ? { codeBlockInteraction: "static" } : undefined,
      });
      expect(container.querySelector(".code-block-wrapper")).not.toBe(wrapper);
      if (change === "options") {
        expect(container.querySelector(".code-block-wrap")).toBeNull();
      } else {
        expect(container.querySelector("pre code")?.textContent).toContain(
          change === "correction" ? "corrected" : "value",
        );
      }
    },
  );

  it("rebuilds canonical prefixes when a citation completes across stable blocks", () => {
    const initial = "Before \uE200cite\uE202source\n\nFollowing";
    draw(initial);
    const paragraph = container.querySelector("p");
    draw(initial + "\uE201");
    expect(container.querySelector("p")).not.toBe(paragraph);
    expect(container.textContent?.trim()).toBe("Before");
    expect(container.textContent).not.toContain("source");
  });

  it("rebuilds a previously stable paragraph when an appended reference changes its meaning", () => {
    const initial = "Reference [docs][target].\n\nFollowing";
    draw(initial);
    const paragraph = container.querySelector("p");
    draw(initial + "\n\n[target]: https://example.com/docs");
    expect(container.querySelector("p")).not.toBe(paragraph);
    expect(container.querySelector("a")?.getAttribute("href")).toBe("https://example.com/docs");
    expect(container.querySelector("a")?.textContent).toBe("docs");
  });
});
