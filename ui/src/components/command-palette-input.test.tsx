/* @vitest-environment jsdom */

import { createSignal } from "solid-js";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mountSolid } from "../test-helpers/mount-solid.ts";
import { flush } from "../test-helpers/solid-settle.ts";
import { CommandPaletteInput } from "./command-palette-input.tsx";

type Height = number | (() => number);
function mockLayout(input: HTMLTextAreaElement, height: Height, clientHeight?: number) {
  input.style.lineHeight = "24px";
  Object.defineProperties(input, {
    scrollHeight: { configurable: true, get: typeof height === "function" ? height : () => height },
    clientHeight: {
      configurable: true,
      get: () => clientHeight ?? (Number.parseFloat(input.style.height) || 24),
    },
  });
}
const attributes = (element: Element) =>
  element.getAttributeNames().map((name) => [name, element.getAttribute(name)]);

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("reports full edits, reuses their layout, and retires observation across remount/removal", async () => {
  let notifyResize: () => void = () => undefined;
  const observe = vi.fn();
  const disconnect = vi.fn();
  vi.stubGlobal(
    "ResizeObserver",
    vi.fn(function (callback: () => void) {
      notifyResize = callback;
      return { observe, disconnect };
    }),
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
  let contentHeight = 24;
  const measureContent = vi.fn(() => contentHeight);
  mockLayout(input, measureContent);
  await vi.advanceTimersByTimeAsync(20);
  expect(observe.mock.calls.map(([target]) => target)).toContain(entry);
  expect(inputRef).toHaveBeenCalledWith(input);

  contentHeight = 48;
  const prompt = "🦞".repeat(4_097) + "\nFinish the task";
  input.value = prompt;
  const event = new InputEvent("input", { bubbles: true, inputType: "insertText", data: prompt });
  input.dispatchEvent(event);
  expect(onValueChange).toHaveBeenCalledExactlyOnceWith(prompt, event);
  expect(input).toMatchObject({ value: prompt, style: { height: "48px" } });
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

  contentHeight = 144;
  input.focus();
  input.value = "Line one\nLine two\nLine three\nLine four";
  input.setSelectionRange(input.value.length, input.value.length);
  input.dispatchEvent(new InputEvent("input", { bubbles: true }));
  expect(input).toMatchObject({ style: { height: "72px" }, scrollTop: 144 });
  flush();

  input.scrollTop = 16;
  notifyResize();
  await vi.advanceTimersByTimeAsync(20);
  expect(input.scrollTop).toBe(16);

  const initialHeight = input.style.height;
  const initialEntryAttributes = attributes(entry);
  setValue("pending");
  flush();
  mounted.unmount();
  expect(disconnect).toHaveBeenCalledOnce();
  expect(inputRef).toHaveBeenLastCalledWith(undefined, input);
  mockLayout(input, 100, 20);
  input.scrollTop = 20;
  input.dispatchEvent(new Event("scroll"));
  expect(attributes(entry)).toEqual(initialEntryAttributes);
  await vi.advanceTimersByTimeAsync(20);
  expect(input.style.height).toBe(initialHeight);

  const remounted = mountSolid(view);
  const restored = remounted.container.querySelector("textarea")!;
  mockLayout(restored, 72);
  await vi.advanceTimersByTimeAsync(20);
  expect(restored.style.height).toBe("72px");
  restored.value = "Remounted";
  restored.dispatchEvent(new InputEvent("input", { bubbles: true }));
  expect(onValueChange).toHaveBeenLastCalledWith("Remounted", expect.any(InputEvent));
  remounted.unmount();
  expect(disconnect).toHaveBeenCalledTimes(2);
});
