import { describe, expect, it } from "vitest";
import {
  collectDictationProtectedSpans,
  validateDictationPlan,
  type DictationEdit,
  type DictationEditPlan,
  type DictationRefinementSource,
} from "./dictation-refinement.ts";
import { prepareDictationRefinement } from "./spoken-corrections.ts";

// These fixtures cover retention and structural maps, not accepted semantic intent
// or microphone/STT accuracy. No current production preparer supplies an edit plan.
function source(
  text: string,
  fields: Partial<DictationRefinementSource> = {},
): DictationRefinementSource {
  return { captureToken: {}, revision: 1, text, locale: "en-US", isFinal: true, ...fields };
}
function prepare(text: string) {
  return prepareDictationRefinement(source(text), { mode: "explicit" });
}
function plan(input: DictationRefinementSource, edits: DictationEdit[]): DictationEditPlan {
  return {
    schemaVersion: 1,
    grammarVersion: "en-explicit-v1",
    captureToken: input.captureToken,
    revision: input.revision,
    sourceText: input.text,
    ambiguity: "unique",
    edits,
    protectedSpans: collectDictationProtectedSpans(input),
  };
}
function replacement(start: number, end: number, value = "B", id = "one"): DictationEdit {
  return {
    id,
    sourceSpanId: `source:${id}`,
    range: { start, end },
    replacement: value,
    triggerRange: { start, end },
    category: "replacement",
    chainDepth: 1,
  };
}

describe("spoken correction availability", () => {
  it.each([
    "I work Tuesday, no Wednesday shifts are available",
    "I work Tuesday, no Wednesday shifts this month",
    // Former positive commands remain literal while the semantic owner is absent.
    "Meet on Tuesday sorry Wednesday",
    "The total is fifteen no fifty dollars",
    "Do not send it Tuesday sorry Wednesday",
    "Tuesday, no Wednesday, actually Thursday",
    "Tell John to call change John to James",
    "First sentence. Second sentence. scratch that last sentence",
    "First sentence. Meet Tuesday restart this sentence Meet Wednesday",
    "Actually open the browser and buy it",
    'He said "Tuesday no Wednesday"',
    "`Tuesday sorry Wednesday`",
    "The provider already returned Wednesday",
    "https://example.com/Tuesday sorry Wednesday",
    "  e\u0301 👨‍👩‍👧 Tuesday sorry Wednesday\r\n\t",
    "",
  ])("keeps the exact original without an inferred correction: %s", (text) => {
    expect(prepare(text)).toEqual({
      status: "unavailable",
      original: text,
      candidate: text,
      plan: null,
      reasons: ["corrections-unavailable"],
    });
  });

  it.each([
    [{ mode: "off" }, "off"],
    [{ mode: "off", literal: true }, "off"],
    [{ mode: "explicit", literal: true }, "literal"],
  ] as const)("retains the unchanged raw bypass for %j", (policy, reason) => {
    const input = source("  Tuesday sorry Wednesday\r\n\t");
    expect(prepareDictationRefinement(input, policy)).toEqual({
      status: "unchanged",
      original: input.text,
      candidate: input.text,
      plan: null,
      reasons: [reason],
    });
  });

  it("retains text across locale, finality, bounds and supplied metadata", () => {
    const inputs = [
      source("Tuesday sorry Wednesday", { locale: "fr" }),
      source("Tuesday sorry Wednesday", { isFinal: false }),
      source("a".repeat(10_001)),
      source("Tuesday" + " no Wednesday".repeat(9)),
      source("Tuesday sorry Wednesday", {
        segments: [
          { id: "a", range: { start: 0, end: 7 }, speakerId: "first", sequence: 1 },
          { id: "a", range: { start: 8, end: 23 }, speakerId: "second", sequence: 0 },
        ],
        protectedSpans: [{ id: "literal", kind: "literal", range: { start: 0, end: 7 } }],
      }),
    ];
    for (const input of inputs) {
      expect(prepareDictationRefinement(input, { mode: "explicit" })).toEqual({
        status: "unavailable",
        original: input.text,
        candidate: input.text,
        plan: null,
        reasons: ["corrections-unavailable"],
      });
    }
  });
});

describe("revisioned edit plan validation", () => {
  it("rejects old captures and revisions even when text is identical", () => {
    const input = source("abcd efgh");
    const supplied = plan(input, [replacement(0, 4, "ABCD")]);
    expect(validateDictationPlan(input, supplied)).toEqual({ ok: true, candidate: "ABCD efgh" });
    expect(validateDictationPlan({ ...input, captureToken: {} }, supplied)).toEqual({
      ok: false,
      reason: "source-changed",
    });
    expect(validateDictationPlan({ ...input, revision: 2 }, supplied)).toEqual({
      ok: false,
      reason: "source-changed",
    });
    expect(validateDictationPlan(input, { ...supplied, schemaVersion: 2 })).toEqual({
      ok: false,
      reason: "invalid-plan",
    });
  });

  it("rejects malformed, duplicate, overlapping and oversized maps at their boundary", () => {
    const input = source("abcd efgh");
    const cases: [DictationEdit[], string][] = [
      [[replacement(-1, 2)], "invalid-range"],
      [[replacement(0, 99)], "invalid-range"],
      [[replacement(1.5, 2)], "invalid-range"],
      [[replacement(2, 2)], "invalid-range"],
      [[replacement(0, 2), replacement(1, 3, "C", "two")], "overlap"],
      [[replacement(0, 2), replacement(3, 4)], "duplicate-id"],
      [Array.from({ length: 33 }, (_, i) => replacement(0, 1, "x", String(i))), "plan-too-large"],
      [[{ ...replacement(0, 2), chainDepth: 0 }], "chain-limit"],
      [[{ ...replacement(0, 2), chainDepth: 9 }], "chain-limit"],
      [[replacement(0, 2, "\ud800")], "unicode-boundary"],
      [[replacement(0, 2, "x".repeat(10_001))], "plan-too-large"],
    ];
    for (const [edits, reason] of cases) {
      expect(validateDictationPlan(input, plan(input, edits))).toEqual({ ok: false, reason });
    }
  });

  it("rejects unfinished or oversized sources before applying a supplied map", () => {
    const input = source("abcd efgh");
    const supplied = plan(input, [replacement(0, 4, "ABCD")]);
    expect(validateDictationPlan({ ...input, isFinal: false }, supplied)).toEqual({
      ok: false,
      reason: "not-final",
    });
    const oversized = source("a".repeat(10_001));
    expect(validateDictationPlan(oversized, plan(oversized, [replacement(0, 1)]))).toEqual({
      ok: false,
      reason: "input-too-large",
    });
  });

  it("preserves lexical and caller-supplied protected spans", () => {
    const quoted = source('"Tuesday" sorry Wednesday');
    expect(validateDictationPlan(quoted, plan(quoted, [replacement(1, 8)]))).toEqual({
      ok: false,
      reason: "protected-span",
    });
    const protectedInput = source("Tuesday sorry Wednesday", {
      protectedSpans: [{ id: "literal", kind: "literal", range: { start: 0, end: 7 } }],
    });
    expect(
      validateDictationPlan(protectedInput, plan(protectedInput, [replacement(0, 7)])),
    ).toEqual({ ok: false, reason: "protected-span" });
  });

  it("cannot omit or forge a protected-range declaration", () => {
    const input = source('"name" alpha beta');
    const supplied = plan(input, [replacement(7, 12, "omega")]);
    expect(validateDictationPlan(input, supplied)).toEqual({
      ok: true,
      candidate: '"name" omega beta',
    });
    expect(validateDictationPlan(input, { ...supplied, protectedSpans: [] })).toEqual({
      ok: false,
      reason: "invalid-plan",
    });
    expect(
      validateDictationPlan(input, {
        ...supplied,
        protectedSpans: [{ id: "fake", kind: "quote", range: { start: 0, end: 1 } }],
      }),
    ).toEqual({ ok: false, reason: "invalid-plan" });
  });

  it("rejects an unquoted edit authorized by a protected trigger", () => {
    const input = source('Tuesday "sorry" Wednesday');
    const forged = replacement(0, 7, "Wednesday");
    forged.triggerRange = { start: 9, end: 14 };
    expect(validateDictationPlan(input, plan(input, [forged]))).toEqual({
      ok: false,
      reason: "protected-span",
    });
  });

  it("validates supplied metadata without treating a long gap as semantic intent", () => {
    const input = source("Tuesday sorry Wednesday", {
      segments: [
        {
          id: "a",
          range: { start: 0, end: 7 },
          sequence: 1,
          speakerId: "speaker",
          startMs: 0,
          endMs: 500,
        },
        {
          id: "b",
          range: { start: 8, end: 23 },
          sequence: 2,
          speakerId: "speaker",
          startMs: 120_000,
          endMs: 121_000,
        },
      ],
    });
    const supplied = plan(input, [replacement(0, 7, "Friday")]);
    expect(validateDictationPlan(input, supplied)).toEqual({
      ok: true,
      candidate: "Friday sorry Wednesday",
    });
    expect(prepareDictationRefinement(input, { mode: "explicit" })).toMatchObject({
      candidate: input.text,
      plan: null,
      status: "unavailable",
    });
    const second = input.segments![1]!;
    for (const [change, reason] of [
      [{ speakerId: "other" }, "cross-speaker"],
      [{ sequence: 0 }, "metadata-reordered"],
      [{ id: "a" }, "duplicate-id"],
      [{ startMs: 100 }, "metadata-reordered"],
    ] as const) {
      expect(
        validateDictationPlan(
          { ...input, segments: [input.segments![0]!, { ...second, ...change }] },
          supplied,
        ),
      ).toEqual({ ok: false, reason });
    }
  });

  it("property-checks generated UTF-16 ranges against independently known grapheme boundaries", () => {
    const clusters = ["A", "e\u0301", "👨‍👩‍👧", "🇺🇸", "क्‍ष", "Z"];
    let seed = 173;
    for (let sample = 0; sample < 80; sample += 1) {
      seed = (seed * 48271) % 2147483647;
      const sequence = Array.from(
        { length: 4 + (seed % 8) },
        (_, i) => clusters[(seed + i) % clusters.length]!,
      );
      const input = source(sequence.join(""));
      const offsets = [0];
      for (const cluster of sequence) {
        offsets.push(offsets.at(-1)! + cluster.length);
      }
      for (let i = 0; i < sequence.length; i += 1) {
        const start = offsets[i]!;
        const end = offsets[i + 1]!;
        const valid = validateDictationPlan(input, plan(input, [replacement(start, end)]));
        expect(valid).toEqual({
          ok: true,
          candidate: sequence.slice(0, i).join("") + "B" + sequence.slice(i + 1).join(""),
        });
        for (let split = start + 1; split < end; split += 1) {
          expect(validateDictationPlan(input, plan(input, [replacement(start, split)])).ok).toBe(
            false,
          );
        }
      }
    }
  });

  it("applies supplied maps in original-source order without changing negation or quantities", () => {
    const input = source("Do not send Alpha or Beta if total is fifteen dollars");
    const supplied = plan(input, [
      { ...replacement(21, 25, "second", "two"), chainDepth: 8 },
      replacement(12, 17, "first"),
    ]);
    expect(validateDictationPlan(input, supplied)).toEqual({
      ok: true,
      candidate: "Do not send first or second if total is fifteen dollars",
    });
  });
});
