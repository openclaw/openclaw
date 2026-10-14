import { cleanup, fireEvent, render } from "@solidjs/testing-library";
import { createSignal, flush } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
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
  if (clipboardDescriptor) {
    Object.defineProperty(navigator, "clipboard", clipboardDescriptor);
  } else {
    Reflect.deleteProperty(navigator, "clipboard");
  }
  if (execCommandDescriptor) {
    Object.defineProperty(document, "execCommand", execCommandDescriptor);
  } else {
    Reflect.deleteProperty(document, "execCommand");
  }
});

describe("Solid copy button", () => {
  it.each(["resolve", "reject"] as const)(
    "retires an old payload before a pending clipboard write can %s",
    async (settlement) => {
      const pending = createDeferred();
      writeText.mockReturnValueOnce(pending.promise);
      const [text, setText] = createSignal("first");
      const view = render(() => <CopyButton text={text()} idleLabel="Copy value" />);
      const previous = view.getByRole<HTMLButtonElement>("button", { name: "Copy value" });
      fireEvent.click(previous);
      expect(previous.disabled).toBe(true);
      setText("second");
      flush();
      const current = view.getByRole<HTMLButtonElement>("button", { name: "Copy value" });
      expect(current).not.toBe(previous);
      expect(current.disabled).toBe(false);
      fireEvent.click(current);
      await vi.advanceTimersByTimeAsync(0);
      if (settlement === "resolve") {
        pending.resolve();
      } else {
        pending.reject(new Error("Synthetic clipboard rejection"));
      }
      await vi.advanceTimersByTimeAsync(0);
      expect(writeText.mock.calls).toEqual([["first"], ["second"]]);
      expect(fallback).not.toHaveBeenCalled();
      expect(current.dataset.copyState).toBe("copied");
      expect(view.getByRole("status").textContent).toBe("Copied!");
    },
  );

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
    expect(fallback).toHaveBeenCalledOnce();
    expect(button.getAttribute("aria-label")).toBe("Copied!");
    await vi.advanceTimersByTimeAsync(1_500);
    expect(button.getAttribute("aria-label")).toBe("Copier la valeur");
    expect(view.getByRole("status", { hidden: true }).hidden).toBe(true);
  });

  it("keeps an empty payload mounted and reports failure without writing the clipboard", async () => {
    const view = render(() => <CopyButton text="" idleLabel="Copy empty value" />);
    const button = view.getByRole<HTMLButtonElement>("button", { name: "Copy empty value" });
    fireEvent.click(button);
    await vi.advanceTimersByTimeAsync(0);
    expect(writeText).not.toHaveBeenCalled();
    expect(fallback).not.toHaveBeenCalled();
    expect(button.dataset.copyState).toBe("error");
    expect(view.getByRole("status").textContent).toBe("Copy failed");
  });

  it("does not fall back after its Solid owner is disposed", async () => {
    const pending = createDeferred();
    writeText.mockReturnValueOnce(pending.promise);
    const view = render(() => <CopyButton text="retired" idleLabel="Copy value" />);
    fireEvent.click(view.getByRole("button", { name: "Copy value" }));
    cleanup();
    pending.reject(new Error("Synthetic clipboard rejection"));
    await vi.advanceTimersByTimeAsync(0);
    expect(fallback).not.toHaveBeenCalled();
  });
});
