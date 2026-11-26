import { describe, expect, it } from "vitest";
import { developerConformanceCases } from "./dictation-developer.test-support.ts";
import {
  builtinDeveloperProfiles,
  createDeveloperPlan,
  type DeveloperPlanRequest,
  type DeveloperProfile,
} from "./dictation-developer.ts";
import { applyDictationPlan, refineDictation } from "./dictation-refinement.ts";

const plain = builtinDeveloperProfiles[0]!;
function plan(rawTranscript: string, overrides: Partial<DeveloperPlanRequest> = {}) {
  return createDeveloperPlan({
    rawTranscript,
    mode: "developer",
    locale: "en-US",
    profile: plain,
    captureId: "synthetic-capture",
    generation: 3,
    transcriptRevision: 2,
    ...overrides,
  });
}

describe.each(builtinDeveloperProfiles)("$id exact fragment corpus", (profile) => {
  it.each(
    developerConformanceCases.filter((item) => !item.profileId || item.profileId === profile.id),
  )("preserves exact bytes: $source", ({ source, expected }) => {
    const result = plan(source, { profile });
    expect(result.diagnostics.filter((item) => item.severity === "blocking")).toEqual([]);
    expect(result.edits).toHaveLength(1);
    expect(new TextEncoder().encode(result.edits[0]!.text)).toEqual(
      new TextEncoder().encode(expected),
    );
    expect(result.edits[0]!.source).toBe(source);
  });
});

it("makes acronym preservation an explicit option", () => {
  const profile: DeveloperProfile = { ...plain, acronymPolicy: "preserve" };
  expect(plan("camel case get user by ID end identifier", { profile }).edits[0]?.text).toBe(
    "getUserByID",
  );
  expect(plan("snake case customer ID end identifier", { profile }).edits[0]?.text).toBe(
    "customer_ID",
  );
});

it("uses only straight profile quotes and explicit indentation", () => {
  const profile: DeveloperProfile = {
    ...plain,
    quoteStyle: "single",
    whitespace: { ...plain.whitespace, indentation: "\t" },
  };
  expect(
    plan("start code quote name quote new line indent end code", { profile }).edits[0]?.text,
  ).toBe("'name'\n\t");
});

it.each([
  "I said open paren to describe the button",
  '"snake case change my ID end identifier"',
  "`start code new line end code`",
  "“spell capital A end spell”",
  'value="hello start code new line end code"',
  "/a start code open paren x close paren end code b/",
  "use /a start code open paren x close paren end code b/ please",
  "r'hello start code new line end code world'",
  "b'hello snake case User ID end identifier world'",
  "f'''hello don't start code new line end code world'''",
  "x=r'hello start code new line end code world'",
])("keeps command mentions inert: %s", (source) => {
  expect(plan(source).edits).toEqual([]);
});

it("preserves baseline prose even for complete command phrases", () => {
  expect(plan("start code new line end code", { mode: "prose", locale: "ar" }).edits).toEqual([]);
});

it("allows only explicit symbols and spelling in Literal", () => {
  expect(plan("symbol new line end symbol", { mode: "literal" }).edits[0]?.text).toBe("\n");
  const result = plan("camel case customer ID end identifier", { mode: "literal" });
  expect(result.edits).toEqual([]);
  expect(result.diagnostics[0]?.code).toBe("unsupported");
});

it.each([
  "spell capital A",
  "start code x comma y",
  "snake case customer ID",
  "spell capital A lower end spell",
  "spell digit ten end spell",
  "spell capital ß end spell",
  "symbol unknown end symbol",
  "start code start code x end code end code",
  "start code literal words end code end literal",
])("does not invent completion: %s", (source) => {
  const result = plan(source);
  expect(result.edits).toEqual([]);
  expect(result.diagnostics.some((item) => item.severity === "blocking")).toBe(true);
});

it("requires an advertised alternative for ambiguous minus and dash", () => {
  const source = "start code x minus y end code";
  const pending = plan(source);
  expect(pending.edits).toEqual([]);
  expect(pending.diagnostics[0]).toMatchObject({
    id: "symbol:13",
    code: "ambiguous",
    severity: "blocking",
    alternatives: [{ text: "-" }, { text: "−" }],
  });
  expect(plan(source, { choices: { "symbol:13": "-" } }).edits[0]?.text).toBe("x - y");
  expect(plan(source, { choices: { "symbol:13": "; run()" } }).edits).toEqual([]);
  expect(plan("symbol dash end symbol").diagnostics[0]?.alternatives).toEqual([
    { label: "Hyphen-minus (-)", text: "-" },
    { label: "Em dash (—)", text: "—" },
  ]);
});

it.each([
  ["en-us-json", "start code open brace quote x quote colon end code", '{"x":'],
  ["en-us-typescript", "start code call open paren end code", "call("],
  ["en-us-python", "start code close bracket end code", "]"],
])("reports syntax uncertainty without repairing the %s fragment", (id, source, expected) => {
  const result = plan(source, {
    profile: builtinDeveloperProfiles.find((item) => item.id === id)!,
  });
  expect(result.edits[0]?.text).toBe(expected);
  expect(result.diagnostics[0]).toMatchObject({ code: "syntax", severity: "warning" });
});

it("returns UTF-16 source edits without splitting emoji, combining marks, or RTL prose", () => {
  const source = "🙂 e\u0301 مرحبا snake case User ID end identifier שלום";
  const result = plan(source);
  expect(result.edits).toEqual([
    {
      intentId: "syntax:12",
      start: 12,
      end: 45,
      source: "snake case User ID end identifier",
      text: "user_id",
    },
  ]);
  expect(result.protectedSpans.every((range) => range.end <= 12 || range.start >= 45)).toBe(true);
});

it("preserves static snippets before and after a separate command", () => {
  const source = "open paren | symbol new line end symbol | snake case";
  const result = plan(source, {
    protectedSpans: [
      { start: 0, end: 10 },
      { start: 42, end: 52 },
    ],
  });
  expect(result.edits.map((edit) => edit.text)).toEqual(["\n"]);
  expect(result.protectedSpans).toEqual([
    { start: 0, end: 12 },
    { start: 40, end: 52 },
  ]);
});

it("does not consume a protected snippet within a syntax command", () => {
  const source = "start code new line end code";
  const result = plan(source, { protectedSpans: [{ start: 11, end: 19 }] });
  expect(result.edits).toEqual([]);
  expect(result.diagnostics[0]?.code).toBe("invalid");
});

it.each([
  ["🙂 x", [{ start: 1, end: 2 }]],
  ["e\u0301 x", [{ start: 0, end: 1 }]],
  [
    "abcd",
    [
      { start: 0, end: 3 },
      { start: 2, end: 4 },
    ],
  ],
  ["abc", [{ start: -1, end: 2 }]],
] as const)("rejects invalid Unicode or overlapping source ranges", (source, protectedSpans) => {
  expect(plan(source, { protectedSpans }).diagnostics[0]?.code).toBe("invalid");
});

it("rejects malformed source Unicode and out-of-bound identities", () => {
  expect(plan("bad\ud800").diagnostics[0]?.code).toBe("invalid");
  expect(plan("safe", { generation: -1 }).diagnostics[0]?.code).toBe("invalid");
});

it("offers an explicit locale fallback without applying guessed rules", () => {
  const result = plan("start code new line end code", { locale: "fr-FR" });
  expect(result.supported).toBe(false);
  expect(result.edits).toEqual([]);
  expect(result.diagnostics[0]?.code).toBe("unsupported");
});

it("bounds candidates, edits and diagnostics, with long Literal content kept intact", () => {
  expect(plan("word ".repeat(4_001)).diagnostics[0]?.code).toBe("limit");
  expect(plan("x".repeat(131_073)).diagnostics[0]?.code).toBe("limit");
  expect(plan("symbol new line end symbol ".repeat(65)).diagnostics.at(-1)?.code).toBe("limit");
  expect(plan(`start code ${"minus ".repeat(100)}end code`).diagnostics).toHaveLength(64);
  const literal = "word ".repeat(1_000);
  expect(plan(literal, { mode: "literal" }).protectedSpans).toEqual([
    { start: 0, end: literal.length },
  ]);
});

it("composes confirmed syntax and unchanged literals without exposing either to prose cleanup", async () => {
  const rawTranscript = "um 🙂 C:\\AbC\\01 ".concat(
    "start code x minus y end code",
    " literal words open paren end literal",
  );
  const request = {
    schemaVersion: 1 as const,
    mode: "dictation" as const,
    rawTranscript,
    captureId: "synthetic-capture",
    generation: 3,
    transcriptRevision: 2,
  };
  const pending = plan(rawTranscript);
  expect(() => applyDictationPlan(request, pending)).toThrow();
  const confirmed = plan(rawTranscript, { choices: { "symbol:29": "-" } });
  const exact = applyDictationPlan(request, confirmed);
  expect(exact.text).toBe("um 🙂 C:\\AbC\\01 x - y open paren");
  const refined = await refineDictation(request, confirmed.edits, {
    signal: new AbortController().signal,
    protectedRanges: confirmed.protectedSpans,
    transformProse: async (pieces) => pieces.map((piece) => piece.replace("um ", "")),
  });
  expect(refined.text).toBe("🙂 C:\\AbC\\01 x - y open paren");
});

it("protects uppercase identifiers and all-letter hex hashes from unrelated style stages", async () => {
  const rawTranscript = "prose HTTP abcdefabcdefabcdef";
  const prepared = plan(rawTranscript);
  const result = await refineDictation(
    {
      schemaVersion: 1,
      captureId: "synthetic-capture",
      generation: 3,
      transcriptRevision: 2,
      mode: "dictation",
      rawTranscript,
    },
    prepared.edits,
    {
      signal: new AbortController().signal,
      protectedRanges: prepared.protectedSpans,
      transformProse: async (pieces) => pieces.map((piece) => piece.toUpperCase()),
    },
  );
  expect(result.text).toBe("PROSE HTTP abcdefabcdefabcdef");
});
