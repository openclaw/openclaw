import { html, nothing, render } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { composerHighlights } from "./chat-composer-highlights.ts";

const name = "openclaw-composer-token";
const containers: HTMLDivElement[] = [];
function host() {
  const container = document.createElement("div");
  document.body.append(container);
  containers.push(container);
  return container;
}
function offsets() {
  return [...(CSS.highlights.get(name) ?? [])].map((range) => [range.startOffset, range.endOffset]);
}
afterEach(() => {
  for (const container of containers.splice(0)) {
    render(nothing, container);
    container.remove();
  }
  vi.restoreAllMocks();
});

describe("native composer highlights", () => {
  it("tracks edits without replacing the textarea or changing native selection", async () => {
    const container = host();
    const resolve = (value: string) => (value.startsWith("$weather") ? [{ start: 0, end: 8 }] : []);
    render(
      html`<textarea .value=${"$weather please"} ${composerHighlights(resolve)}></textarea>`,
      container,
    );
    const textarea = container.querySelector("textarea")!;
    expect(offsets()).toEqual([[0, 8]]);
    textarea.focus();
    textarea.setSelectionRange(8, 8);
    const { userEvent } = await import("vitest/browser");
    await userEvent.keyboard("{ArrowLeft}{Backspace}");
    expect(textarea.value).toBe("$weathr please");
    expect(textarea.selectionStart).toBe(6);
    expect(offsets()).toEqual([]);
    await userEvent.keyboard("{Control>}z{/Control}");
    expect(textarea.value).toBe("$weather please");
    expect(offsets()).toEqual([[0, 8]]);
    expect(container.children).toHaveLength(1);
    expect(container.firstElementChild).toBe(textarea);
  });

  it("removes only its own ranges and restores them after reconnection", () => {
    const first = host(),
      second = host();
    const template = html`<textarea
      .value=${"$weather"}
      ${composerHighlights(() => [{ start: 0, end: 8 }])}
    ></textarea>`;
    const firstPart = render(template, first);
    render(template, second);
    expect(offsets()).toEqual([
      [0, 8],
      [0, 8],
    ]);
    firstPart.setConnected(false);
    expect(offsets()).toEqual([[0, 8]]);
    firstPart.setConnected(true);
    expect(offsets()).toEqual([
      [0, 8],
      [0, 8],
    ]);
    render(nothing, first);
    expect(offsets()).toEqual([[0, 8]]);
    render(nothing, second);
    expect(CSS.highlights.has(name)).toBe(false);
  });

  it("keeps ordinary input functional when native value ranges are unsupported", () => {
    const descriptor = Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      "createValueRange",
    )!;
    Object.defineProperty(HTMLTextAreaElement.prototype, "createValueRange", {
      ...descriptor,
      value: undefined,
    });
    try {
      const container = host();
      render(
        html`<textarea
          .value=${"$weather"}
          ${composerHighlights(() => [{ start: 0, end: 8 }])}
        ></textarea>`,
        container,
      );
      const textarea = container.querySelector("textarea")!;
      textarea.value = "$weather today";
      textarea.dispatchEvent(new InputEvent("input", { bubbles: true }));
      expect(textarea.value).toBe("$weather today");
      expect(CSS.highlights.has(name)).toBe(false);
    } finally {
      Object.defineProperty(HTMLTextAreaElement.prototype, "createValueRange", descriptor);
    }
  });
});
