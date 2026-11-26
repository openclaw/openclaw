import type {
  DictationLiteralCandidate,
  DictationRefinementRequest,
} from "./dictation-refinement.js";
import {
  normalizeVoiceSnippetTrigger,
  VOICE_SNIPPET_BODY_BYTES,
  VOICE_SNIPPET_CAPTURE_BYTES,
  VOICE_SNIPPET_COUNT,
  voiceSnippetUtf8Bytes,
  type VoiceSnippet,
  type VoiceSnippetCatalog,
} from "./voice-snippets.js";

export type SnippetIntent = { id: string; start: number; end: number; selected: boolean };
export type SnippetProblem = {
  intentId: string;
  code: "unknown" | "disabled" | "collision" | "stale-catalog" | "limit";
  choices: Array<{ id: string; name: string }>;
};

/** English invocation grammar; trigger aliases retain their own locale and punctuation. */
export function recognizeSnippetPhrase(
  text: string,
): { trigger: string; literal: boolean; literalText: string } | null {
  const match = /^(literal\s+)?insert\s+snippet\s+([^\r\n]+)$/iu.exec(text.trim());
  if (!match || !match[2]?.trim() || /["“”«»]/u.test(match[2])) {
    return null;
  }
  return {
    trigger: match[2].trim(),
    literal: Boolean(match[1]),
    literalText: text.replace(/^(\s*)literal\s+/iu, "$1"),
  };
}

/** A finalized capture is the automatic boundary. Embedded phrases require explicit selection. */
export function initialSnippetIntents(
  request: DictationRefinementRequest,
  literalCode = false,
): SnippetIntent[] {
  if (
    request.mode !== "dictation" ||
    literalCode ||
    !recognizeSnippetPhrase(request.rawTranscript)
  ) {
    return [];
  }
  return [
    {
      id: `${request.captureId}:whole`,
      start: 0,
      end: request.rawTranscript.length,
      selected: false,
    },
  ];
}

export function selectSnippetIntent(
  request: DictationRefinementRequest,
  intents: readonly SnippetIntent[],
  start: number,
  end: number,
): SnippetIntent[] {
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start < 0 ||
    end <= start ||
    end > request.rawTranscript.length
  ) {
    throw new Error("invalid-selection");
  }
  const boundaries = new Set([0, request.rawTranscript.length]);
  for (const segment of new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(
    request.rawTranscript,
  )) {
    boundaries.add(segment.index);
  }
  if (
    !boundaries.has(start) ||
    !boundaries.has(end) ||
    !recognizeSnippetPhrase(request.rawTranscript.slice(start, end))
  ) {
    throw new Error("invalid-selection");
  }
  // A deliberate segment supersedes an overlapping automatic whole-capture interpretation.
  // Explicit segments cannot overlap each other; selecting the same range remains idempotent.
  const retained = intents.filter(
    (intent) =>
      !(intent.start === start && intent.end === end) &&
      (intent.selected || start >= intent.end || end <= intent.start),
  );
  if (
    retained.some((intent) => start < intent.end && end > intent.start) ||
    retained.length >= 64
  ) {
    throw new Error("invalid-selection");
  }
  return [
    ...retained,
    { id: `${request.captureId}:${start}:${end}`, start, end, selected: true },
  ].toSorted((a, b) => a.start - b.start);
}

/** Immutable catalog index lives for this capture only, never in provider context. */
export class DictationSnippetIndex {
  private readonly locales = new Map<string, Map<string, VoiceSnippet[]>>();

  constructor(readonly catalog: VoiceSnippetCatalog) {
    if (catalog.snippets.length > VOICE_SNIPPET_COUNT) {
      throw new Error("limit");
    }
    for (const snippet of catalog.snippets) {
      let names = this.locales.get(snippet.locale);
      if (!names) {
        names = new Map();
        this.locales.set(snippet.locale, names);
      }
      for (const trigger of snippet.triggers) {
        const key = normalizeVoiceSnippetTrigger(trigger, snippet.locale);
        const values = names.get(key) ?? [];
        if (!values.some((value) => value.id === snippet.id)) {
          values.push(snippet);
        }
        names.set(key, values);
      }
    }
  }

  resolve(
    request: DictationRefinementRequest,
    intents: readonly SnippetIntent[],
    current: VoiceSnippetCatalog,
    choices: ReadonlyMap<string, string> = new Map(),
  ): {
    candidates: DictationLiteralCandidate[];
    problems: SnippetProblem[];
    literalEdits: Array<{ start: number; end: number; text: string }>;
  } {
    const candidates: DictationLiteralCandidate[] = [];
    const problems: SnippetProblem[] = [];
    const literalEdits: Array<{ start: number; end: number; text: string }> = [];
    if (!this.catalog.enabled || request.mode !== "dictation") {
      return { candidates, problems, literalEdits };
    }
    const currentById = new Map(current.snippets.map((snippet) => [snippet.id, snippet]));
    let total = 0;
    for (const intent of intents) {
      const source = request.rawTranscript.slice(intent.start, intent.end);
      const phrase = recognizeSnippetPhrase(source);
      if (!phrase) {
        continue;
      }
      if (!current.enabled || current.revision !== this.catalog.revision) {
        problems.push({ intentId: intent.id, code: "stale-catalog", choices: [] });
        continue;
      }
      if (phrase.literal) {
        literalEdits.push({ start: intent.start, end: intent.end, text: phrase.literalText });
        continue;
      }
      const matches = [...this.locales].flatMap(
        ([locale, names]) => names.get(normalizeVoiceSnippetTrigger(phrase.trigger, locale)) ?? [],
      );
      const enabled = matches.filter((snippet) => snippet.enabled);
      const problem = (code: SnippetProblem["code"], available: VoiceSnippet[] = []) => {
        problems.push({
          intentId: intent.id,
          code,
          choices: available.slice(0, 10).map(({ id, name }) => ({ id, name })),
        });
      };
      if (!enabled.length) {
        problem(matches.length ? "disabled" : "unknown");
        continue;
      }
      const selected = choices.get(intent.id);
      const snippet =
        enabled.length === 1 ? enabled[0] : enabled.find((item) => item.id === selected);
      if (!snippet) {
        problem("collision", enabled);
        continue;
      }
      const latest = currentById.get(snippet.id);
      if (
        !latest?.enabled ||
        latest.revision !== snippet.revision ||
        latest.body !== snippet.body
      ) {
        problem("stale-catalog");
        continue;
      }
      const length = voiceSnippetUtf8Bytes(snippet.body);
      total += length;
      if (length > VOICE_SNIPPET_BODY_BYTES || total > VOICE_SNIPPET_CAPTURE_BYTES) {
        problem("limit");
        continue;
      }
      candidates.push({
        intentId: intent.id,
        start: intent.start,
        end: intent.end,
        source,
        text: snippet.body,
        catalogRevision: this.catalog.revision,
        snippetId: snippet.id,
        snippetRevision: snippet.revision,
      });
    }
    return { candidates, problems, literalEdits };
  }
}
