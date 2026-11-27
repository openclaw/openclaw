// @vitest-environment node
import { describe, expect, it } from "vitest";
import { dictationReviewReason, isCleanupSourceBounded } from "./dictation-cleanup.ts";

const conservative = { version: 1, mode: "conservative", locale: "en" } as const;
const source = { id: "capture-1", revision: 7, text: "um please call me tomorrow", isFinal: true };

describe("dictation review source checks", () => {
  it("does not apply review to Off, an interim result, or an unsupported locale", () => {
    expect(dictationReviewReason(source, { version: 1, mode: "off", locale: null })).toBe("off");
    expect(dictationReviewReason({ ...source, isFinal: false }, conservative)).toBe("not-final");
    expect(dictationReviewReason(source, { ...conservative, locale: null })).toBe(
      "unsupported-locale",
    );
    expect(dictationReviewReason({ ...source, locale: "fr" }, conservative)).toBe(
      "unsupported-locale",
    );
  });

  it("requires a source identity and a valid revision", () => {
    expect(dictationReviewReason({ ...source, id: "" }, conservative)).toBe("invalid-source");
    expect(dictationReviewReason({ ...source, revision: -1 }, conservative)).toBe("invalid-source");
  });

  it("enforces the 32 KiB UTF-8 limit, not merely a UTF-16 length limit", () => {
    const max = "é".repeat(16 * 1024);
    expect(isCleanupSourceBounded(max)).toBe(true);
    expect(isCleanupSourceBounded(max + "é")).toBe(false);
  });
});
