import { cleanup, fireEvent, render } from "@solidjs/testing-library";
import { createSignal, flush } from "solid-js";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { restorePropertyDescriptor } from "../../test-helpers/property-descriptor.ts";
import { CopyButton } from "./copy-button.tsx";

const clipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, "clipboard");
const execCommandDescriptor = Object.getOwnPropertyDescriptor(document, "execCommand");
const writeText = vi.fn<(text: string) => Promise<void>>();
const fallback = vi.fn(() => true);

beforeEach(() => {
  vi.useFakeTimers();
  writeText.mockReset().mockResolvedValue(undefined);
  fallback.mockClear();
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
  Object.defineProperty(document, "execCommand", { configurable: true, value: fallback });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  restorePropertyDescriptor(navigator, "clipboard", clipboardDescriptor);
  restorePropertyDescriptor(document, "execCommand", execCommandDescriptor);
});

it.each(["resolve", "reject", "dispose"] as const)("retires copy: %s", async (settlement) => {
  const pending = createDeferred();
  writeText.mockReturnValueOnce(pending.promise);
  const [text, setText] = createSignal("first");
  const view = render(() => <CopyButton text={text()} idleLabel={`Copy ${text()}`} />);
  const previous = view.getByRole<HTMLButtonElement>("button", { name: "Copy first" });
  fireEvent.click(previous);
  if (settlement === "dispose") {
    view.unmount();
  } else {
    setText("second");
    flush();
    const current = view.getByRole<HTMLButtonElement>("button", { name: "Copy second" });
    expect(current).not.toBe(previous);
    expect(current.disabled).toBe(false);
    fireEvent.click(current);
    await vi.advanceTimersByTimeAsync(0);
  }
  if (settlement === "resolve") {
    pending.resolve();
  } else {
    pending.reject(new Error("Synthetic clipboard rejection"));
  }
  await vi.advanceTimersByTimeAsync(0);
  expect(fallback).not.toHaveBeenCalled();
  if (settlement !== "dispose") {
    expect(writeText.mock.calls).toEqual([["first"], ["second"]]);
    expect(view.getByRole("status").textContent).toBe("Copied!");
    setText("third");
    flush();
    const fresh = view.getByRole<HTMLButtonElement>("button", { name: "Copy third" });
    expect(view.getByRole("status", { hidden: true }).hidden).toBe(true);
    await vi.advanceTimersByTimeAsync(1_500);
    expect(fresh.getAttribute("aria-label")).toBe("Copy third");
  }
});

it("keeps focus and pending copy across an idle-label update, then resets to the latest label", async () => {
  const pending = createDeferred();
  writeText.mockReturnValueOnce(pending.promise);
  const [label, setLabel] = createSignal("Copy value");
  const view = render(() => <CopyButton text="same" idleLabel={label()} />);
  const button = view.getByRole<HTMLButtonElement>("button", { name: "Copy value" });
  button.focus();
  fireEvent.click(button);
  setLabel("Copier la valeur");
  flush();
  expect(document.activeElement).toBe(button);
  expect(view.getByRole("button", { name: "Copier la valeur" })).toBe(button);
  expect(button.disabled).toBe(true);
  pending.reject(new Error("Synthetic clipboard rejection"));
  await vi.advanceTimersByTimeAsync(0);
  expect(button.getAttribute("aria-label")).toBe("Copied!");
  await vi.advanceTimersByTimeAsync(1_500);
  expect(button.getAttribute("aria-label")).toBe("Copier la valeur");
  expect(view.getByRole("status", { hidden: true }).hidden).toBe(true);
});

it.each(["newer focus", "unfocused", "dispose"] as const)(
  "preserves other focus when a copy settles: %s",
  async (scenario) => {
    const pending = createDeferred();
    writeText.mockReturnValueOnce(pending.promise);
    const view = render(() => (
      <>
        <CopyButton text="same" />
        <input aria-label="Other control" />
      </>
    ));
    const button = view.getByRole<HTMLButtonElement>("button", { name: "Copy as markdown" });
    const input = view.getByRole<HTMLInputElement>("textbox", { name: "Other control" });
    (scenario === "unfocused" ? input : button).focus();
    fireEvent.click(button);
    expect(button.disabled).toBe(true);
    fireEvent.click(button);
    expect(writeText.mock.calls).toEqual([["same"]]);
    if (scenario === "newer focus") {
      input.focus();
    } else if (scenario === "dispose") {
      view.unmount();
    }
    pending.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(document.activeElement).toBe(scenario === "dispose" ? document.body : input);
    expect(fallback).not.toHaveBeenCalled();
    if (scenario !== "dispose") {
      expect(button.disabled).toBe(false);
      expect(button.getAttribute("aria-label")).toBe("Copied!");
    }
  },
);
