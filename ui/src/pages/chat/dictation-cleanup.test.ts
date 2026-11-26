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

describe("dictation preservation without a semantic owner", () => {
  it.each(DICTATION_CLEANUP_CORPUS)("preserves the complete source: $id", (sample) => {
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
    expect(result).toMatchObject({
      sourceId: source.id,
      revision: source.revision,
      raw: sample.raw,
      candidate: sample.raw,
      removals: [],
      status: "retained",
      sourceMap: [
        {
          sourceStart: 0,
          sourceEnd: sample.raw.length,
          candidateStart: 0,
          candidateEnd: sample.raw.length,
        },
      ],
    });
  });

  it("keeps Off unchanged, including already formatted and oversized text", () => {
    for (const text of [" um\n", "x".repeat(33000)]) {
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

  it("reports unavailable semantics without normalizing or classifying the text", () => {
    const original = Object.freeze({
      ...source,
      text: " \tum I I need fifteen sorry fifty copies\n\n",
      tokens: [{ start: 2, end: 4, confidence: 0.98, startTimeMs: 0, endTimeMs: 180 }],
    });
    expect(refineDictation(original, conservative)).toMatchObject({
      raw: original.text,
      candidate: original.text,
      removals: [],
      status: "retained",
      reason: "semantic-unavailable",
    });
  });

  it("does not treat valid source ranges or recognizer metadata as removal authority", () => {
    const original = {
      ...source,
      tokens: [{ start: 0, end: 2, confidence: 0.98, startTimeMs: 0, endTimeMs: 180 }],
    };
    for (const removals of [
      [],
      [removal],
      [{ ...removal, start: 3, end: 9 }],
      [{ ...removal, evidence: "text-and-provider-metadata" }],
    ]) {
      expect(validateCleanupPlan(original, conservative, { ...plan, removals })).toMatchObject({
        candidate: source.text,
        removals: [],
        status: "retained",
        reason: "semantic-unavailable",
      });
    }
  });

  it("validates protected spans and claimed provider metadata without semantic inference", () => {
    expect(
      validateCleanupPlan(
        { ...source, protectedSpans: [{ start: 0, end: 2 }] },
        conservative,
        plan,
      ),
    ).toMatchObject({ candidate: source.text, status: "rejected", reason: "protected-text" });
    expect(
      validateCleanupPlan(source, conservative, {
        ...plan,
        removals: [{ ...removal, evidence: "text-and-provider-metadata" }],
      }),
    ).toMatchObject({ candidate: source.text, status: "rejected", reason: "invalid-plan" });
  });

  it("retains source for malformed metadata and enforces input bounds", () => {
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

  it("rejects stale, overlapping, unsupported and unbounded plans", () => {
    for (const proposed of [
      null,
      { ...plan, version: 2 },
      { ...plan, sourceId: "other-capture" },
      { ...plan, revision: 6 },
      { ...plan, removals: [removal, removal] },
      { ...plan, removals: Array.from({ length: 65 }, () => removal) },
      { ...plan, removals: [{ ...removal, start: 0.5 }] },
      { ...plan, removals: [{ ...removal, end: Number.POSITIVE_INFINITY }] },
      { ...plan, removals: [{ ...removal, end: 30 }] },
      { ...plan, removals: [{ ...removal, start: 3, end: 2 }] },
      { ...plan, removals: [{ ...removal, end: 7 }] },
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

  it.each(["😀", "e\u0301", "👩‍💻"])("rejects ranges that split the grapheme %s", (grapheme) => {
    const original = { ...source, text: grapheme + " please call me tomorrow" };
    expect(
      validateCleanupPlan(original, conservative, {
        ...plan,
        removals: [{ ...removal, end: 1 }],
      }),
    ).toMatchObject({
      candidate: original.text,
      status: "rejected",
      reason: "invalid-plan",
    });
    expect(
      refineDictation({ ...original, tokens: [{ start: 0, end: 1 }] }, conservative),
    ).toMatchObject({
      candidate: original.text,
      status: "rejected",
      reason: "invalid-source",
    });
  });
});
