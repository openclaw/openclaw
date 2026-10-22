/* @vitest-environment jsdom */

import { createSignal } from "solid-js";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mountSolid } from "../test-helpers/mount-solid.ts";
import { flush } from "../test-helpers/solid-settle.ts";
import { CommandPaletteInput } from "./command-palette-input.tsx";

function mockLayout(input: HTMLTextAreaElement, height: number) {
  input.style.lineHeight = "24px";
  Object.defineProperties(input, {
    scrollHeight: { configurable: true, get: () => height },
    clientHeight: {
      configurable: true,
      get: () => Number.parseFloat(input.style.height) || 24,
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

it("reports full edit events and retires input refs and pending layout on removal", async () => {
  const disconnect = vi.fn();
  vi.stubGlobal(
    "ResizeObserver",
    vi.fn(function () {
      return { observe: vi.fn(), disconnect };
    }),
  );
  const [value, setValue] = createSignal("");
  const inputRef = vi.fn();
  const onValueChange = vi.fn((next: string) => setValue(next));
  const view = () => (
    <CommandPaletteInput
      value={value()}
      placeholder="Search or start a task…"
      onInputRef={inputRef}
      onValueChange={onValueChange}
    />
  );
  const mounted = mountSolid(view);
  const input = mounted.container.querySelector("textarea")!;
  const entry = mounted.container.querySelector(".cmd-palette__entry")!;
  mockLayout(input, 48);
  await vi.advanceTimersByTimeAsync(20);
  expect(inputRef).toHaveBeenCalledWith(input);

  const prompt = "🦞".repeat(4_097) + "\nFinish the task";
  input.value = prompt;
  const event = new InputEvent("input", { bubbles: true, inputType: "insertText", data: prompt });
  input.dispatchEvent(event);
  expect(onValueChange).toHaveBeenCalledExactlyOnceWith(prompt, event);
  expect(input).toMatchObject({ value: prompt, style: { height: "48px" } });
  mockLayout(input, 24);
  setValue("Restored");
  flush();
  await vi.advanceTimersByTimeAsync(20);
  expect(input).toMatchObject({ value: "Restored", style: { height: "24px" } });
  const initialHeight = input.style.height;
  const initialEntryAttributes = attributes(entry);
  setValue("pending");
  flush();
  mounted.unmount();
  expect(disconnect).toHaveBeenCalledOnce();
  expect(inputRef).toHaveBeenLastCalledWith(undefined, input);
  mockLayout(input, 100);
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
