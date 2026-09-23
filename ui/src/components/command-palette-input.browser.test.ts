import { html, nothing, render } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import "../styles.css";
import { renderCommandPaletteInput } from "./command-palette-input.ts";

const hasBrowserLayout = !navigator.userAgent.toLowerCase().includes("jsdom");
const onInputRef = () => undefined;
const nextFrame = () =>
  new Promise<void>((resolve) => {
    requestAnimationFrame(() => resolve());
  });

describe.skipIf(!hasBrowserLayout)("command palette input layout", () => {
  let host: HTMLDivElement | undefined;

  afterEach(() => {
    if (host) {
      render(nothing, host);
      host.remove();
      host = undefined;
    }
    vi.restoreAllMocks();
  });

  it("preserves the prompt without remeasuring result navigation and measures again on reconnect", async () => {
    host = document.body.appendChild(document.createElement("div"));
    host.style.cssText = "width: 740px; max-width: 100%;";
    const props = {
      value: "Keep this prompt and its caret while changing preferences.",
      placeholder: "Search or start a task…",
      onInputRef,
      onValueChange: () => undefined,
      actions: html`<button type="button">Settings</button>`,
    };
    const part = render(renderCommandPaletteInput(props), host);
    await document.fonts.ready;
    // Initial layout installs ResizeObserver; its first delivery schedules
    // the next frame. Observe result navigation after that commit completes.
    await nextFrame();
    await nextFrame();
    await nextFrame();
    const input = host.querySelector("textarea")!;
    const originalHeight = input.clientHeight;
    const measureContent = vi.spyOn(input, "scrollHeight", "get");
    const settings = host.querySelector("button")!;
    input.focus();
    input.setSelectionRange(5, 11, "backward");
    settings.focus();
    render(renderCommandPaletteInput({ ...props, activeDescendant: "next-result" }), host);
    await nextFrame();
    expect(document.activeElement).toBe(settings);
    expect(input.value).toBe(props.value);
    expect([input.selectionStart, input.selectionEnd, input.selectionDirection]).toEqual([
      5,
      11,
      "backward",
    ]);
    expect(measureContent).not.toHaveBeenCalled();
    expect(input.clientHeight).toBe(originalHeight);

    part.setConnected(false);
    host.remove();
    host.style.width = "320px";
    document.body.append(host);
    part.setConnected(true);
    await nextFrame();
    expect(measureContent).toHaveBeenCalled();
    expect(input.clientHeight).toBeGreaterThan(originalHeight);
    expect(input.value).toBe(props.value);
  });

  it("keeps a scrolled prompt in place through rerenders and resizing until the user edits", async () => {
    host = document.body.appendChild(document.createElement("div"));
    host.style.cssText = "width: 740px; max-width: 100%;";
    const props = {
      value: Array.from({ length: 12 }, (_, index) => "Prompt line " + (index + 1)).join("\n"),
      placeholder: "Search or start a task…",
      onInputRef,
      onValueChange: (value: string) => {
        props.value = value;
      },
    };
    render(renderCommandPaletteInput(props), host);
    const input = host.querySelector("textarea")!;
    const entry = host.querySelector(".cmd-palette__entry")!;
    await vi.waitFor(() => expect(input.style.overflowY).toBe("auto"));
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
    input.scrollTop = 22;
    input.dispatchEvent(new Event("scroll"));
    const previousScroll = input.scrollTop;

    render(renderCommandPaletteInput({ ...props, activeDescendant: "next-result" }), host);
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => resolve());
    });
    expect(input.scrollTop).toBe(previousScroll);
    expect(entry.hasAttribute("data-scroll-fade-top")).toBe(true);
    expect(entry.hasAttribute("data-scroll-fade-bottom")).toBe(true);

    host.style.width = "500px";
    await new Promise<void>((resolve) => {
      const observer = new ResizeObserver(() => {
        observer.disconnect();
        requestAnimationFrame(() => resolve());
      });
      observer.observe(entry);
    });
    expect(input.scrollTop).toBe(previousScroll);
    expect(input.selectionEnd).toBe(props.value.length);

    input.value += "\nContinue writing";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    render(renderCommandPaletteInput(props), host);
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => resolve());
    });
    expect(input.scrollTop).toBe(input.scrollHeight - input.clientHeight);
    expect(entry.hasAttribute("data-scroll-fade-bottom")).toBe(false);

    input.setSelectionRange(0, 0);
    input.scrollTop = 0;
    input.setRangeText("Edit the beginning: ", 0, 0, "end");
    input.dispatchEvent(new Event("input", { bubbles: true }));
    render(renderCommandPaletteInput(props), host);
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => resolve());
    });
    expect(input.scrollTop).toBe(0);
  });

  it("grows down through three lines, keeps actions fixed and fades clear of the far-right scrollbar", async () => {
    host = document.body.appendChild(document.createElement("div"));
    host.style.cssText = "width: 740px; max-width: 100%;";
    render(
      renderCommandPaletteInput({
        value: "One line",
        placeholder: "Search or start a task…",
        onInputRef,
        onValueChange: () => undefined,
        actions: html`<button type="button" class="cmd-palette__create">
          New session<kbd>Ctrl+Enter</kbd>
        </button>`,
      }),
      host,
    );
    const input = host.querySelector("textarea")!;
    const entry = host.querySelector<HTMLElement>(".cmd-palette__entry")!;
    const actions = host.querySelector<HTMLElement>(".cmd-palette__input-actions")!;
    const textScroll = host.querySelector<HTMLElement>(".cmd-palette__input-scroll")!;
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => resolve());
    });
    input.dispatchEvent(new Event("input", { bubbles: true }));
    const top = input.getBoundingClientRect().top;
    const actionTop = actions.getBoundingClientRect().top;
    const lineHeight = Number.parseFloat(getComputedStyle(input).lineHeight);
    expect(input.clientHeight).toBe(24);

    input.value = "One line\nTwo lines";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    expect(input.clientHeight).toBe(lineHeight * 2);
    expect(input.getBoundingClientRect().top).toBe(top);
    expect(actions.getBoundingClientRect().top).toBe(actionTop);

    input.value = "One line\nTwo lines\nThree lines\nFour lines\nFive lines";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    expect(input.clientHeight).toBe(lineHeight * 3);
    expect(input.scrollHeight).toBeGreaterThan(input.clientHeight);
    expect(getComputedStyle(input).overflowY).toBe("auto");
    expect(getComputedStyle(input).scrollbarWidth).not.toBe("none");
    expect(input.getBoundingClientRect().top).toBe(top);
    expect(actions.getBoundingClientRect().top).toBe(actionTop);
    expect(input.getBoundingClientRect().right).toBeGreaterThan(
      actions.getBoundingClientRect().right + 8,
    );
    const textRight =
      input.getBoundingClientRect().right - Number.parseFloat(getComputedStyle(input).paddingRight);
    expect(textRight).toBeLessThan(actions.getBoundingClientRect().left);
    const fadeRight =
      textScroll.getBoundingClientRect().right -
      Number.parseFloat(getComputedStyle(textScroll, "::after").right);
    expect(fadeRight).toBeLessThan(actions.getBoundingClientRect().left);
    // Autofocus keeps an edited caret visible; explicitly inspect the top edge.
    input.scrollTop = 0;
    input.dispatchEvent(new Event("scroll"));
    expect(entry.hasAttribute("data-scroll-fade-bottom")).toBe(true);
    expect(entry.hasAttribute("data-scroll-fade-top")).toBe(false);

    input.scrollTop = input.scrollHeight;
    input.dispatchEvent(new Event("scroll"));
    expect(entry.hasAttribute("data-scroll-fade-top")).toBe(true);
    expect(entry.hasAttribute("data-scroll-fade-bottom")).toBe(false);
    input.scrollTop = 0;
    input.dispatchEvent(new Event("scroll"));
    expect(entry.hasAttribute("data-scroll-fade-top")).toBe(false);
    expect(entry.hasAttribute("data-scroll-fade-bottom")).toBe(true);

    input.value = "A short task";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    expect(input.clientHeight).toBe(24);
    expect(entry.hasAttribute("data-scroll-fade-top")).toBe(false);
    expect(entry.hasAttribute("data-scroll-fade-bottom")).toBe(false);
    expect(input.getBoundingClientRect().top).toBe(top);

    input.value = "A wrapping task with enough text to grow after the available width changes.";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    host.style.width = "320px";
    await vi.waitFor(() => expect(input.clientHeight).toBe(lineHeight * 3));
    expect(actions.getBoundingClientRect().top).toBe(actionTop);

    await document.fonts.ready;
    const styleChanges: MutationRecord[] = [];
    const observer = new MutationObserver((records) => styleChanges.push(...records));
    observer.observe(input, { attributes: true, attributeFilter: ["style"] });
    try {
      // Frame callbacks run before ResizeObserver delivery; a fixed pair of
      // frames can still leave the final resize queued on a busy browser.
      // Require a quiet three-frame window after those finite updates settle.
      await vi.waitFor(async () => {
        styleChanges.length = 0;
        await nextFrame();
        await nextFrame();
        await nextFrame();
        expect(styleChanges).toEqual([]);
      });
    } finally {
      observer.disconnect();
    }
  });
});
