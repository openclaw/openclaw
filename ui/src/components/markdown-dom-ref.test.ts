import { createSignal, flush } from "solid-js";
import { describe, expect, it, vi } from "vitest";
import { renderSolidRef } from "../test-helpers/render-solid-ref.ts";
import { createMarkdownRef } from "./markdown-dom-ref.ts";
import { toStreamingMarkdownParts } from "./markdown.ts";

describe("Solid Markdown island", () => {
  it.each([
    ["paragraph", "A growing reply", "p"],
    ["list", "- First item\n- Growing item", "ul"],
    ["code fence", "```text\nA growing block", "pre"],
  ])("retains every node across 12 %s updates", (_label, initial, selector) => {
    const [source, setSource] = createSignal(initial);
    const target = document.createElement("div");
    const view = renderSolidRef(
      () =>
        createMarkdownRef(() => ({
          content: {
            messageKey: "stream",
            source: source(),
            parts: toStreamingMarkdownParts(source()),
          },
        })),
      { targetElement: target },
    );
    const retained = target.querySelector(selector);
    expect(retained).not.toBeNull();
    const observer = new MutationObserver(() => {});
    observer.observe(target, { childList: true, subtree: true, characterData: true });
    try {
      for (let index = 1; index <= 12; index++) {
        setSource(initial + " with more text".repeat(index));
        flush();
      }
      const mutations = observer.takeRecords();
      expect(target.querySelector(selector)).toBe(retained);
      expect(mutations.flatMap((mutation) => [...mutation.removedNodes])).toHaveLength(0);
      expect(retained?.textContent).toContain(" with more text".repeat(12));
      expect(mutations.some((mutation) => mutation.type === "characterData")).toBe(true);
    } finally {
      observer.disconnect();
      view.unmount();
    }
  });

  it("retires retained media when the Solid owner unmounts", () => {
    const dispose = vi.fn();
    const setConnected = vi.fn();
    const target = document.createElement("div");
    const view = renderSolidRef(
      () =>
        createMarkdownRef(() => ({
          content: "<p>MEDIA0END</p>",
          media: {
            prefix: "MEDIA",
            render: (_index, container) => {
              container.textContent = "Attachment";
              return { dispose, setConnected };
            },
          },
        })),
      { targetElement: target },
    );
    expect(target.textContent).toBe("Attachment");
    expect(setConnected).toHaveBeenCalledWith(true);
    view.unmount();
    expect(dispose).toHaveBeenCalledOnce();
    expect(target.childNodes).toHaveLength(0);
  });
});
