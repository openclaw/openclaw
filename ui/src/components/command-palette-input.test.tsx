/* @vitest-environment jsdom */

import { createSignal } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mountSolid } from "../test-helpers/mount-solid.ts";
import { flush } from "../test-helpers/solid-settle.ts";
import { CommandPaletteInput } from "./command-palette-input.tsx";

describe("command palette input", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("reports full edits, reuses their layout, and retires observation across remount/removal", async () => {
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
    const [value, setValue] = createSignal("");
    const [activeDescendant, setActiveDescendant] = createSignal<string>();
    const inputRef = vi.fn();
    const onValueChange = vi.fn((next: string) => setValue(next));
    const view = () => (
      <CommandPaletteInput
        value={value()}
        placeholder="Search or start a task…"
        onInputRef={inputRef}
        onValueChange={onValueChange}
        activeDescendant={activeDescendant()}
      />
    );
    const mounted = mountSolid(view);
    const input = mounted.container.querySelector("textarea")!;
    const entry = mounted.container.querySelector(".cmd-palette__entry")!;
    input.style.lineHeight = "24px";
    let contentHeight = 24;
    const measureContent = vi.fn(() => contentHeight);
    Object.defineProperties(input, {
      scrollHeight: { configurable: true, get: measureContent },
      clientHeight: { configurable: true, get: () => Number.parseFloat(input.style.height) || 24 },
    });
    await vi.advanceTimersByTimeAsync(20);
    expect(observe).toHaveBeenCalledWith(entry);
    expect(inputRef).toHaveBeenCalledWith(input);

    contentHeight = 48;
    const prompt = "🦞".repeat(4_097) + "\nFinish the task";
    input.value = prompt;
    const event = new InputEvent("input", { bubbles: true, inputType: "insertText", data: prompt });
    input.dispatchEvent(event);
    expect(onValueChange).toHaveBeenCalledExactlyOnceWith(prompt, event);
    expect(input.value).toBe(prompt);
    expect(input.style.height).toBe("48px");
    flush();
    measureContent.mockClear();
    setActiveDescendant("next-result");
    flush();
    await vi.advanceTimersByTimeAsync(20);
    expect(measureContent).not.toHaveBeenCalled();
    expect(input.getAttribute("aria-activedescendant")).toBe("next-result");

    contentHeight = 24;
    setValue("Restored");
    flush();
    await vi.advanceTimersByTimeAsync(20);
    expect(input.style.height).toBe("24px");

    contentHeight = 48;
    notifyResize();
    await vi.advanceTimersByTimeAsync(20);
    expect(input.style.height).toBe("48px");

    const initialHeight = input.style.height;
    const initialEntryAttributes = entry
      .getAttributeNames()
      .map((name) => [name, entry.getAttribute(name)]);
    setValue("pending");
    flush();
    mounted.unmount();
    expect(disconnect).toHaveBeenCalledOnce();
    expect(inputRef).toHaveBeenLastCalledWith(undefined);
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

    const remounted = mountSolid(view);
    const restored = remounted.container.querySelector("textarea")!;
    restored.style.lineHeight = "24px";
    Object.defineProperties(restored, {
      scrollHeight: { configurable: true, value: 72 },
      clientHeight: {
        configurable: true,
        get: () => Number.parseFloat(restored.style.height) || 24,
      },
    });
    await vi.advanceTimersByTimeAsync(20);
    expect(restored.style.height).toBe("72px");
    restored.value = "Remounted";
    restored.dispatchEvent(new InputEvent("input", { bubbles: true }));
    expect(onValueChange).toHaveBeenLastCalledWith("Remounted", expect.any(InputEvent));
    remounted.unmount();
    expect(disconnect).toHaveBeenCalledTimes(2);
  });
});
