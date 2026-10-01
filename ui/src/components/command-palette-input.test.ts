/* @vitest-environment jsdom */

import { html, nothing, render } from "lit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderCommandPaletteInput } from "./command-palette-input.ts";

type CommandPaletteInputProps = Parameters<typeof renderCommandPaletteInput>[0];

describe("command palette input", () => {
  let host: HTMLDivElement;

  beforeEach(() => {
    vi.useFakeTimers();
    host = document.body.appendChild(document.createElement("div"));
  });

  afterEach(() => {
    render(nothing, host);
    host.remove();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  function props(): CommandPaletteInputProps {
    return {
      value: "",
      placeholder: "Search or start a task…",
      onInputRef: vi.fn(),
      onValueChange: vi.fn(),
    };
  }

  it("preserves the field and skips layout when only the selected result changes", async () => {
    const inputProps = props();
    inputProps.value = "A task draft";
    inputProps.onInputRef = vi.fn((element) => {
      if (element instanceof HTMLTextAreaElement) {
        element.focus();
      }
    });
    inputProps.actions = html`<button type="button">Settings</button>`;
    render(renderCommandPaletteInput(inputProps), host);
    const input = host.querySelector("textarea")!;
    input.style.lineHeight = "24px";
    const measureContent = vi.fn(() => 24);
    Object.defineProperties(input, {
      scrollHeight: { configurable: true, get: measureContent },
      clientHeight: { configurable: true, value: 24 },
    });
    await vi.advanceTimersByTimeAsync(20);
    expect(measureContent).toHaveBeenCalled();
    measureContent.mockClear();
    input.setSelectionRange(2, 6);
    const settings = host.querySelector("button")!;
    settings.focus();

    render(renderCommandPaletteInput({ ...inputProps, activeDescendant: "next-result" }), host);
    await vi.advanceTimersByTimeAsync(20);
    expect(host.querySelector("textarea")).toBe(input);
    expect(document.activeElement).toBe(settings);
    expect(input.selectionStart).toBe(2);
    expect(input.selectionEnd).toBe(6);
    expect(inputProps.onInputRef).toHaveBeenCalledTimes(1);
    expect(input.id).toBe("cmd-palette-input");
    expect(input.getAttribute("aria-activedescendant")).toBe("next-result");
    expect(measureContent).not.toHaveBeenCalled();
  });

  it("reports the whole prompt without truncating the search projection boundary", () => {
    const inputProps = props();
    render(renderCommandPaletteInput(inputProps), host);
    const input = host.querySelector("textarea")!;
    const prompt = "🦞".repeat(4_097) + "\nFinish the task";
    input.value = prompt;
    const event = new InputEvent("input", {
      bubbles: true,
      inputType: "insertText",
      data: prompt,
    });
    input.dispatchEvent(event);
    expect(inputProps.onValueChange).toHaveBeenCalledExactlyOnceWith(prompt, event);
    expect(vi.mocked(inputProps.onValueChange).mock.calls[0]?.[1]).toBe(event);
    expect(input.value).toBe(prompt);
  });

  it("caps at three lines and updates only the hidden-text fades when scrolling", async () => {
    render(renderCommandPaletteInput(props()), host);
    await vi.advanceTimersByTimeAsync(20);
    const input = host.querySelector("textarea")!;
    const entry = host.querySelector(".cmd-palette__entry")!;
    input.style.lineHeight = "22px";
    let contentHeight = 110;
    Object.defineProperties(input, {
      scrollHeight: { configurable: true, get: () => contentHeight },
      clientHeight: { configurable: true, get: () => Number.parseFloat(input.style.height) || 22 },
    });
    input.scrollTop = 22;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    expect(input.style.height).toBe("66px");
    expect(input.style.overflowY).toBe("auto");
    expect(input.scrollTop).toBe(22);
    expect(entry.hasAttribute("data-scroll-fade-top")).toBe(true);
    expect(entry.hasAttribute("data-scroll-fade-bottom")).toBe(true);

    input.scrollTop = 44;
    input.dispatchEvent(new Event("scroll"));
    expect(entry.hasAttribute("data-scroll-fade-top")).toBe(true);
    expect(entry.hasAttribute("data-scroll-fade-bottom")).toBe(false);
    input.scrollTop = 0;
    input.dispatchEvent(new Event("scroll"));
    expect(entry.hasAttribute("data-scroll-fade-top")).toBe(false);
    expect(entry.hasAttribute("data-scroll-fade-bottom")).toBe(true);

    contentHeight = 22;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    expect(input.style.height).toBe("22px");
    expect(input.style.overflowY).toBe("hidden");
    expect(entry.hasAttribute("data-scroll-fade-top")).toBe(false);
    expect(entry.hasAttribute("data-scroll-fade-bottom")).toBe(false);
  });

  it("reuses an input edit's layout and remeasures controlled values, resizes and reconnects", async () => {
    let notifyResize: () => void = () => undefined;
    const disconnect = vi.fn();
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(callback: () => void) {
          notifyResize = callback;
        }
        observe = vi.fn();
        disconnect = disconnect;
      },
    );
    const inputProps = props();
    inputProps.onValueChange = vi.fn((value) => {
      inputProps.value = value;
    });
    const part = render(renderCommandPaletteInput(inputProps), host);
    const input = host.querySelector("textarea")!;
    input.style.lineHeight = "24px";
    let contentHeight = 24;
    const measureContent = vi.fn(() => contentHeight);
    Object.defineProperties(input, {
      scrollHeight: { configurable: true, get: measureContent },
      clientHeight: { configurable: true, get: () => Number.parseFloat(input.style.height) || 24 },
    });
    await vi.advanceTimersByTimeAsync(20);

    contentHeight = 48;
    input.value = "Two\nlines";
    input.dispatchEvent(new InputEvent("input", { bubbles: true }));
    expect(input.style.height).toBe("48px");
    measureContent.mockClear();
    render(renderCommandPaletteInput(inputProps), host);
    await vi.advanceTimersByTimeAsync(20);
    expect(measureContent).not.toHaveBeenCalled();

    contentHeight = 24;
    inputProps.value = "Restored";
    render(renderCommandPaletteInput(inputProps), host);
    await vi.advanceTimersByTimeAsync(20);
    expect(input.style.height).toBe("24px");

    contentHeight = 48;
    notifyResize();
    await vi.advanceTimersByTimeAsync(20);
    expect(input.style.height).toBe("48px");

    part.setConnected(false);
    expect(disconnect).toHaveBeenCalledOnce();
    contentHeight = 72;
    part.setConnected(true);
    await vi.advanceTimersByTimeAsync(20);
    expect(input.style.height).toBe("72px");
    input.value = "Reconnected";
    input.dispatchEvent(new InputEvent("input", { bubbles: true }));
    expect(inputProps.onValueChange).toHaveBeenLastCalledWith(
      "Reconnected",
      expect.any(InputEvent),
    );
  });

  it("disconnects scroll/resize observation and cancels pending layout on removal", async () => {
    const observe = vi.fn();
    const disconnect = vi.fn();
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe = observe;
        disconnect = disconnect;
      },
    );
    const inputProps = props();
    render(renderCommandPaletteInput(inputProps), host);
    await vi.advanceTimersByTimeAsync(20);
    const input = host.querySelector("textarea")!;
    const entry = host.querySelector(".cmd-palette__entry")!;
    expect(observe).toHaveBeenCalledWith(entry);
    const initialHeight = input.style.height;
    const initialEntryAttributes = entry
      .getAttributeNames()
      .map((name) => [name, entry.getAttribute(name)]);
    render(renderCommandPaletteInput({ ...inputProps, value: "pending" }), host);
    render(nothing, host);
    expect(disconnect).toHaveBeenCalledOnce();
    Object.defineProperties(input, {
      scrollHeight: { configurable: true, value: 100 },
      clientHeight: { configurable: true, value: 20 },
    });
    input.scrollTop = 20;
    input.dispatchEvent(new Event("scroll"));
    expect(entry.getAttributeNames().map((name) => [name, entry.getAttribute(name)])).toEqual(
      initialEntryAttributes,
    );
    await vi.advanceTimersByTimeAsync(20);
    expect(input.style.height).toBe(initialHeight);
  });
});
