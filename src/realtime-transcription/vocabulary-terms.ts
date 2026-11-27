import {
  VOCABULARY_LIMITS,
  VocabularyError,
  type EffectiveVocabulary,
  type EffectiveVocabularyTerm,
  type VocabularyCollection,
  type VocabularyCollectionDraft,
  type VocabularyConflict,
  type VocabularyHintCapability,
  type VocabularyHints,
  type VocabularySource,
  type VocabularyTerm,
} from "./vocabulary-types.js";

const MAX_LOCALES = 16;
const MAX_IMPORT_DEPTH = 6;
const compareText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const comparisonKey = (value: string) => value.normalize("NFC");

function record(input: unknown, fields: readonly string[]): Record<string, unknown> {
  if (
    !input ||
    typeof input !== "object" ||
    (Object.getPrototypeOf(input) !== Object.prototype && Object.getPrototypeOf(input) !== null)
  ) {
    throw new VocabularyError("invalid-input");
  }
  for (const key of Reflect.ownKeys(input)) {
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (typeof key !== "string" || !fields.includes(key) || descriptor?.get || descriptor?.set) {
      throw new VocabularyError("invalid-input");
    }
  }
  // SAFETY: input is a plain object whose own keys are all checked string data fields.
  return input as Record<string, unknown>;
}

function boundedText(input: unknown, maxBytes: number): string {
  if (typeof input !== "string") {
    throw new VocabularyError("invalid-input");
  }
  if (input.length > maxBytes || Buffer.byteLength(input) > maxBytes) {
    throw new VocabularyError("limit-exceeded");
  }
  if (!input.trim() || /[\p{Cc}\p{Cs}]/u.test(input)) {
    throw new VocabularyError("invalid-input");
  }
  return input;
}

function canonicalLocale(input: unknown): string {
  const locale = boundedText(input, 64);
  try {
    return Intl.getCanonicalLocales(locale)[0]!;
  } catch {
    throw new VocabularyError("invalid-input");
  }
}

function stringList(input: unknown, maximum: number, normalize: (value: unknown) => string) {
  if (input === undefined) {
    return Object.freeze<string>([]);
  }
  if (!Array.isArray(input)) {
    throw new VocabularyError("invalid-input");
  }
  if (input.length > maximum) {
    throw new VocabularyError("limit-exceeded");
  }
  const result = Array.from(input, normalize);
  if (new Set(result.map(comparisonKey)).size !== result.length) {
    throw new VocabularyError("invalid-input");
  }
  return Object.freeze(result.toSorted(compareText));
}

/** Validate once at import/edit admission; strings remain data, never replacement instructions. */
export function validateVocabularyTerms(
  input: unknown,
  maxTerms: number = VOCABULARY_LIMITS.collectionTerms,
): readonly VocabularyTerm[] {
  if (!Array.isArray(input) || !Number.isSafeInteger(maxTerms) || maxTerms < 0) {
    throw new VocabularyError("invalid-input");
  }
  if (input.length > Math.min(maxTerms, VOCABULARY_LIMITS.collectionTerms)) {
    throw new VocabularyError("limit-exceeded");
  }
  const terms: VocabularyTerm[] = [];
  const ids = new Set<string>();
  const canonicalKeys = new Set<string>();
  let bytes = 2;
  for (const value of input) {
    const item = record(value, ["id", "canonical", "aliases", "locales", "enabled"]);
    const id = boundedText(item.id, 128);
    if (!/^[A-Za-z0-9_-]+$/u.test(id) || ids.has(id)) {
      throw new VocabularyError("invalid-input");
    }
    const canonical = boundedText(item.canonical, VOCABULARY_LIMITS.termBytes);
    const key = comparisonKey(canonical);
    const aliases = stringList(item.aliases, VOCABULARY_LIMITS.aliases, (alias) =>
      boundedText(alias, VOCABULARY_LIMITS.termBytes),
    );
    if (canonicalKeys.has(key) || aliases.some((alias) => comparisonKey(alias) === key)) {
      throw new VocabularyError("invalid-input");
    }
    if (item.enabled !== undefined && typeof item.enabled !== "boolean") {
      throw new VocabularyError("invalid-input");
    }
    const term = Object.freeze({
      id,
      canonical,
      aliases,
      locales: stringList(item.locales, MAX_LOCALES, canonicalLocale),
      enabled: item.enabled !== false,
    });
    bytes += Buffer.byteLength(JSON.stringify(term)) + (terms.length ? 1 : 0);
    if (bytes > VOCABULARY_LIMITS.collectionBytes) {
      throw new VocabularyError("limit-exceeded");
    }
    ids.add(id);
    canonicalKeys.add(key);
    terms.push(term);
  }
  return Object.freeze(terms);
}

export function validateVocabularyDraft(input: unknown): VocabularyCollectionDraft {
  const value = record(input, ["schemaVersion", "label", "terms"]);
  if (!Number.isSafeInteger(value.schemaVersion)) {
    throw new VocabularyError("invalid-input");
  }
  if (value.schemaVersion !== VOCABULARY_LIMITS.schemaVersion) {
    throw new VocabularyError("unsupported-version");
  }
  const draft = Object.freeze({
    schemaVersion: VOCABULARY_LIMITS.schemaVersion,
    label: boundedText(value.label, VOCABULARY_LIMITS.labelBytes),
    terms: validateVocabularyTerms(value.terms),
  });
  if (Buffer.byteLength(JSON.stringify(draft)) > VOCABULARY_LIMITS.collectionBytes) {
    throw new VocabularyError("limit-exceeded");
  }
  return draft;
}

/** Bound raw bytes and nesting before JSON.parse can allocate the imported object graph. */
export function parseVocabularyImport(text: string): VocabularyCollectionDraft {
  if (typeof text !== "string") {
    throw new VocabularyError("invalid-input");
  }
  if (
    text.length > VOCABULARY_LIMITS.collectionBytes ||
    Buffer.byteLength(text) > VOCABULARY_LIMITS.collectionBytes
  ) {
    throw new VocabularyError("limit-exceeded");
  }
  let depth = 0;
  let quoted = false;
  let escaped = false;
  // Only ASCII JSON structure matters here; avoid per-code-point iteration over payloads.
  for (let offset = 0; offset < text.length; offset += 1) {
    const char = text.charCodeAt(offset);
    if (quoted) {
      if (escaped) {
        escaped = false;
      } else if (char === 92) {
        escaped = true;
      } else if (char === 34) {
        quoted = false;
      }
    } else if (char === 34) {
      quoted = true;
    } else if (char === 123 || char === 91) {
      if (++depth > MAX_IMPORT_DEPTH) {
        throw new VocabularyError("limit-exceeded");
      }
    } else if (char === 125 || char === 93) {
      depth--;
    }
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new VocabularyError("invalid-input");
  }
  return validateVocabularyDraft(parsed);
}

type Candidate = { term: VocabularyTerm; source: VocabularySource; priority: number; key: string };
const sourceKey = (source: VocabularySource) => JSON.stringify(source);
const compareCandidate = (a: Candidate, b: Candidate) =>
  a.priority - b.priority ||
  compareText(sourceKey(a.source), sourceKey(b.source)) ||
  compareText(a.term.id, b.term.id) ||
  compareText(a.term.canonical, b.term.canonical);

function mergeStrings(lists: readonly (readonly string[])[]): readonly string[] {
  const values = new Map<string, string>();
  for (const list of lists) {
    for (const value of list) {
      const key = comparisonKey(value);
      const previous = values.get(key);
      if (previous === undefined || compareText(value, previous) < 0) {
        values.set(key, value);
      }
    }
  }
  return Object.freeze([...values.values()].toSorted(compareText));
}

/** Inputs are already validated and authorized by their owners. This function grants no access. */
export function resolveEffectiveVocabulary(params: {
  sessionTerms?: readonly VocabularyTerm[];
  personalTerms?: readonly VocabularyTerm[];
  personalRevision: number;
  collections: readonly (VocabularyCollection & { deleted: false })[];
  locale?: string;
}): EffectiveVocabulary {
  if (!Number.isSafeInteger(params.personalRevision) || params.personalRevision < 0) {
    throw new VocabularyError("invalid-input");
  }
  if (
    params.collections.length > VOCABULARY_LIMITS.selectedCollections ||
    (params.personalTerms?.length ?? 0) > VOCABULARY_LIMITS.personalTerms
  ) {
    throw new VocabularyError("limit-exceeded");
  }
  const locale = params.locale === undefined ? undefined : canonicalLocale(params.locale);
  const groups: { terms: readonly VocabularyTerm[]; source: VocabularySource; priority: number }[] =
    [
      { terms: params.sessionTerms ?? [], source: Object.freeze({ kind: "session" }), priority: 0 },
      {
        terms: params.personalTerms ?? [],
        source: Object.freeze({ kind: "personal", revision: params.personalRevision }),
        priority: 1,
      },
      ...params.collections.map((collection) => ({
        terms: collection.terms,
        source: Object.freeze({
          kind: "shared" as const,
          scopeId: collection.scopeId,
          collectionId: collection.collectionId,
          revision: collection.revision,
        }),
        priority: 2,
      })),
    ];
  const count = groups.reduce((sum, group) => sum + group.terms.length, 0);
  if (count > VOCABULARY_LIMITS.collectionTerms) {
    throw new VocabularyError("limit-exceeded");
  }
  let bytes = 2 + Math.max(0, count - 1);
  const admitted: Candidate[] = [];
  const canonicalPriority = new Map<string, number>();
  for (const group of groups) {
    for (const term of group.terms) {
      bytes += Buffer.byteLength(JSON.stringify(term));
      if (bytes > VOCABULARY_LIMITS.collectionBytes) {
        throw new VocabularyError("limit-exceeded");
      }
      // Unknown utterance locale permits neutral entries only; never guess a language.
      if (
        !term.enabled ||
        (term.locales.length &&
          !term.locales.some((tag) => locale === tag || locale?.startsWith(`${tag}-`)))
      ) {
        continue;
      }
      const candidate = {
        term,
        source: group.source,
        priority: group.priority,
        key: comparisonKey(term.canonical),
      };
      admitted.push(candidate);
      canonicalPriority.set(
        candidate.key,
        Math.min(candidate.priority, canonicalPriority.get(candidate.key) ?? candidate.priority),
      );
    }
  }
  // A shadowed canonical term must not suppress an unrelated hint through its aliases.
  const candidates = admitted.filter(
    (candidate) => candidate.priority === canonicalPriority.get(candidate.key),
  );
  const aliases = new Map<string, Candidate[]>();
  for (const candidate of candidates) {
    for (const alias of new Set([candidate.key, ...candidate.term.aliases.map(comparisonKey)])) {
      const matching = aliases.get(alias);
      if (matching) {
        matching.push(candidate);
      } else {
        aliases.set(alias, [candidate]);
      }
    }
  }
  const excludedAtPriority = new Map<string, number>();
  const conflicts: VocabularyConflict[] = [];
  for (const [alias, matching] of [...aliases].toSorted(([a], [b]) => compareText(a, b))) {
    if (matching.length === 1) {
      continue;
    }
    const priority = Math.min(...matching.map((candidate) => candidate.priority));
    const preferred = matching.filter((candidate) => candidate.priority === priority);
    const keys = new Set(preferred.map((candidate) => candidate.key));
    if (keys.size > 1) {
      conflicts.push(
        Object.freeze({
          alias,
          candidates: Object.freeze(
            preferred
              .toSorted(compareCandidate)
              .map((candidate) =>
                Object.freeze({ canonical: candidate.term.canonical, source: candidate.source }),
              ),
          ),
        }),
      );
    }
    for (const candidate of matching) {
      // Canonical-only hints cannot represent an alias exception: omit the whole losing term.
      if (keys.size > 1 || !keys.has(candidate.key)) {
        excludedAtPriority.set(
          candidate.key,
          Math.min(candidate.priority, excludedAtPriority.get(candidate.key) ?? candidate.priority),
        );
      }
    }
  }
  const byCanonical = new Map<string, Candidate[]>();
  for (const candidate of candidates) {
    // A duplicate source must not reintroduce the same ambiguous canonical hint.
    if (candidate.priority >= (excludedAtPriority.get(candidate.key) ?? 3)) {
      continue;
    }
    const matching = byCanonical.get(candidate.key);
    if (matching) {
      matching.push(candidate);
    } else {
      byCanonical.set(candidate.key, [candidate]);
    }
  }
  const entries: EffectiveVocabularyTerm[] = [...byCanonical.values()]
    .map((matching) => matching.toSorted(compareCandidate))
    .toSorted((a, b) => a[0]!.priority - b[0]!.priority || compareText(a[0]!.key, b[0]!.key))
    .map((matching) => {
      const first = matching[0]!;
      if (matching.length === 1) {
        // Admission already produced immutable terms; no duplicate aliases need merging.
        return Object.freeze({ term: first.term, sources: Object.freeze([first.source]) });
      }
      const preferred = matching.filter((candidate) => candidate.priority === first.priority);
      const sources = new Map(
        preferred.map((candidate) => [sourceKey(candidate.source), candidate.source]),
      );
      // This derived projection may unite several import records. Its lists are bounded
      // by the aggregate input budget, not a single record's sixteen-alias limit.
      // Lower-priority shared aliases never add behavior to a personal/session override.
      return Object.freeze({
        term: Object.freeze({
          ...first.term,
          aliases: mergeStrings(preferred.map((candidate) => candidate.term.aliases)),
          locales: preferred.some((candidate) => !candidate.term.locales.length)
            ? Object.freeze<string>([])
            : mergeStrings(preferred.map((candidate) => candidate.term.locales)),
        }),
        sources: Object.freeze([...sources.values()]),
      });
    });
  return Object.freeze({ entries: Object.freeze(entries), conflicts: Object.freeze(conflicts) });
}

/** Exact measurement belongs to a qualified adapter; no provider is inferred from a name. */
export function selectVocabularyHints(
  effective: EffectiveVocabulary,
  capability: VocabularyHintCapability,
): VocabularyHints {
  const empty = Object.freeze<string>([]);
  if (capability.kind === "unsupported") {
    return Object.freeze({
      status: "unsupported",
      terms: empty,
      omitted: effective.entries.length,
      bytes: 0,
      tokens: 0,
    });
  }
  if (
    ![capability.maxTerms, capability.maxBytes, capability.maxTokens].every(
      (limit) => Number.isSafeInteger(limit) && limit >= 0,
    )
  ) {
    throw new VocabularyError("invalid-input");
  }
  const candidates = effective.entries.map((entry) => entry.term.canonical);
  let selected = { terms: empty, bytes: 0, tokens: 0 };
  let low = 0;
  let high = Math.min(candidates.length, capability.maxTerms);
  let length = high;
  while (length > low) {
    const terms = Object.freeze(candidates.slice(0, length));
    let measured: { bytes: number; tokens: number };
    try {
      measured = capability.measure(terms);
    } catch {
      throw new VocabularyError("unavailable");
    }
    if (
      ![measured.bytes, measured.tokens].every((size) => Number.isSafeInteger(size) && size >= 0)
    ) {
      throw new VocabularyError("invalid-input");
    }
    if (measured.bytes <= capability.maxBytes && measured.tokens <= capability.maxTokens) {
      selected = { terms, bytes: measured.bytes, tokens: measured.tokens };
      low = length;
    } else {
      high = length - 1;
    }
    // Logarithmically bounded prefix probes; the final prefix is measured, not token-estimated.
    // Nonmonotonic tokenizers may omit more entries; maximal quota filling is not promised.
    length = Math.ceil((low + high) / 2);
  }
  const omitted = candidates.length - selected.terms.length;
  // An empty result means omit the hint field entirely, not a serialized empty list.
  return Object.freeze({ status: omitted ? "truncated" : "supported", ...selected, omitted });
}
