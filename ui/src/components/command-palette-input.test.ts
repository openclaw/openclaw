/* @vitest-environment jsdom */

import { nothing, render } from "lit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderCommandPaletteInput } from "./command-palette-input.ts";

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

  it("reports full edits, reuses their layout, and retires observation across reconnect/removal", async () => {
    let notifyResize: () => void = () => undefined;
    const observe = vi.fn();
    const disconnect = vi.fn();
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(callback: () => void) {
          notifyResize = callback;
        }
        observe = observe;
        disconnect = disconnect;
      },
    );
    const inputProps: Parameters<typeof renderCommandPaletteInput>[0] = {
      value: "",
      placeholder: "Search or start a task…",
      onInputRef: vi.fn(),
      onValueChange: vi.fn((value) => {
        inputProps.value = value;
      }),
    };
    const part = render(renderCommandPaletteInput(inputProps), host);
    const input = host.querySelector("textarea")!;
    const entry = host.querySelector(".cmd-palette__entry")!;
    input.style.lineHeight = "24px";
    let contentHeight = 24;
    const measureContent = vi.fn(() => contentHeight);
    Object.defineProperties(input, {
      scrollHeight: { configurable: true, get: measureContent },
      clientHeight: { configurable: true, get: () => Number.parseFloat(input.style.height) || 24 },
    });
    await vi.advanceTimersByTimeAsync(20);
    expect(observe).toHaveBeenCalledWith(entry);

    contentHeight = 48;
    const prompt = "🦞".repeat(4_097) + "\nFinish the task";
    input.value = prompt;
    const event = new InputEvent("input", { bubbles: true, inputType: "insertText", data: prompt });
    input.dispatchEvent(event);
    expect(inputProps.onValueChange).toHaveBeenCalledExactlyOnceWith(prompt, event);
    expect(vi.mocked(inputProps.onValueChange).mock.calls[0]?.[1]).toBe(event);
    expect(input.value).toBe(prompt);
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
    const initialHeight = input.style.height;
    const initialEntryAttributes = entry
      .getAttributeNames()
      .map((name) => [name, entry.getAttribute(name)]);
    render(renderCommandPaletteInput({ ...inputProps, value: "pending" }), host);
    render(nothing, host);
    expect(disconnect).toHaveBeenCalledTimes(2);
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
