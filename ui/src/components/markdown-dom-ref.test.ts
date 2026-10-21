import { createSignal, flush } from "solid-js";
import { expect, it, onTestFinished, vi } from "vitest";
import { mountSolid } from "../test-helpers/mount-solid.ts";
import { renderSolidRef } from "../test-helpers/render-solid-ref.ts";
import { createMarkdownRef } from "./markdown-dom-ref.ts";
import { toStreamingMarkdownParts } from "./markdown.ts";

it("commits Markdown before onUpdate and retires a replaced island", () => {
  const container = document.body.appendChild(document.createElement("div"));
  const [html, setHtml] = createSignal('<a href="#first">First</a>');
  const onUpdate = vi.fn(() => container.textContent);
  let bind!: (element: ParentNode) => void;
  const view = renderSolidRef(
    () => (bind = createMarkdownRef(() => ({ content: html(), onUpdate }))),
    { container, targetElement: document.createElement("div") },
  );
  onTestFinished(() => container.remove());
  expect(onUpdate).toHaveLastReturnedWith("First");
  const original = view.getByRole("link", { name: "First" });
  const replacement = container.appendChild(document.createElement("section"));
  bind(replacement);
  setHtml('<a href="#second">Second</a>');
  flush();
  expect(onUpdate).toHaveLastReturnedWith("Second");
  expect(original.isConnected).toBe(false);
  const current = view.getByRole("link", { name: "Second" });
  expect(replacement.contains(current)).toBe(true);

  view.unmount();
  expect(current).toMatchObject({ isConnected: false });
  expect(replacement.childNodes).toHaveLength(0);
});

it.each([
  ["paragraph", "A growing reply", "p"],
  ["list", "- First item\n- Growing item", "ul"],
  ["code fence", "```text\nA growing block", "pre"],
])("retains every node across 12 %s updates", (_label, initial, selector) => {
  const [source, setSource] = createSignal(initial);
  const { container: target } = mountSolid(() => {
    const fragment = document.createDocumentFragment();
    createMarkdownRef(() => ({
      content: {
        messageKey: "stream",
        source: source(),
        parts: toStreamingMarkdownParts(source()),
      },
    }))(fragment);
    return Array.from(fragment.childNodes);
  });
  const retained = target.querySelector(selector);
  expect(retained).not.toBeNull();
  const observer = new MutationObserver(() => {});
  observer.observe(target, { childList: true, subtree: true, characterData: true });
  onTestFinished(() => observer.disconnect());
  for (let index = 1; index <= 12; index++) {
    setSource(initial + " with more text".repeat(index));
    flush();
  }
  const mutations = observer.takeRecords();
  expect(target.querySelector(selector)).toBe(retained);
  expect(mutations.flatMap((mutation) => [...mutation.removedNodes])).toHaveLength(0);
  expect(retained?.textContent).toContain(" with more text".repeat(12));
  expect(mutations.some((mutation) => mutation.type === "characterData")).toBe(true);
});

it("retires retained media when the Solid owner unmounts", () => {
  const dispose = vi.fn();
  const setConnected = vi.fn();
  const target = document.createElement("div");
  const media = {
    prefix: "MEDIA",
    render: (_index: number, container: HTMLElement) => {
      container.textContent = "Attachment";
      return { dispose, setConnected };
    },
  };
  const read = () => ({ content: "<p>MEDIA0END</p>", media });
  const view = renderSolidRef(() => createMarkdownRef(read), { targetElement: target });
  expect(target.textContent).toBe("Attachment");
  expect(setConnected).toHaveBeenCalledWith(true);
  view.unmount();
  expect(dispose).toHaveBeenCalledOnce();
  expect(target.childNodes).toHaveLength(0);
});
