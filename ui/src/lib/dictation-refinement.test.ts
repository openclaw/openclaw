import { describe, expect, it } from "vitest";
import {
  refineDictation,
  validateDictationEdits,
  type DictationRefinementRequest,
  type DictationSourceEdit,
} from "./dictation-refinement.js";

function request(
  rawTranscript: string,
  overrides: Partial<DictationRefinementRequest> = {},
): DictationRefinementRequest {
  return {
    schemaVersion: 1,
    captureId: "capture-a",
    generation: 3,
    transcriptRevision: 7,
    rawTranscript,
    isFinal: true,
    policy: { mode: "automatic", locale: "en-US", explicitEnabled: false },
    context: { left: "", right: "" },
    ...overrides,
  };
}

function candidate(input: DictationRefinementRequest, text: string, edits: readonly unknown[]) {
  return {
    schemaVersion: 1,
    policyVersion: 1,
    captureId: input.captureId,
    generation: input.generation,
    transcriptRevision: input.transcriptRevision,
    text,
    edits,
  };
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
    ).toMatchObject({ text: raw, edits: [], status: "raw-fallback", reasons: ["verbatim"] });
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
      status: "refined",
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

  it("accepts an independently authored map and binds the result to the raw revision", () => {
    expect(validateDictationEdits(input, candidate(input, "Hello.", edits))).toMatchObject({
      schemaVersion: 1,
      policyVersion: 1,
      captureId: "capture-a",
      generation: 3,
      transcriptRevision: 7,
      text: "Hello.",
      status: "refined",
      edits,
    });
  });

  it.each([
    [{ captureId: "another-capture" }, "revision-mismatch"],
    [{ generation: 4 }, "revision-mismatch"],
    [{ transcriptRevision: 8 }, "revision-mismatch"],
    [{ policyVersion: 2 }, "unsupported-version"],
    [{ schemaVersion: 2 }, "unsupported-version"],
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
      validateDictationEdits(input, { ...candidate(input, "Hello.", edits), ...patch }),
    ).toMatchObject({ text: "hello", status: "needs-review", edits: [], reasons: [reason] });
  });

  it.each([null, [], {}, { text: "hello", edits: null }].map((value) => ({ value })))(
    "rejects malformed result %#",
    ({ value }) => {
      expect(validateDictationEdits(input, value)).toMatchObject({
        text: "hello",
        status: "needs-review",
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
        candidate(source, raw, [{ start, end, text, reason: "sentence-case" }]),
      ),
    ).toMatchObject({ text: raw, edits: [], reasons: ["invalid-edit-map"] });
  });

  it("rejects punctuation that changes meaning even when every lexical word survives", () => {
    const source = request("I do not authorize the transfer");
    expect(
      validateDictationEdits(
        source,
        candidate(source, "I do. not authorize the transfer", [
          { start: 4, end: 4, text: ".", reason: "punctuation-insert" },
        ]),
      ),
    ).toMatchObject({ text: source.rawTranscript, reasons: ["unapproved-edit"] });
    const contraction = request("we can't proceed");
    expect(
      validateDictationEdits(
        contraction,
        candidate(contraction, "we cant proceed", [
          { start: 6, end: 7, text: "", reason: "punctuation-remove" },
        ]),
      ),
    ).toMatchObject({ text: contraction.rawTranscript, reasons: ["protected-text"] });
  });

  it("bounds work by UTF-8 bytes and declines incomplete or malformed recognition", () => {
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
    expect(refineDictation(request("still speaking", { isFinal: false }))).toMatchObject({
      text: "still speaking",
      status: "unavailable",
      reasons: ["incomplete-transcript"],
    });
    expect(refineDictation(request("bad \uD800"))).toMatchObject({
      text: "bad \uD800",
      reasons: ["invalid-request"],
    });
  });
});
