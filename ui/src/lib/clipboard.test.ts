import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { copyToClipboard } from "./clipboard.ts";

const exec = vi.fn();
const writeText = vi.fn();
beforeEach(() => {
  exec.mockReset().mockReturnValue(true);
  writeText.mockReset().mockResolvedValue(undefined);
  vi.stubGlobal("navigator", { clipboard: { writeText } });
  // jsdom does not implement execCommand.
  (document as unknown as { execCommand: unknown }).execCommand = exec;
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  delete (document as unknown as { execCommand?: unknown }).execCommand;
});

describe("copyToClipboard", () => {
  it.each(["", "hello"])("uses only the Clipboard API for %j", async (text) => {
    expect(await copyToClipboard(text)).toBe(text !== "");
    expect(writeText.mock.calls).toEqual(text ? [[text]] : []);
    expect(exec).not.toHaveBeenCalled();
  });

  it("falls back to execCommand when the Clipboard API rejects", async () => {
    writeText.mockRejectedValue(new Error("denied"));

    expect(await copyToClipboard("hello")).toBe(true);
    expect(exec).toHaveBeenCalledWith("copy");
    expect(document.querySelector("textarea")).toBeNull();
  });

  it("skips fallback when the caller retires a rejected async write", async () => {
    const pending = createDeferred();
    writeText.mockReturnValue(pending.promise);
    let current = true;

    const copy = copyToClipboard("hello", () => current);
    current = false;
    pending.reject(new Error("denied"));

    expect(await copy).toBe(false);
    expect(exec).not.toHaveBeenCalled();
    expect(document.querySelector("textarea")).toBeNull();
  });

  it("falls back to execCommand over plain HTTP where navigator.clipboard is undefined", async () => {
    vi.stubGlobal("navigator", {});

    expect(await copyToClipboard("hello")).toBe(true);
    expect(exec).toHaveBeenCalledWith("copy");
    expect(document.querySelector("textarea")).toBeNull();
  });

  it("returns false when both clipboard paths fail", async () => {
    vi.stubGlobal("navigator", {});
    exec.mockReturnValue(false);

    expect(await copyToClipboard("hello")).toBe(false);
    expect(exec).toHaveBeenCalledWith("copy");
    expect(document.querySelector("textarea")).toBeNull();
  });

  it("keeps deferred focus restoration bound to its document after globals retire", async () => {
    vi.stubGlobal("navigator", {});
    exec.mockReturnValue(false);
    vi.useFakeTimers();
    expect(await copyToClipboard("hello")).toBe(false);
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    vi.stubGlobal("document", undefined);
    expect(() => vi.runAllTimers()).not.toThrow();
  });

  it.each(["restore", "newer focus", "removed target"] as const)(
    "restores focus only when still appropriate after the fallback: %s",
    async (state) => {
      vi.stubGlobal("navigator", {});
      const button = document.createElement("button");
      const input = document.createElement("input");
      document.body.append(button);
      button.focus();
      const focus = vi.spyOn(button, "focus");
      button.disabled = true;

      expect(await copyToClipboard("hello")).toBe(true);
      button.disabled = false;
      button.blur();
      if (state === "newer focus") {
        document.body.append(input);
        input.focus();
      } else if (state === "removed target") {
        button.remove();
      }
      await new Promise<void>((resolve) => {
        window.setTimeout(resolve, 0);
      });
      const expectedFocus =
        state === "restore" ? button : state === "newer focus" ? input : document.body;
      expect(document.activeElement).toBe(expectedFocus);
      expect(focus.mock.calls).toEqual(state === "restore" ? [[{ preventScroll: true }]] : []);
      button.remove();
      input.remove();
    },
  );
});
