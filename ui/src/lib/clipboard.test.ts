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
  it("returns false without touching the clipboard for empty text", async () => {
    expect(await copyToClipboard("")).toBe(false);
    expect(writeText).not.toHaveBeenCalled();
    expect(exec).not.toHaveBeenCalled();
  });

  it("uses the async Clipboard API in secure contexts", async () => {
    expect(await copyToClipboard("hello")).toBe(true);
    expect(writeText).toHaveBeenCalledWith("hello");
    expect(exec).not.toHaveBeenCalled();
  });

  it("falls back to execCommand when the Clipboard API rejects", async () => {
    const writeText = vi.fn().mockRejectedValue(new Error("denied"));
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    const exec = mockExecCommand(true);

    expect(await copyToClipboard("hello")).toBe(true);
    expect(exec).toHaveBeenCalledWith("copy");
    expect(document.querySelector("textarea")).toBeNull();
  });

  it("skips fallback when the caller retires a rejected async write", async () => {
    const pending = createDeferred<void>();
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
    const exec = mockExecCommand(true);

    expect(await copyToClipboard("hello")).toBe(true);
    expect(exec).toHaveBeenCalledWith("copy");
    expect(document.querySelector("textarea")).toBeNull();
  });

  it("returns false when both clipboard paths fail", async () => {
    vi.stubGlobal("navigator", {});
    const exec = mockExecCommand(false);

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
      if (state === "restore") {
        expect(document.activeElement).toBe(button);
        expect(focus).toHaveBeenCalledWith({ preventScroll: true });
      } else {
        expect(document.activeElement).toBe(state === "newer focus" ? input : document.body);
        expect(focus).not.toHaveBeenCalled();
      }

      button.remove();
      input.remove();
    },
  );
});
