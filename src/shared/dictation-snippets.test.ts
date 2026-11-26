import { describe, expect, it, vi } from "vitest";
import { refineDictation, type DictationRefinementRequest } from "./dictation-refinement.js";
import {
  DictationSnippetIndex,
  initialSnippetIntents,
  selectSnippetIntent,
} from "./dictation-snippets.js";
import { validateVoiceSnippetCatalog, type VoiceSnippet } from "./voice-snippets.js";

const request = (rawTranscript: string): DictationRefinementRequest => ({
  schemaVersion: 1,
  captureId: "capture-one",
  generation: 3,
  transcriptRevision: 2,
  mode: "dictation",
  rawTranscript,
});
const snippet = (
  id: string,
  body = "Saved text",
  overrides: Partial<VoiceSnippet> = {},
): VoiceSnippet => ({
  schemaVersion: 1,
  id,
  revision: 1,
  name: id,
  locale: "en-US",
  triggers: [id],
  body,
  enabled: true,
  sensitivity: "normal",
  ...overrides,
});
const catalog = (...snippets: VoiceSnippet[]) =>
  validateVoiceSnippetCatalog({ schemaVersion: 1, revision: 4, enabled: true, snippets });
const signal = () => new AbortController().signal;
const inertBody =
  "00042\n\n{{name}} <date> $HOME $(exit)\r\nÉ🙂\ninsert snippet other\nhttps://example.com/?a=001";

describe("explicit static snippet recognition and composition", () => {
  it.each([
    "I told her to say insert snippet support",
    '"insert snippet support"',
    "‘insert snippet support’",
    "“Insert snippet support”",
    'insert snippet "support"',
    "insert snippet support\nthen continue",
  ])("leaves the whole prose or quotation unchanged: %s", async (text) => {
    const input = request(text);
    const saved = catalog(snippet("support"));
    const intents = initialSnippetIntents(input);
    expect(intents).toEqual([]);
    const resolved = new DictationSnippetIndex(saved).resolve(input, intents, saved);
    expect((await refineDictation(input, resolved.candidates, { signal: signal() })).text).toBe(
      text,
    );
  });

  it("expands a whole explicit phrase with case and whitespace normalization into inert bytes", async () => {
    const input = request("  Insert   snippet SUPPORT  ");
    const saved = catalog(snippet("support", inertBody));
    const { candidates, problems } = new DictationSnippetIndex(saved).resolve(
      input,
      initialSnippetIntents(input),
      saved,
    );
    expect(problems).toEqual([]);
    expect(candidates).toHaveLength(1);
    const result = await refineDictation(input, candidates, { signal: signal() });
    expect(result.text).toBe(inertBody);
    expect(result.protectedSpans[0]).toMatchObject({
      snippetId: "support",
      snippetRevision: 1,
      catalogRevision: 4,
    });
    expect(
      result.protectedSpans.map((span) => result.text.slice(span.outputStart, span.outputEnd)),
    ).toEqual([inertBody]);
  });

  it("requires a deliberate selected segment in literal code mode and never accepts agent mode", () => {
    const input = request("insert snippet support");
    const saved = catalog(snippet("support"));
    expect(initialSnippetIntents(input, true)).toEqual([]);
    const selected = selectSnippetIntent(input, [], 0, input.rawTranscript.length);
    expect(
      new DictationSnippetIndex(saved).resolve(input, selected, saved).candidates,
    ).toHaveLength(1);
    const agentInput = { ...input, mode: "agent" as const };
    expect(initialSnippetIntents(agentInput)).toEqual([]);
    expect(
      new DictationSnippetIndex(saved).resolve(agentInput, selected, saved).candidates,
    ).toEqual([]);
  });

  it("treats a literal escape as text, including an unknown name", () => {
    const input = request("Literal insert snippet unknown");
    const saved = catalog(snippet("support"));
    const resolved = new DictationSnippetIndex(saved).resolve(
      input,
      initialSnippetIntents(input),
      saved,
    );
    expect(resolved.candidates).toEqual([]);
    expect(resolved.problems).toEqual([]);
    expect(resolved.literalEdits.map((edit) => edit.text)).toEqual(["insert snippet unknown"]);
    const spaced = request("  Literal insert snippet unknown  ");
    const escaped = new DictationSnippetIndex(saved).resolve(
      spaced,
      initialSnippetIntents(spaced),
      saved,
    );
    expect(escaped.literalEdits.map((edit) => edit.text)).toEqual(["  insert snippet unknown  "]);
  });

  it("replaces an unknown whole interpretation with deliberate mixed command ranges", async () => {
    const first = "insert snippet first";
    const second = "insert snippet second";
    const input = request(`${first} and then ${second} at the end`);
    const saved = catalog(snippet("first", "001\n<date>"), snippet("second", "002 {{name}}"));
    const index = new DictationSnippetIndex(saved);
    const automatic = initialSnippetIntents(input);
    expect(index.resolve(input, automatic, saved)).toMatchObject({
      candidates: [],
      problems: [{ code: "unknown" }],
    });
    let selected = selectSnippetIntent(input, automatic, 0, first.length);
    const secondStart = input.rawTranscript.indexOf(second);
    selected = selectSnippetIntent(input, selected, secondStart, secondStart + second.length);
    expect(selected).toHaveLength(2);
    expect(selected.every((intent) => intent.selected)).toBe(true);
    expect(() => selectSnippetIntent(input, selected, 0, input.rawTranscript.length)).toThrow(
      "invalid-selection",
    );
    const resolved = index.resolve(input, selected, saved);
    expect(resolved.problems).toEqual([]);
    const result = await refineDictation(input, resolved.candidates, { signal: signal() });
    expect(result.text).toBe("001\n<date> and then 002 {{name}} at the end");
    expect(
      result.protectedSpans.map((span) => result.text.slice(span.outputStart, span.outputEnd)),
    ).toEqual(["001\n<date>", "002 {{name}}"]);
  });

  it.each<[string, (text: string) => string]>([
    ["style", (text: string) => text.toUpperCase()],
    ["fillers/punctuation", (text: string) => text.replaceAll("um ", "").replaceAll(".", "!")],
    ["developer syntax", (text: string) => text.replaceAll("slash", "/").replaceAll(" ", "_")],
  ])(
    "protects two bodies from a single batched %s transform and keeps source order",
    async (_, transform) => {
      const first = "insert snippet first";
      const second = "insert snippet second";
      const input = request(`🙂 um Intro. ${first}\nslash Middle. ${second}\nEnd.`);
      const saved = catalog(
        snippet("first", inertBody),
        snippet("second", "um slash 0007.\n\n<name>"),
      );
      let intents = selectSnippetIntent(
        input,
        [],
        input.rawTranscript.indexOf(second),
        input.rawTranscript.indexOf(second) + second.length,
      );
      const start = input.rawTranscript.indexOf(first);
      intents = selectSnippetIntent(input, intents, start, start + first.length);
      intents = selectSnippetIntent(input, intents, start, start + first.length);
      expect(intents).toHaveLength(2);
      const { candidates } = new DictationSnippetIndex(saved).resolve(input, intents, saved);
      const transformProse = vi.fn(async (prose: readonly string[]) => prose.map(transform));
      const result = await refineDictation(input, candidates, { signal: signal(), transformProse });
      expect(transformProse).toHaveBeenCalledTimes(1);
      expect(transformProse.mock.calls[0]?.[0]).toEqual([
        "🙂 um Intro. ",
        "\nslash Middle. ",
        "\nEnd.",
      ]);
      expect(result.text).toBe(
        transform("🙂 um Intro. ") +
          inertBody +
          transform("\nslash Middle. ") +
          "um slash 0007.\n\n<name>" +
          transform("\nEnd."),
      );
      expect(
        result.protectedSpans.map((span) => result.text.slice(span.outputStart, span.outputEnd)),
      ).toEqual([inertBody, "um slash 0007.\n\n<name>"]);
    },
  );

  it("requires an explicit collision choice across locales and bounds the offered choices", () => {
    const saved = catalog(
      ...["en", "de", "fr", "es", "it", "pt", "nl", "sv", "da", "no", "fi"].map((locale) =>
        snippet(locale, locale, { locale, triggers: ["support"] }),
      ),
    );
    const input = request("insert snippet support");
    const intents = initialSnippetIntents(input);
    const index = new DictationSnippetIndex(saved);
    const ambiguous = index.resolve(input, intents, saved);
    expect(ambiguous.candidates).toEqual([]);
    expect(ambiguous.problems[0]?.code).toBe("collision");
    expect(ambiguous.problems[0]?.choices).toHaveLength(10);
    const choice = new Map([[intents[0]!.id, "fr"]]);
    expect(
      index.resolve(input, intents, saved, choice).candidates.map((item) => item.text),
    ).toEqual(["fr"]);
    expect(
      index.resolve(input, intents, saved, new Map([[intents[0]!.id, "missing"]])).candidates,
    ).toEqual([]);
  });

  it.each(["cafe", "café", "café!", "café."])(
    "keeps accents and punctuation distinct for %s",
    (trigger) => {
      const saved = catalog(
        ...["cafe", "café", "café!", "café."].map((name, i) =>
          snippet(`item-${i}`, name, { triggers: [name] }),
        ),
      );
      const input = request(`insert snippet ${trigger}`);
      expect(
        new DictationSnippetIndex(saved)
          .resolve(input, initialSnippetIntents(input), saved)
          .candidates.map((item) => item.text),
      ).toEqual([trigger]);
    },
  );

  it.each(["unknown", "disabled"])("reports %s without substituting a different body", (name) => {
    const saved = catalog(snippet("disabled", "Never insert", { enabled: false }));
    const input = request(`insert snippet ${name}`);
    const resolved = new DictationSnippetIndex(saved).resolve(
      input,
      initialSnippetIntents(input),
      saved,
    );
    expect(resolved.candidates).toEqual([]);
    expect(resolved.problems.map((problem) => problem.code)).toEqual([name]);
  });

  it("rejects changed, disabled, deleted, or same-name replacement catalog entries", () => {
    const original = catalog(snippet("support"));
    const input = request("insert snippet support");
    const index = new DictationSnippetIndex(original);
    const changed = [
      { ...original, revision: 5 },
      { ...original, enabled: false },
      { ...original, snippets: [] },
      catalog(snippet("support", "Edited", { revision: 2 })),
      catalog(snippet("support", "Saved text", { enabled: false })),
      catalog(snippet("replacement", "Replacement", { name: "support", triggers: ["support"] })),
    ];
    for (const current of changed) {
      const result = index.resolve(input, initialSnippetIntents(input), current);
      expect(result.candidates).toEqual([]);
      expect(result.problems.map((problem) => problem.code)).toEqual(["stale-catalog"]);
    }
  });

  it("allows exactly 64 KiB of successful expansion and reports the fifth body over the cap", async () => {
    const body = "🙂".repeat(4096);
    const saved = catalog(snippet("support", body));
    const phrase = "insert snippet support";
    const input = request(Array(5).fill(phrase).join("\n"));
    let intents: ReturnType<typeof initialSnippetIntents> = [];
    for (let i = 0; i < 5; i++) {
      const start = i * (phrase.length + 1);
      intents = selectSnippetIntent(input, intents, start, start + phrase.length);
    }
    const result = new DictationSnippetIndex(saved).resolve(input, intents, saved);
    expect(result.candidates).toHaveLength(4);
    expect(result.problems.map((problem) => problem.code)).toEqual(["limit"]);
    const composed = await refineDictation(input, result.candidates, { signal: signal() });
    expect(composed.text).toBe(Array(4).fill(body).join("\n") + `\n${phrase}`);
    expect(composed.protectedSpans).toHaveLength(4);
  });

  it("cancels a late transform before publication and rejects malformed transform output", async () => {
    const controller = new AbortController();
    await expect(
      refineDictation(request("draft"), [], {
        signal: controller.signal,
        transformProse: async () => {
          controller.abort();
          return ["late result"];
        },
      }),
    ).rejects.toThrow("cancelled");
    await expect(
      refineDictation(request("draft"), [], {
        signal: signal(),
        transformProse: async () => [],
      }),
    ).rejects.toThrow("invalid-transform");
  });

  it("rejects invalid neutral versions, revisions, and ranges splitting a grapheme", async () => {
    const input = request("👩‍💻 insert snippet support");
    const invalidRequests = [
      { ...input, generation: -1 },
      { ...input, transcriptRevision: 0.5 },
      { ...input, captureId: "" },
    ];
    for (const invalid of invalidRequests) {
      await expect(refineDictation(invalid, [], { signal: signal() })).rejects.toThrow();
    }
    await expect(
      refineDictation(
        {
          ...input,
          // @ts-expect-error Unsupported wire version is deliberate malformed input.
          schemaVersion: 2,
        },
        [],
        { signal: signal() },
      ),
    ).rejects.toThrow();
    for (const end of [1, 2, 3]) {
      await expect(
        refineDictation(
          input,
          [
            {
              intentId: "split",
              start: 0,
              end,
              source: input.rawTranscript.slice(0, end),
              text: "Replacement",
            },
          ],
          { signal: signal() },
        ),
      ).rejects.toThrow();
      expect(() => selectSnippetIntent(input, [], 0, end)).toThrow("invalid-selection");
    }
  });

  it("preserves raw dictation while the feature is disabled", async () => {
    const saved = { ...catalog(snippet("support")), enabled: false };
    for (const text of [
      "insert snippet support",
      "literal insert snippet support",
      "ordinary draft",
    ]) {
      const input = request(text);
      const result = new DictationSnippetIndex(saved).resolve(
        input,
        initialSnippetIntents(input),
        saved,
      );
      expect(result.candidates).toEqual([]);
      expect(result.literalEdits).toEqual([]);
      expect((await refineDictation(input, result.candidates, { signal: signal() })).text).toBe(
        text,
      );
    }
  });
});
