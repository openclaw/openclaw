// @vitest-environment node
import { describe, expect, it } from "vitest";
import { DICTATION_CLEANUP_CORPUS } from "./dictation-cleanup.test-support.ts";
import {
  type CleanupPolicy,
  type DictationCleanupSource,
  refineDictation,
  validateCleanupPlan,
} from "./dictation-cleanup.ts";

const conservative: CleanupPolicy = { version: 1, mode: "conservative", locale: "en" };
const source: DictationCleanupSource = {
  id: "capture-1",
  revision: 7,
  text: "um please call me tomorrow",
  isFinal: true,
};
const removal = { start: 0, end: 3, category: "hesitation", evidence: "text" };
const plan = { version: 1, sourceId: source.id, revision: source.revision, removals: [removal] };

describe("conservative dictation cleanup", () => {
  it.each(DICTATION_CLEANUP_CORPUS)("$label: $id", (sample) => {
    const result = refineDictation(
      {
        ...source,
        text: sample.raw,
        locale: sample.locale,
        protectedSpans: sample.protectedSpans,
        tokens: sample.tokens,
      },
      conservative,
    );
    expect(result.candidate).toBe(sample.expected);
    expect(result.raw).toBe(sample.raw);
    expect(
      result.sourceMap
        .map((range) => sample.raw.slice(range.sourceStart, range.sourceEnd))
        .join(""),
    ).toBe(sample.expected);
    for (const range of result.sourceMap) {
      expect(sample.raw.slice(range.sourceStart, range.sourceEnd)).toBe(
        result.candidate.slice(range.candidateStart, range.candidateEnd),
      );
    }
    if (sample.label === "safe-remove") {
      expect(result.status).toBe("refined");
      expect(result.removals.length).toBeGreaterThan(0);
    } else {
      expect(result.removals).toEqual([]);
    }
  });

  it("keeps all recognizer bytes with Off, including already formatted and oversized text", () => {
    for (const text of [
      ...DICTATION_CLEANUP_CORPUS.map((sample) => sample.raw),
      " um\n",
      "x".repeat(33000),
    ]) {
      expect(refineDictation({ ...source, text }, { version: 1, mode: "off" })).toMatchObject({
        raw: text,
        candidate: text,
        removals: [],
        status: "unchanged",
        reason: "off",
      });
    }
  });

  it("does not refine provisional text or silently select English", () => {
    expect(refineDictation({ ...source, isFinal: false }, conservative)).toMatchObject({
      candidate: source.text,
      reason: "not-final",
    });
    expect(
      refineDictation(source, { version: 1, mode: "conservative", locale: null }),
    ).toMatchObject({ candidate: source.text, reason: "unsupported-locale" });
    expect(refineDictation({ ...source, locale: "fr" }, conservative)).toMatchObject({
      candidate: source.text,
      reason: "unsupported-locale",
    });
  });

  it("retains a longer repeated construction that is not one exact restart", () => {
    for (const text of ["I I I need the invoice", "um I I I need the invoice"]) {
      expect(refineDictation({ ...source, text }, conservative)).toMatchObject({
        candidate: text,
        removals: [],
      });
    }
  });

  it("maps combined removals to the immutable original instead of shifted candidate offsets", () => {
    const original = Object.freeze({ ...source, text: "um I I need the invoice tomorrow" });
    expect(refineDictation(original, conservative)).toMatchObject({
      candidate: "I need the invoice tomorrow",
      removals: [
        { start: 0, end: 3, category: "hesitation", evidence: "text" },
        { start: 3, end: 5, category: "exact_restart", evidence: "text" },
      ],
      sourceMap: [{ sourceStart: 5, sourceEnd: 32, candidateStart: 0, candidateEnd: 27 }],
    });
    expect(original.text).toBe("um I I need the invoice tomorrow");
  });

  it("honors declared literal spans without inferring or inventing provider evidence", () => {
    expect(
      refineDictation({ ...source, protectedSpans: [{ start: 0, end: 2 }] }, conservative),
    ).toMatchObject({
      candidate: source.text,
      reason: "protected-text",
    });
    const withTiming = refineDictation(
      {
        ...source,
        tokens: [{ start: 0, end: 2, confidence: 0.98, startTimeMs: 0, endTimeMs: 180 }],
      },
      conservative,
    );
    expect(withTiming.candidate).toBe("please call me tomorrow");
    expect(withTiming.removals).toEqual([{ ...removal, evidence: "text" }]);
    expect(
      validateCleanupPlan(source, conservative, {
        ...plan,
        removals: [{ ...removal, evidence: "text-and-provider-metadata" }],
      }),
    ).toMatchObject({ candidate: source.text, reason: "invalid-plan" });
    expect(
      refineDictation(
        { ...source, tokens: [{ start: 10, end: 14, confidence: 0.1 }] },
        conservative,
      ),
    ).toMatchObject({ candidate: source.text, reason: "low-confidence" });
  });

  it("retains source for malformed metadata and enforces bounded input before processing", () => {
    for (const tokens of [
      [{ start: 0, end: 2, confidence: Number.NaN }],
      [{ start: 0, end: 2, confidence: 1.1 }],
      [{ start: -1, end: 2 }],
      [{ start: 0, end: 2, startTimeMs: 1 }],
      [{ start: 0, end: 2, startTimeMs: 10, endTimeMs: 1 }],
    ]) {
      expect(refineDictation({ ...source, tokens }, conservative)).toMatchObject({
        candidate: source.text,
        reason: "invalid-source",
      });
    }
    const oversized = "um please call " + "x".repeat(32768);
    expect(refineDictation({ ...source, text: oversized }, conservative)).toMatchObject({
      candidate: oversized,
      reason: "input-limit",
    });
  });

  it("rejects stale, overlapping, unsupported, unbounded and semantic deletion plans", () => {
    for (const proposed of [
      null,
      { ...plan, version: 2 },
      { ...plan, sourceId: "other-capture" },
      { ...plan, revision: 6 },
      { ...plan, removals: [removal, removal] },
      { ...plan, removals: Array.from({ length: 65 }, () => removal) },
      { ...plan, removals: [{ ...removal, start: 0.5 }] },
      { ...plan, removals: [{ ...removal, end: Number.POSITIVE_INFINITY }] },
      { ...plan, removals: [{ ...removal, end: 4 }] },
      { ...plan, removals: [{ ...removal, start: 3, end: 10 }] },
      { ...plan, removals: [{ ...removal, category: "rewrite" }] },
      { ...plan, removals: [{ ...removal, evidence: "model-confidence" }] },
    ]) {
      expect(validateCleanupPlan(source, conservative, proposed)).toMatchObject({
        candidate: source.text,
        removals: [],
        status: "rejected",
      });
    }
  });

  it("keeps critical and literal text even when an external plan requests its removal", () => {
    for (const text of [
      "not",
      "15",
      "kg",
      "maybe",
      "like",
      "well",
      "no",
      "sorry",
      "😀",
      "e\u0301",
      "👩‍💻",
    ]) {
      const critical = { ...source, text };
      expect(
        validateCleanupPlan(critical, conservative, {
          ...plan,
          removals: [{ ...removal, end: Math.min(1, text.length) }],
        }),
      ).toMatchObject({ candidate: text, removals: [] });
    }
  });
});
