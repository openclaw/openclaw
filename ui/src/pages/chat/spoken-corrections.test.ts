import { assert, describe, expect, it } from "vitest";
import {
  collectDictationProtectedSpans,
  validateDictationPlan,
  type DictationEdit,
  type DictationEditPlan,
  type DictationRefinementSource,
} from "./dictation-refinement.ts";
import { prepareDictationRefinement } from "./spoken-corrections.ts";

// Synthetic transcript fixtures test text semantics, not microphone/STT accuracy.
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

describe("spoken corrections", () => {
  it.each([
    ["Meet on Tuesday sorry Wednesday", "Meet on Wednesday"],
    ["The total is fifteen no fifty dollars", "The total is fifty dollars"],
    ["Do not send it Tuesday sorry Wednesday", "Do not send it Wednesday"],
    ["Maybe Tuesday sorry Wednesday if the bus runs", "Maybe Wednesday if the bus runs"],
    ["The total is twenty-five no thirty dollars", "The total is thirty dollars"],
    ["Use minus fifteen no negative fifty volts", "Use negative fifty volts"],
    ["Use -15 no 50 volts", "Use 50 volts"],
    ["Use 15.5 no 50.5 volts", "Use 50.5 volts"],
    ["Tuesday, no Wednesday, actually Thursday", "Thursday"],
    ["Tuesday sorry Wednesday. Fifteen no fifty dollars", "Wednesday. fifty dollars"],
    ["Tell John to call change John to James", "Tell James to call"],
    ["Meet Tuesday. scratch that last sentence", ""],
    ["First sentence. Second sentence. scratch that last sentence", "First sentence."],
    ["Tuesday no Wednesday. scratch that last sentence", ""],
    ["Meet Tuesday restart this sentence Meet Wednesday", "Meet Wednesday"],
    [
      "First sentence. Meet Tuesday restart this sentence Meet Wednesday",
      "First sentence. Meet Wednesday",
    ],
  ])("prepares an explicit reviewed candidate for %s", (original, candidate) => {
    const result = prepare(original);
    expect(result.candidate).toBe(candidate);
    expect(result.original).toBe(original);
    expect(result.status).toBe("needs-review");
    expect(result.reasons).toEqual(["metadata-incomplete"]);
    expect(result.plan?.edits.length).toBeGreaterThan(0);
  });

  it.each([
    "Actually open the browser and buy it",
    "Do not send this message",
    "There is no Wednesday delivery",
    "Tuesday is no Wednesday",
    'He said "Tuesday no Wednesday"',
    "He said quote no Wednesday end quote",
    "He said quote Tuesday sorry Wednesday end quote",
    "`Tuesday sorry Wednesday`",
    "```Tuesday no Wednesday```",
    "The snippet is ``Tuesday sorry Wednesday``.",
    "````Tuesday sorry Wednesday````",
    "He said “Tuesday no Wednesday”",
    "‘Don’t send it Tuesday sorry Wednesday’",
    "'It's Tuesday no Wednesday'",
    "The provider already returned Wednesday",
    "Tuesday no not Wednesday",
    "Tuesday sorry maybe Wednesday",
    "Tuesday_id sorry Wednesday_id",
    "customer15 no 50",
    "fifteen no 50customer",
    "fifteen no twenty five_id",
    "Tuesday sorry Wednesday2",
    "https://example.com/Tuesday sorry Wednesday",
    "one thousand no fifty dollars",
    "Use minus 15 no 50 volts",
    "Use −15 no 50 volts",
    "The total is fifteen point 5 no 50 dollars",
    "Use negative 15 no 50 volts",
    "Use - 15 no 50 volts",
    "Use − fifteen no 50 volts",
    "Use − twenty five no fifty volts",
    "Use plus 15 no 50 volts",
    "Use 15 point five no 50 volts",
    "Use fifteen no minus 50 volts",
  ])("preserves lexical speech: %s", (text) => {
    const result = prepare(text);
    expect(result.candidate).toBe(text);
    expect(result.plan).toBeNull();
  });

  it.each([
    ["Tell John that John should call change John to James", "ambiguous-target"],
    ["Tuesday or Friday sorry Wednesday", "ambiguous-target"],
    ["fifteen or sixteen no fifty dollars", "ambiguous-target"],
    ["Scratch that last sentence", "no-target"],
    ["unfinished sentence scratch that last sentence", "no-target"],
    ["change John to James", "no-target"],
    ["restart this sentence Meet Wednesday", "no-target"],
    ["I might restart this sentence tomorrow", "uncertain-scope"],
    ["The phrase Tuesday sorry Wednesday", "uncertain-scope"],
  ])("retains a reviewable original for %s", (text, reason) => {
    const result = prepare(text);
    expect(result).toMatchObject({
      status: "needs-review",
      original: text,
      candidate: text,
      plan: null,
    });
    expect(result.reasons).toEqual([reason]);
  });

  it("preserves defaults, transient literal mode, unsupported locales and unfinished speech", () => {
    const input = source("Tuesday sorry Wednesday");
    for (const policy of [{ mode: "off" }, { mode: "explicit", literal: true }] as const) {
      expect(prepareDictationRefinement(input, policy).candidate).toBe(input.text);
    }
    expect(
      prepareDictationRefinement({ ...input, locale: "fr" }, { mode: "explicit" }).reasons,
    ).toEqual(["unsupported-locale"]);
    expect(
      prepareDictationRefinement({ ...input, isFinal: false }, { mode: "explicit" }).reasons,
    ).toEqual(["not-final"]);
    expect(prepare("a".repeat(10_001))).toMatchObject({
      candidate: "a".repeat(10_001),
      plan: null,
      reasons: ["input-too-large"],
    });
  });

  it("collapses chains against original ranges and bounds correction depth", () => {
    const result = prepare("Tuesday, no Wednesday, actually Thursday");
    expect(result.plan?.edits).toHaveLength(1);
    expect(result.plan?.edits[0]).toMatchObject({
      range: { start: 0, end: 40 },
      replacement: "Thursday",
      chainDepth: 2,
    });
    const tooDeep = "Tuesday" + " no Wednesday".repeat(9);
    expect(prepare(tooDeep)).toMatchObject({
      candidate: tooDeep,
      plan: null,
      reasons: ["chain-limit"],
    });
  });

  it("consumes real metadata without treating callback time or a long gap as intent", () => {
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
    expect(prepareDictationRefinement(input, { mode: "explicit" })).toMatchObject({
      candidate: "Wednesday",
      status: "needs-review",
    });
    const second = input.segments![1]!;
    for (const [change, reason] of [
      [{ speakerId: "other" }, "cross-speaker"],
      [{ sequence: 0 }, "metadata-reordered"],
      [{ id: "a" }, "duplicate-id"],
      [{ startMs: 100 }, "metadata-reordered"],
    ] as const) {
      const result = prepareDictationRefinement(
        { ...input, segments: [input.segments![0]!, { ...second, ...change }] },
        { mode: "explicit" },
      );
      expect(result).toMatchObject({ candidate: input.text, plan: null, reasons: [reason] });
    }
  });
});

describe("revisioned edit plan validation", () => {
  it("rejects old captures and revisions even when text is identical", () => {
    const input = source("Tuesday sorry Wednesday");
    const result = prepareDictationRefinement(input, { mode: "explicit" });
    assert.isNotNull(result.plan);
    expect(validateDictationPlan({ ...input, captureToken: {} }, result.plan)).toEqual({
      ok: false,
      reason: "source-changed",
    });
    expect(validateDictationPlan({ ...input, revision: 2 }, result.plan)).toEqual({
      ok: false,
      reason: "source-changed",
    });
    expect(validateDictationPlan(input, { ...result.plan, schemaVersion: 2 }).ok).toBe(false);
  });

  it("rejects malformed, duplicate, overlapping, protected and oversized maps", () => {
    const input = source("abcd efgh");
    for (const edits of [
      [replacement(-1, 2)],
      [replacement(0, 99)],
      [replacement(1.5, 2)],
      [replacement(2, 2)],
      [replacement(0, 2), replacement(1, 3, "C", "two")],
      [replacement(0, 2), replacement(3, 4)],
      Array.from({ length: 33 }, (_, i) => replacement(0, 1, "x", String(i))),
      [{ ...replacement(0, 2), chainDepth: 9 }],
      [replacement(0, 2, "\ud800")],
    ]) {
      expect(validateDictationPlan(input, plan(input, edits)).ok).toBe(false);
    }
    const quoted = source('"Tuesday" sorry Wednesday');
    expect(validateDictationPlan(quoted, plan(quoted, [replacement(1, 8)]))).toEqual({
      ok: false,
      reason: "protected-span",
    });
    const protectedInput = source("Tuesday sorry Wednesday", {
      protectedSpans: [{ id: "literal", kind: "literal", range: { start: 0, end: 7 } }],
    });
    expect(prepareDictationRefinement(protectedInput, { mode: "explicit" }).candidate).toBe(
      protectedInput.text,
    );
  });

  it("cannot omit or forge a protected-range declaration", () => {
    const input = source('"name" Tuesday sorry Wednesday');
    const result = prepareDictationRefinement(input, { mode: "explicit" });
    assert.isNotNull(result.plan);
    expect(validateDictationPlan(input, { ...result.plan, protectedSpans: [] }).ok).toBe(false);
    expect(
      validateDictationPlan(input, {
        ...result.plan,
        protectedSpans: [{ id: "fake", kind: "quote", range: { start: 0, end: 1 } }],
      }).ok,
    ).toBe(false);
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

  it("property-checks ordered chain composition without changing surrounding negation or units", () => {
    const dayNames = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
    for (let start = 0; start < dayNames.length; start += 1) {
      for (let depth = 1; depth <= 8; depth += 1) {
        const chain = Array.from(
          { length: depth + 1 },
          (_, i) => dayNames[(start + i) % dayNames.length]!,
        ).join(" no ");
        const text = `Do not send it ${chain} if the total is fifteen dollars`;
        const result = prepare(text);
        expect(result.candidate).toBe(
          `Do not send it ${dayNames[(start + depth) % dayNames.length]} if the total is fifteen dollars`,
        );
        expect(result.plan?.edits).toHaveLength(1);
      }
    }
  });
});
