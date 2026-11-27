import { describe, expect, it, vi } from "vitest";
import {
  applyDictationPlan,
  convertDictationOffset,
  refineDictation,
  type DictationEditPlan,
  type DictationRefinementRequest,
} from "./dictation-refinement.ts";

const request = (rawTranscript: string): DictationRefinementRequest => ({
  schemaVersion: 1,
  captureId: "capture-1",
  generation: 2,
  transcriptRevision: 3,
  mode: "dictation",
  rawTranscript,
});

function plan(raw = "hello symbol new line end symbol"): DictationEditPlan {
  return {
    schemaVersion: 1,
    offsetEncoding: "utf-16",
    captureId: "capture-1",
    generation: 2,
    transcriptRevision: 3,
    profileId: "plain-code",
    profileRevision: 1,
    supported: true,
    edits: [{ intentId: "code", start: 6, end: raw.length, source: raw.slice(6), text: "\n" }],
    protectedSpans: [],
    diagnostics: [],
  };
}

describe("shared dictation composition", () => {
  it("keeps explicit terminal whitespace and binds the result to the capture", () => {
    expect(applyDictationPlan(request("hello symbol new line end symbol"), plan())).toMatchObject({
      text: "hello \n",
      captureId: "capture-1",
      generation: 2,
      transcriptRevision: 3,
      profileId: "plain-code",
      profileRevision: 1,
      protectedSpans: [{ outputStart: 6, outputEnd: 7, text: "\n" }],
    });
  });

  it("offers only prose to cleanup and preserves code, existing tokens and static snippets", async () => {
    const raw = "um 🙂 code then snippet and C:\\Team\\API_v01";
    const codeStart = raw.indexOf("code");
    const snippetStart = raw.indexOf("snippet");
    const pathStart = raw.indexOf("C:");
    const cleanup = vi.fn(async (prose: readonly string[]) =>
      prose.map((part) => part.replace("um ", "").toUpperCase()),
    );
    const result = await refineDictation(
      request(raw),
      [
        {
          intentId: "m08",
          start: codeStart,
          end: codeStart + 4,
          source: "code",
          text: "apiID != 001",
        },
        {
          intentId: "m07",
          start: snippetStart,
          end: snippetStart + 7,
          source: "snippet",
          text: "// open paren\n\t" + String.raw`\n`,
          snippetId: "static-1",
          snippetRevision: 4,
          catalogRevision: 5,
        },
      ],
      {
        signal: new AbortController().signal,
        protectedRanges: [{ start: pathStart, end: raw.length }],
        transformProse: cleanup,
      },
    );
    expect(cleanup.mock.calls[0]?.[0]).toEqual(["um 🙂 ", " then ", " and ", ""]);
    expect(result.text).toBe("🙂 apiID != 001 THEN // open paren\n\t\\n AND C:\\Team\\API_v01");
    for (const span of result.protectedSpans) {
      expect(result.text.slice(span.outputStart, span.outputEnd)).toBe(span.text);
    }
  });

  it.each([
    ["generation", { generation: 8 }],
    ["capture", { captureId: "other" }],
    ["transcript", { transcriptRevision: 8 }],
    ["encoding", { offsetEncoding: "utf-8" }],
    ["unsupported", { supported: false }],
    ["ambiguity", { diagnostics: [{ severity: "blocking" }] }],
  ])("rejects a %s mismatch before any candidate is published", (_name, mutation) => {
    const invalid = { ...plan(), ...mutation } as DictationEditPlan;
    expect(() =>
      applyDictationPlan(request("hello symbol new line end symbol"), invalid),
    ).toThrow();
  });

  it("rejects overlap, incorrect source, and attempted replacement of a protected literal", () => {
    const raw = "hello symbol new line end symbol";
    const candidate = plan();
    expect(() =>
      applyDictationPlan(request(raw), {
        ...candidate,
        edits: [...candidate.edits, ...candidate.edits],
      }),
    ).toThrow();
    expect(() =>
      applyDictationPlan(request(raw), {
        ...candidate,
        edits: [{ ...candidate.edits[0]!, source: "other" }],
      }),
    ).toThrow();
    expect(() =>
      applyDictationPlan(request(raw), { ...candidate, protectedSpans: [{ start: 6, end: 12 }] }),
    ).toThrow();
  });

  it("allows syntax warnings without adding a missing bracket", () => {
    const candidate = plan();
    candidate.edits = [{ ...candidate.edits[0]!, text: "foo(" }];
    candidate.diagnostics = [{ severity: "warning" }];
    expect(applyDictationPlan(request("hello symbol new line end symbol"), candidate).text).toBe(
      "hello foo(",
    );
  });

  it("rejects a literal that joins a neighboring output grapheme without changing its bytes", async () => {
    const input = request("eMARK");
    const edits = [{ intentId: "mark", start: 1, end: 5, source: "MARK", text: "\u0301" }];
    await expect(
      refineDictation(input, edits, { signal: new AbortController().signal }),
    ).rejects.toThrow("dictation-output-boundary");
    expect(() => applyDictationPlan(input, { ...plan(), edits })).toThrow(
      "dictation-output-boundary",
    );
  });

  it("rejects late prose output on cancellation", async () => {
    const abort = new AbortController();
    await expect(
      refineDictation(request("hello"), [], {
        signal: abort.signal,
        transformProse: async () => {
          abort.abort();
          return ["changed"];
        },
      }),
    ).rejects.toThrow();
  });

  it("retains admitted source and literal bytes while an asynchronous stage runs", async () => {
    const source = request("code prose");
    const candidate = { intentId: "code", start: 0, end: 4, source: "code", text: "001" };
    const result = await refineDictation(source, [candidate], {
      signal: new AbortController().signal,
      transformProse: async () => {
        candidate.text = "bad";
        source.captureId = "other";
        return ["", " done"];
      },
    });
    expect(result).toMatchObject({ captureId: "capture-1", text: "001 done" });
  });

  it.each([[], ["a", "b"], ["x".repeat(128 * 1024 + 1)], ["\ud800"]])(
    "rejects malformed, oversized or ill-formed stage output",
    async (...output) => {
      await expect(
        refineDictation(request("hi"), [], {
          signal: new AbortController().signal,
          transformProse: async () => output,
        }),
      ).rejects.toThrow();
    },
  );
});

describe("explicit editor offset conversion", () => {
  const text = "🙂e\u0301 עברית";
  it("converts byte, scalar and UTF-16 offsets at grapheme boundaries", () => {
    expect(convertDictationOffset(text, 4, "utf-8", "utf-16")).toBe(2);
    expect(convertDictationOffset(text, 4, "utf-16", "utf-8")).toBe(7);
    expect(convertDictationOffset(text, 3, "code-point", "utf-16")).toBe(4);
    expect(convertDictationOffset(text, 0, "utf-16", "utf-8")).toBe(0);
  });
  it.each([
    [1, "utf-16"],
    [1, "utf-8"],
    [3, "utf-16"],
    [2, "code-point"],
    [999, "utf-8"],
  ] as const)("rejects a split grapheme or invalid offset %s %s", (offset, from) =>
    expect(() => convertDictationOffset(text, offset, from, "utf-16")).toThrow(),
  );
});
