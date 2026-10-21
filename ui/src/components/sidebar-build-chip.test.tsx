import { flush } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { ControlUiBuildInfo } from "../build-info.ts";
import { cleanupSolid, mountSolid } from "../test-helpers/mount-solid.ts";
import { SidebarBuildChip } from "./sidebar-build-chip.tsx";

vi.mock("../build-info.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../build-info.ts")>()),
  CONTROL_UI_BUILD_INFO: {
    version: "2026.10.21",
    commit: "0123456789abcdef0123456789abcdef01234567",
    commitAt: null,
    builtAt: null,
    branch: "main",
    dirty: false,
    release: false,
    buildId: "synthetic-build",
  } satisfies ControlUiBuildInfo,
}));

const clipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, "clipboard");
const execCommandDescriptor = Object.getOwnPropertyDescriptor(document, "execCommand");
const writeText = vi.fn<(text: string) => Promise<void>>();
const fallback = vi.fn(() => false);

beforeEach(() => {
  vi.useFakeTimers();
  writeText.mockReset().mockResolvedValue(undefined);
  fallback.mockClear();
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
  Object.defineProperty(document, "execCommand", { configurable: true, value: fallback });
});

afterEach(() => {
  cleanupSolid();
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

function mountBuildChip() {
  const view = mountSolid(() => (
    <SidebarBuildChip basePath="" gatewayVersion="2026.10.21" variant="identity" />
  ));
  flush();
  const button = view.container.querySelector<HTMLButtonElement>(
    ".sidebar-build-hover-card__copy",
  )!;
  return { ...view, button };
}

describe("sidebar build commit copy", () => {
  it.each([
    [true, "Commit hash copied", "1"],
    [false, "Copy failed", "0"],
  ] as const)(
    "keeps settled copy=%s feedback for a full 1,500 ms after retry",
    async (copied, label, value) => {
      const pending = createDeferred();
      writeText.mockReturnValueOnce(pending.promise);
      const { button } = mountBuildChip();
      button.click();
      await vi.advanceTimersByTimeAsync(1_000);
      expect(button.getAttribute("aria-label")).toBe("Copy full commit hash");
      expect(button.dataset.copied).toBeUndefined();
      pending.resolve();
      await vi.advanceTimersByTimeAsync(0);
      expect(writeText).toHaveBeenCalledExactlyOnceWith("0123456789ab");
      expect(button.getAttribute("aria-label")).toBe("Commit hash copied");

      await vi.advanceTimersByTimeAsync(1_000);
      if (!copied) {
        writeText.mockRejectedValueOnce(new Error("Synthetic clipboard rejection"));
      }
      button.click();
      await vi.advanceTimersByTimeAsync(0);
      expect(button.getAttribute("aria-label")).toBe(label);
      expect(button.dataset.copied).toBe(value);
      await vi.advanceTimersByTimeAsync(1_499);
      expect(button.getAttribute("aria-label")).toBe(label);
      expect(button.dataset.copied).toBe(value);
      await vi.advanceTimersByTimeAsync(1);
      expect(button.getAttribute("aria-label")).toBe("Copy full commit hash");
      expect(button.dataset.copied).toBeUndefined();
    },
  );

  it("does not fall back or publish feedback after the build chip unmounts", async () => {
    const pending = createDeferred();
    writeText.mockReturnValueOnce(pending.promise);
    const { button, unmount } = mountBuildChip();
    button.click();
    unmount();
    pending.reject(new Error("Synthetic clipboard rejection"));
    await vi.advanceTimersByTimeAsync(0);
    expect(fallback).not.toHaveBeenCalled();
    expect(button.dataset.copied).toBeUndefined();
  });
});
