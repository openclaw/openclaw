import { describe, expect, it, vi } from "vitest";
import { DictationRefinementCoordinator } from "../../../src/shared/dictation-refinement/coordinator.js";
import type { RefinementRequest } from "../../../src/shared/dictation-refinement/types.js";
import {
  createPunctuationProcessor,
  refineDictation,
  validateDictationEdits,
  type DictationPunctuationPolicy,
  type DictationSourceEdit,
  type PunctuationDetail,
  type PunctuationInput,
} from "./dictation-refinement.js";

function request(
  rawTranscript: string,
  overrides: Partial<PunctuationInput> = {},
): PunctuationInput {
  return {
    rawTranscript,
    policy: { mode: "automatic", locale: "en-US", explicitEnabled: false },
    context: { left: "", right: "" },
    ...overrides,
  };
}

function candidate(text: string, edits: readonly unknown[]) {
  return { text, edits };
}

const explicitPolicy = { mode: "explicit", locale: "en-US", explicitEnabled: true } as const;

describe("local dictation punctuation policy", () => {
  it("keeps recognizer bytes in Verbatim and never normalizes number words or negation", () => {
    const raw = "  i do not authorize fifteen dollars!!\n";
    expect(
      refineDictation(
        request(raw, {
          policy: { mode: "verbatim", explicitEnabled: false },
        }),
      ),
    ).toMatchObject({ text: raw, edits: [], reasons: ["verbatim"] });
    expect(refineDictation(request("I do not authorize the transfer")).text).toBe(
      "I do not authorize the transfer.",
    );
    expect(refineDictation(request("fifteen dollars may be enough")).text).toBe(
      "Fifteen dollars may be enough.",
    );
  });

  it.each([
    ["version 1.2.3 costs 3.50", "Version 1.2.3 costs 3.50."],
    ["iPhone API OpenClaw", "iPhone API OpenClaw"],
    ["iÉcole ships myÜtil and ref١", "iÉcole ships myÜtil and ref١."],
    ["use https://example.test/a?x=1 and a@b.test", "Use https://example.test/a?x=1 and a@b.test."],
    ["read /tmp/a.txt and C:\\Temp\\file.txt", "Read /tmp/a.txt and C:\\Temp\\file.txt."],
    ["keep ref_123 and camelCase at -3.50 kg", "Keep ref_123 and camelCase at -3.50 kg."],
    ["The word period belongs here", "The word period belongs here."],
    ["  hello world \t\n", "  Hello world. \t\n"],
    ["hello.", "Hello."],
  ])("preserves protected lexical content in %s", (raw, expected) => {
    expect(refineDictation(request(raw)).text).toBe(expected);
  });

  it.each([
    "Hello, world!",
    "Wait...",
    "Really?!",
    "He said “Hello, world!”",
    "He said “She said 'yes!'”",
  ])("does not accumulate punctuation in %s", (raw) => {
    const first = refineDictation(request(raw));
    const second = refineDictation(request(first.text));
    expect(first.text).toBe(raw);
    expect(second.text).toBe(raw);
    expect(second.edits).toEqual([]);
  });

  it("uses authorized context and fragment policy without changing neighboring text", () => {
    expect(
      refineDictation(
        request("call me", {
          context: { left: "Please ", right: " tomorrow." },
        }),
      ).text,
    ).toBe("call me");
    expect(
      refineDictation(
        request("a possible title", {
          policy: { mode: "automatic", locale: "en-US", explicitEnabled: false, fragment: true },
        }),
      ).text,
    ).toBe("a possible title");
    expect(refineDictation(request("hello", { context: undefined }))).toMatchObject({
      text: "hello",
      reasons: ["context-unavailable"],
    });
  });

  it.each([undefined, "en", "en-GB", "fr-FR", "ar", "not_a_locale"])(
    "does not silently apply English for locale %s",
    (locale) => {
      expect(
        refineDictation(
          request("hello world", {
            policy: { mode: "automatic", locale, explicitEnabled: false },
          }),
        ),
      ).toMatchObject({ text: "hello world", edits: [], reasons: ["unsupported-locale"] });
    },
  );

  it("retains mixed-script text and explicitly identified Latin code-switching", () => {
    for (const input of [request("hello 世界"), request("hello bonjour", { mixedLocale: true })]) {
      expect(refineDictation(input)).toMatchObject({
        text: input.rawTranscript,
        reasons: ["mixed-locale"],
      });
    }
  });

  it("consumes only the separately enabled, complete spoken-mark grammar", () => {
    const raw = "hello comma world period";
    const refined = refineDictation(request(raw, { policy: explicitPolicy }));
    expect(refined).toMatchObject({
      text: "Hello, world.",
      reasons: [],
      effectiveLocale: "en-US",
      edits: [
        { start: 0, end: 1, text: "H", reason: "sentence-case" },
        { start: 5, end: 11, text: ",", reason: "explicit-punctuation" },
        { start: 17, end: 24, text: ".", reason: "explicit-punctuation" },
      ],
    });
    expect(
      refineDictation(
        request(raw, {
          policy: { ...explicitPolicy, explicitEnabled: false },
        }),
      ),
    ).toMatchObject({ text: raw, reasons: ["explicit-disabled"] });
    expect(
      refineDictation(request("hello comma world period.", { policy: explicitPolicy })).text,
    ).toBe("Hello, world.");
    expect(refineDictation(request(refined.text, { policy: explicitPolicy })).text).toBe(
      refined.text,
    );
  });

  it.each([
    "the word period belongs here",
    "I studied the Jurassic period",
    "it lasted a rest period",
    "I worked for an entire period",
    "we examined comma usage during Jurassic period",
    "please review comma usage from that historical period",
    "hello period",
    "a comma and a period",
    "hello comma period",
    "hello comma world period extra",
    "hello colon world",
    "Call me comma, please period.",
    "Call me, insert, comma, please insert period.",
    "Call me,, insert comma, please insert period.",
    "Call me, insert comma; please insert period.",
    "'hello comma world' period",
    '"outer \\"hello comma world\\" tail" period',
  ])("retains ambiguous or literal punctuation words in %s", (raw) => {
    expect(refineDictation(request(raw, { policy: explicitPolicy }))).toMatchObject({
      text: raw,
      edits: [],
      reasons: ["ambiguous-command"],
    });
  });

  it.each([
    "'hello comma world'",
    '"hello comma world\nnext',
    "`hello comma world period`",
    "```\nhello `comma` world period\n```",
    "“outer 'hello comma world' tail”",
  ])("protects literal envelopes including unclosed and nested delimiters: %s", (raw) => {
    expect(refineDictation(request(raw, { policy: explicitPolicy })).text).toBe(raw);
  });

  it("preserves literal commands inside quotes while consuming an outside command sequence", () => {
    expect(
      refineDictation(
        request("'hello comma world' insert comma friend insert period", {
          policy: explicitPolicy,
        }),
      ).text,
    ).toBe("'hello comma world', friend.");
    for (const delimiter of ['\\"', "\\`"]) {
      const literal = `${delimiter}hello insert comma world${delimiter}`;
      expect(
        refineDictation(
          request(`${literal} insert comma friend insert period`, {
            policy: explicitPolicy,
          }),
        ).text,
      ).toBe(`${literal}, friend.`);
    }
  });

  it.each([
    ["call me insert comma please insert period", "Call me, please."],
    ["can you confirm insert question mark", "Can you confirm?"],
    ["what a day insert exclamation mark", "What a day!"],
    ["options insert colon one insert semicolon two insert full stop", "Options: one; two."],
  ])("recognizes introduced commands without guessing intent in %s", (raw, expected) => {
    expect(refineDictation(request(raw, { policy: explicitPolicy })).text).toBe(expected);
  });

  it("maps an entire combining grapheme and preserves a ZWJ sequence", () => {
    const result = refineDictation(request("e\u0301clair for 👩‍💻"));
    expect(result.text).toBe("E\u0301clair for 👩‍💻");
    expect(result.edits).toEqual([{ start: 0, end: 2, text: "E\u0301", reason: "sentence-case" }]);
  });

  it("does not mutate a frozen request, policy, or context", () => {
    const input = Object.freeze(
      request("openclaw arrives", {
        policy: Object.freeze({ mode: "automatic", locale: "en-US", explicitEnabled: false }),
        context: Object.freeze({ left: "", right: "" }),
      }),
    );
    expect(refineDictation(input).text).toBe("Openclaw arrives.");
    expect(input.rawTranscript).toBe("openclaw arrives");
  });
});

describe("bounded source-map validation", () => {
  const input = request("hello");
  const edits: DictationSourceEdit[] = [
    { start: 0, end: 1, text: "H", reason: "sentence-case" },
    { start: 5, end: 5, text: ".", reason: "punctuation-insert" },
  ];

  it("accepts an independently authored map against the exact source text", () => {
    expect(validateDictationEdits(input, candidate("Hello.", edits))).toMatchObject({
      text: "Hello.",
      edits,
    });
  });

  it.each([
    [{ text: "Hello. Extra words" }, "invalid-edit-map"],
    [{ text: "x".repeat(33_000) }, "output-too-large"],
    [{ edits: Array.from({ length: 129 }, () => edits[0]) }, "invalid-edit-map"],
    [{ edits: [edits[1], edits[0]] }, "invalid-edit-map"],
    [{ edits: [...edits, edits[1]] }, "invalid-edit-map"],
    [{ edits: [{ ...edits[0], start: 0.5 }] }, "invalid-edit-map"],
    [{ edits: [{ ...edits[0], end: 6 }] }, "invalid-edit-map"],
    [{ edits: [{ ...edits[0], start: -1 }] }, "invalid-edit-map"],
    [{ edits: [{ ...edits[0], end: -1 }] }, "invalid-edit-map"],
    [{ edits: [{ ...edits[0], text: "Greetings" }] }, "unapproved-edit"],
    [{ edits: [{ ...edits[1], text: " " }] }, "unapproved-edit"],
    [{ edits: [{ ...edits[0], reason: "punctuation-remove" }] }, "unapproved-edit"],
  ])("rejects unauthorized candidate %#", (patch, reason) => {
    expect(
      validateDictationEdits(input, { ...candidate("Hello.", edits), ...patch }),
    ).toMatchObject({
      text: "hello",
      edits: [],
      reasons: [reason],
    });
  });

  it.each([null, [], {}, { text: "hello", edits: null }].map((value) => ({ value })))(
    "rejects malformed result %#",
    ({ value }) => {
      expect(validateDictationEdits(input, value)).toMatchObject({
        text: "hello",
        reasons: ["invalid-candidate"],
      });
    },
  );

  it.each([
    ["e\u0301clair", 0, 1, "E"],
    ["a 👩‍💻 works", 2, 3, "x"],
    ["a 👩‍💻 works", 4, 4, "."],
  ])("rejects splitting a grapheme in %s", (raw, start, end, text) => {
    const source = request(raw);
    expect(
      validateDictationEdits(
        source,
        candidate(raw, [{ start, end, text, reason: "sentence-case" }]),
      ),
    ).toMatchObject({ text: raw, edits: [], reasons: ["invalid-edit-map"] });
  });

  it("rejects punctuation that changes meaning even when every lexical word survives", () => {
    const source = request("I do not authorize the transfer");
    expect(
      validateDictationEdits(
        source,
        candidate("I do. not authorize the transfer", [
          { start: 4, end: 4, text: ".", reason: "punctuation-insert" },
        ]),
      ),
    ).toMatchObject({ text: source.rawTranscript, reasons: ["unapproved-edit"] });
    const contraction = request("we can't proceed");
    expect(
      validateDictationEdits(
        contraction,
        candidate("we cant proceed", [
          { start: 6, end: 7, text: "", reason: "punctuation-remove" },
        ]),
      ),
    ).toMatchObject({ text: contraction.rawTranscript, reasons: ["protected-text"] });
  });

  it("bounds grammar work by UTF-8 bytes and declines malformed Unicode", () => {
    for (const source of [
      request("x".repeat(32_769)),
      request("é".repeat(16_385)),
      request("hello", { context: { left: "x".repeat(8193), right: "" } }),
    ]) {
      expect(refineDictation(source)).toMatchObject({
        text: source.rawTranscript,
        reasons: ["input-too-large"],
      });
    }
    expect(refineDictation(request("bad \uD800"))).toMatchObject({
      text: "bad \uD800",
      reasons: ["invalid-request"],
    });
  });
});

function runPunctuation(
  rawTranscript: string,
  policy: DictationPunctuationPolicy,
  overrides: Partial<RefinementRequest> = {},
) {
  const observe = vi.fn<(detail: PunctuationDetail) => void>();
  const processor = createPunctuationProcessor(policy, { left: "", right: "" }, observe);
  const coordinator = new DictationRefinementCoordinator({
    processors: [processor],
    now: () => 0,
    isCurrent: () => true,
    authorize: () => true,
  });
  const result = coordinator.refine({
    schemaVersion: 1,
    offsetUnit: "utf16",
    captureId: "capture-a",
    generation: 3,
    transcriptRevision: 7,
    rawTranscript,
    isFinal: true,
    mode: "dictation",
    locale: { tag: "en-US", source: "user" },
    target: { id: "draft", revision: 1, draftRevision: 2 },
    scope: {
      connectionId: "test",
      connectionGeneration: 1,
      accountId: "local",
      authorizationRevision: 1,
      policyRevision: 1,
    },
    transcriptProvenance: { authorizationRevision: 1, hintSnapshotIds: [] },
    contextSnapshots: [],
    vocabularySnapshots: [],
    protectedSpans: [],
    authorizedEdits: [],
    featurePolicy: { enabled: true, processorIds: [processor.id] },
    providerPolicy: { routeId: null, locality: "strict-local" },
    deadlineAt: 2500,
    ...overrides,
  } satisfies RefinementRequest);
  return { result, observe };
}

describe("punctuation through the shared coordinator", () => {
  it.each([
    ["Call me, insert comma, please insert period.", 29, 43, "", ""],
    ["Call me, insert comma, please, insert period.", 29, 44, "", ""],
    ["Call me, insert comma please, insert period", 28, 43, ",", "."],
  ] as const)(
    "proposes one mark per intact command with exact source spans in %s",
    async (raw, secondStart, secondEnd, comma, period) => {
      const { result, observe } = runPunctuation(raw, explicitPolicy);
      expect(await result).toMatchObject({
        status: "needs-review",
        rawText: raw,
        text: raw,
        candidateText: "Call me, please.",
      });
      expect(observe).toHaveBeenCalledWith({
        edits: [
          { start: 7, end: 21, text: comma, reason: "explicit-punctuation" },
          { start: secondStart, end: secondEnd, text: period, reason: "explicit-punctuation" },
        ],
        reasons: [],
        effectiveLocale: "en-US",
      });
    },
  );

  it("uses the prepared text, remapped protection and advanced base, without authorizing insertion", async () => {
    const raw = "token asks 'insert comma' insert question mark";
    const reference = "secret insert comma";
    const literal = " asks 'insert comma'";
    const prepared = reference + literal;
    const { result, observe } = runPunctuation(raw, explicitPolicy, {
      authorizedEdits: [
        {
          start: 0,
          end: 5,
          text: reference,
          kind: "reference",
          intentId: "resolve-recipient",
          protection: { kind: "reference", identity: "recipient:1" },
        },
      ],
    });
    expect(await result).toMatchObject({
      status: "needs-review",
      text: raw,
      rawText: raw,
      candidateText: prepared + "?",
      warnings: ["meaning-review"],
      metrics: { providerRequests: 0 },
    });
    expect(observe).toHaveBeenCalledWith({
      edits: [
        {
          start: prepared.length,
          end: prepared.length + " insert question mark".length,
          text: "?",
          reason: "explicit-punctuation",
        },
      ],
      reasons: [],
      effectiveLocale: "en-US",
    });
  });

  it("preserves the entire verbatim input and discloses abstention", async () => {
    const raw = "  keep my words\t\n";
    const { result, observe } = runPunctuation(raw, { mode: "verbatim", explicitEnabled: false });
    expect(await result).toMatchObject({ status: "refined", text: raw, rawText: raw });
    expect(observe).toHaveBeenCalledWith({
      edits: [],
      reasons: ["verbatim"],
      effectiveLocale: null,
    });
    const otherLocale = runPunctuation(raw, explicitPolicy, {
      locale: { tag: "en-US-u-ca-gregory", source: "recognizer" },
    });
    expect(await otherLocale.result).toMatchObject({ text: raw });
    expect(otherLocale.observe).toHaveBeenCalledWith({
      edits: [],
      reasons: ["unsupported-locale"],
      effectiveLocale: "en-US",
    });
  });

  it("never observes grammar edits before finality or without opt-in", async () => {
    const interim = runPunctuation("hello", explicitPolicy, { isFinal: false });
    expect(await interim.result).toMatchObject({
      status: "unavailable",
      warnings: ["incomplete-transcript"],
    });
    expect(interim.observe).not.toHaveBeenCalled();
    const off = runPunctuation("hello", explicitPolicy, {
      featurePolicy: { enabled: false, processorIds: ["punctuation"] },
    });
    expect(await off.result).toMatchObject({
      status: "raw-fallback",
      text: "hello",
      warnings: ["disabled"],
    });
    expect(off.observe).not.toHaveBeenCalled();
  });
});
