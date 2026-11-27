import { randomUUID } from "node:crypto";
import {
  assertPersonalVocabularyScope,
  type PersonalVocabularyInput,
  type PersonalVocabularyScope,
} from "./personal-vocabulary-types.js";
import {
  comparisonKey,
  parseBoundedVocabularyJson,
  validateVocabularyTerms,
} from "./vocabulary-terms.js";
import {
  VOCABULARY_LIMITS,
  VocabularyError,
  type VocabularyErrorCode,
  type VocabularyTerm,
} from "./vocabulary-types.js";

type ValidImportRow = Readonly<{
  index: number;
  status: "new" | "exact-duplicate" | "conflict";
  term: VocabularyTerm;
  existingIds: readonly string[];
  otherRows: readonly number[];
  conflicts: readonly ("id" | "canonical")[];
}>;

export type PersonalVocabularyImportRow =
  | ValidImportRow
  | Readonly<{ index: number; status: "invalid"; code: VocabularyErrorCode }>;

/** Private preview of one already authorized scope; it performs no read or write itself. */
export type PersonalVocabularyImportPreview = Readonly<{
  scope: PersonalVocabularyScope;
  expectedRevision: number;
  existingTerms: readonly VocabularyTerm[];
  rows: readonly PersonalVocabularyImportRow[];
}>;

export type PersonalVocabularyImportChoice =
  | Readonly<{ index: number; action: "skip" | "add" }>
  | Readonly<{ index: number; action: "replace"; existingId: string }>;

/** Proposed atomic replacement only. Authority and an actual revision-checked write are absent. */
export type PersonalVocabularyReplacementProposal = Readonly<{
  scope: PersonalVocabularyScope;
  expectedRevision: number;
  terms: readonly VocabularyTerm[];
}>;

function assertTarget(target: PersonalVocabularyInput): void {
  if (!Number.isSafeInteger(target.revision) || target.revision < 0) {
    throw new VocabularyError("invalid-input");
  }
  if (target.terms.length > VOCABULARY_LIMITS.personalTerms) {
    throw new VocabularyError("limit-exceeded");
  }
}

function sameTerm(left: VocabularyTerm, right: VocabularyTerm): boolean {
  return (
    left.id === right.id &&
    left.canonical === right.canonical &&
    left.enabled === right.enabled &&
    left.aliases.length === right.aliases.length &&
    left.aliases.every((alias, index) => alias === right.aliases[index]) &&
    left.locales.length === right.locales.length &&
    left.locales.every((locale, index) => locale === right.locales[index])
  );
}

function appendIndex(index: Map<string, number[]>, key: string, row: number): void {
  const rows = index.get(key);
  if (rows) {
    rows.push(row);
  } else {
    index.set(key, [row]);
  }
}

/**
 * Inspect versioned bytes without silently merging duplicates or deciding conflicts.
 * The schema is a private proposal, not an activated storage or public import contract.
 */
export function previewPersonalVocabularyImport(
  text: string,
  target: PersonalVocabularyInput,
): PersonalVocabularyImportPreview {
  assertTarget(target);
  const parsed = parseBoundedVocabularyJson(text);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new VocabularyError("invalid-input");
  }
  // SAFETY: parsed JSON was checked above to be a non-null, non-array object.
  const value = parsed as Record<string, unknown>;
  if (!Number.isSafeInteger(value.schemaVersion)) {
    throw new VocabularyError("invalid-input");
  }
  if (value.schemaVersion !== VOCABULARY_LIMITS.schemaVersion) {
    throw new VocabularyError("unsupported-version");
  }
  if (Object.keys(value).some((key) => key !== "schemaVersion" && key !== "terms")) {
    throw new VocabularyError("invalid-input");
  }
  if (!Array.isArray(value.terms)) {
    throw new VocabularyError("invalid-input");
  }
  if (value.terms.length > VOCABULARY_LIMITS.personalTerms) {
    throw new VocabularyError("limit-exceeded");
  }
  const existingById = new Map(target.terms.map((term) => [term.id, term]));
  const existingByCanonical = new Map(
    target.terms.map((term) => [comparisonKey(term.canonical), term]),
  );
  const incomingIds = new Map<string, number[]>();
  const incomingCanonicals = new Map<string, number[]>();
  const admitted = Array.from(value.terms, (raw, index) => {
    try {
      const term = validateVocabularyTerms([raw], 1)[0]!;
      appendIndex(incomingIds, term.id, index);
      appendIndex(incomingCanonicals, comparisonKey(term.canonical), index);
      return { index, status: "valid" as const, term };
    } catch (error) {
      if (!(error instanceof VocabularyError)) {
        throw error;
      }
      return Object.freeze({ index, status: "invalid" as const, code: error.code });
    }
  });
  const rows = admitted.map((row): PersonalVocabularyImportRow => {
    if (row.status === "invalid") {
      return row;
    }
    const { term } = row;
    const canonical = comparisonKey(term.canonical);
    const existing = new Map<string, VocabularyTerm>();
    for (const match of [existingById.get(term.id), existingByCanonical.get(canonical)]) {
      if (match) {
        existing.set(match.id, match);
      }
    }
    const otherRows = [
      ...new Set([
        ...(incomingIds.get(term.id) ?? []),
        ...(incomingCanonicals.get(canonical) ?? []),
      ]),
    ]
      .filter((index) => index !== row.index)
      .toSorted((a, b) => a - b);
    const matches = [
      ...existing.values(),
      ...otherRows.map((index) => {
        const other = admitted[index]!;
        if (other.status === "invalid") {
          throw new VocabularyError("invalid-input");
        }
        return other.term;
      }),
    ];
    const different = matches.filter((match) => !sameTerm(term, match));
    const conflicts: ("id" | "canonical")[] = [];
    if (different.some((match) => match.id === term.id)) {
      conflicts.push("id");
    }
    if (different.some((match) => comparisonKey(match.canonical) === canonical)) {
      conflicts.push("canonical");
    }
    const hasPriorMatch = existing.size > 0 || otherRows.some((index) => index < row.index);
    return Object.freeze({
      index: row.index,
      status: different.length > 0 ? "conflict" : hasPriorMatch ? "exact-duplicate" : "new",
      term,
      existingIds: Object.freeze([...existing.keys()].toSorted()),
      otherRows: Object.freeze(otherRows),
      conflicts: Object.freeze(conflicts),
    });
  });
  return Object.freeze({
    scope: Object.freeze({
      profileId: target.scope.profileId,
      workspaceId: target.scope.workspaceId,
    }),
    expectedRevision: target.revision,
    existingTerms: target.terms,
    rows: Object.freeze(rows),
  });
}

/** Serialize only the personal term projection, and bound the entire versioned envelope. */
function serializePersonalTerms(terms: readonly VocabularyTerm[]): string {
  const text = JSON.stringify({
    schemaVersion: VOCABULARY_LIMITS.schemaVersion,
    terms: terms.map((term) => ({
      id: term.id,
      canonical: term.canonical,
      aliases: [...term.aliases],
      locales: [...term.locales],
      enabled: term.enabled,
    })),
  });
  if (Buffer.byteLength(text) > VOCABULARY_LIMITS.collectionBytes) {
    throw new VocabularyError("limit-exceeded");
  }
  return text;
}

/**
 * Every row needs an explicit choice. This returns proposed complete terms and expectedRevision;
 * it neither commits data nor proves that the revision is still current.
 */
export function resolvePersonalVocabularyImport(
  preview: PersonalVocabularyImportPreview,
  choices: readonly PersonalVocabularyImportChoice[],
): PersonalVocabularyReplacementProposal {
  if (choices.length !== preview.rows.length) {
    throw new VocabularyError("invalid-input");
  }
  const decisions = new Map<number, PersonalVocabularyImportChoice>();
  for (const choice of choices) {
    if (
      !Number.isSafeInteger(choice.index) ||
      choice.index < 0 ||
      choice.index >= preview.rows.length ||
      decisions.has(choice.index)
    ) {
      throw new VocabularyError("invalid-input");
    }
    decisions.set(choice.index, choice);
  }
  const replacements = new Map<string, VocabularyTerm>();
  const additions: VocabularyTerm[] = [];
  for (const row of preview.rows) {
    const choice = decisions.get(row.index)!;
    if (choice.action === "skip") {
      continue;
    }
    if (row.status === "invalid") {
      throw new VocabularyError("invalid-input");
    }
    if (choice.action === "add") {
      additions.push(row.term);
    } else if (choice.action === "replace") {
      // Replacement must be one of this row's previewed conflicts, not an unrelated entry.
      if (!row.existingIds.includes(choice.existingId) || replacements.has(choice.existingId)) {
        throw new VocabularyError("invalid-input");
      }
      replacements.set(choice.existingId, Object.freeze({ ...row.term, id: choice.existingId }));
    } else {
      throw new VocabularyError("invalid-input");
    }
  }
  const terms = validateVocabularyTerms(
    [...preview.existingTerms.map((term) => replacements.get(term.id) ?? term), ...additions],
    VOCABULARY_LIMITS.personalTerms,
  );
  // Successful proposals must also round-trip within the file limit, including the envelope.
  serializePersonalTerms(terms);
  return Object.freeze({ scope: preview.scope, expectedRevision: preview.expectedRevision, terms });
}

/** Explicit already-authorized scope only. Returns bytes; performs no file or network I/O. */
export function exportPersonalVocabulary(
  input: PersonalVocabularyInput,
  selectedScope: PersonalVocabularyScope,
): string {
  assertPersonalVocabularyScope(input.scope, selectedScope);
  assertTarget(input);
  return serializePersonalTerms(input.terms);
}

/**
 * Preview only explicit existing Deepgram keyterm strings. No configuration discovery, mining,
 * mutation, preference toggle, or provider dispatch occurs. Generated IDs belong to the preview.
 */
export function previewDeepgramVocabulary(
  keyterms: readonly string[],
  target: PersonalVocabularyInput,
): PersonalVocabularyImportPreview {
  if (!Array.isArray(keyterms)) {
    throw new VocabularyError("invalid-input");
  }
  if (keyterms.length > VOCABULARY_LIMITS.personalTerms) {
    throw new VocabularyError("limit-exceeded");
  }
  let bytes = 0;
  for (const keyterm of keyterms) {
    if (typeof keyterm !== "string") {
      throw new VocabularyError("invalid-input");
    }
    if (keyterm.length > VOCABULARY_LIMITS.collectionBytes) {
      throw new VocabularyError("limit-exceeded");
    }
    bytes += Buffer.byteLength(keyterm);
    if (bytes > VOCABULARY_LIMITS.collectionBytes) {
      throw new VocabularyError("limit-exceeded");
    }
  }
  return previewPersonalVocabularyImport(
    JSON.stringify({
      schemaVersion: VOCABULARY_LIMITS.schemaVersion,
      terms: keyterms.map((canonical) => ({ id: randomUUID(), canonical })),
    }),
    target,
  );
}
