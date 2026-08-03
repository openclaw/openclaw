/* @vitest-environment jsdom */

import { nothing, render } from "lit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { copyToClipboard } from "../lib/clipboard.ts";
import { renderCopyButton } from "./copy-button.ts";

vi.mock("../lib/clipboard.ts", () => ({
  copyToClipboard: vi.fn(),
}));

let container: HTMLDivElement;

beforeEach(() => {
  vi.useFakeTimers();
  vi.mocked(copyToClipboard).mockReset();
  container = document.createElement("div");
  document.body.append(container);
});

afterEach(() => {
  render(nothing, container);
  container.remove();
  vi.useRealTimers();
});

describe("renderCopyButton", () => {
  it.each([
    {
      firstCopied: true,
      firstFeedbackDurationMs: 1500,
      secondCopied: false,
      secondFeedbackDurationMs: 2000,
      secondFeedbackLabel: "Copy failed",
      secondFeedbackState: "error",
    },
    {
      firstCopied: false,
      firstFeedbackDurationMs: 2000,
      secondCopied: true,
      secondFeedbackDurationMs: 1500,
      secondFeedbackLabel: "Copied!",
      secondFeedbackState: "copied",
    },
  ] as const)(
    "keeps only the latest copy result when success changes from $firstCopied to $secondCopied",
    async ({
      firstCopied,
      firstFeedbackDurationMs,
      secondCopied,
      secondFeedbackDurationMs,
      secondFeedbackLabel,
      secondFeedbackState,
    }) => {
      vi.mocked(copyToClipboard)
        .mockResolvedValueOnce(firstCopied)
        .mockResolvedValueOnce(secondCopied);
      render(renderCopyButton("copy me", "Copy this text"), container);
      const button = container.querySelector<HTMLButtonElement>(".chat-copy-btn");
      if (!button) {
        throw new Error("Expected a copy button");
      }

      button.click();
      await Promise.resolve();
      vi.advanceTimersByTime(1000);
      button.click();
      await Promise.resolve();

      expect(button.dataset[secondFeedbackState]).toBe("1");
      expect(button.dataset[secondFeedbackState === "copied" ? "error" : "copied"]).toBeUndefined();
      expect(button.getAttribute("aria-label")).toBe(secondFeedbackLabel);

      const previousFeedbackRemainingMs = firstFeedbackDurationMs - 1000;
      vi.advanceTimersByTime(previousFeedbackRemainingMs);
      expect(button.dataset[secondFeedbackState]).toBe("1");
      expect(button.getAttribute("aria-label")).toBe(secondFeedbackLabel);

      vi.advanceTimersByTime(secondFeedbackDurationMs - previousFeedbackRemainingMs);
      expect(button.dataset.copied).toBeUndefined();
      expect(button.dataset.error).toBeUndefined();
      expect(button.getAttribute("aria-label")).toBe("Copy this text");
    },
  );
});
