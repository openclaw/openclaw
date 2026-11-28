import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  REFINEMENT_LIMITS,
  RefinementError,
  type AuthorizedRefinementEdit,
  type ProtectedSpan,
  type RefinementEdit,
  type RefinementRequest,
  type RefinementSnapshot,
} from "./types.js";

const encoder = new TextEncoder();
const segmenter = new Intl.Segmenter("en", { granularity: "grapheme" });

export function refinementByteLength(value: string): number {
  return encoder.encode(value).byteLength;
}

function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!isRecord(value) || Object.keys(value).some((key) => !keys.includes(key))) {
    throw new RefinementError("invalid-request");
  }
  return value;
}

function finite(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new RefinementError("invalid-request");
  }
  return value;
}

function revision(value: unknown): number {
  const number = finite(value);
  if (!Number.isSafeInteger(number)) {
    throw new RefinementError("invalid-request");
  }
  return number;
}

function choice<const T extends readonly string[]>(value: unknown, choices: T): T[number] {
  if (typeof value !== "string" || !choices.includes(value)) {
    throw new RefinementError("invalid-request");
  }
  return value;
}

function text(value: unknown, limit: number, empty = true): string {
  if (typeof value !== "string" || (!empty && !value.length)) {
    throw new RefinementError("invalid-request");
  }
  // Check code units before encoding so an unbounded input is never copied to a byte buffer.
  if (value.length > limit || refinementByteLength(value) > limit) {
    throw new RefinementError("payload-limit");
  }
  for (let i = 0; i < value.length; i++) {
    const unit = value.charCodeAt(i);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(++i);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        throw new RefinementError("invalid-range");
      }
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      throw new RefinementError("invalid-range");
    }
  }
  return value;
}

function id(value: unknown): string {
  return text(value, 256, false);
}

function array(value: unknown, max: number): unknown[] {
  if (!Array.isArray(value)) {
    throw new RefinementError("invalid-request");
  }
  if (value.length > max) {
    throw new RefinementError("payload-limit");
  }
  return value;
}

function ids(value: unknown, max: number): readonly string[] {
  const result = array(value, max).map(id);
  if (new Set(result).size !== result.length) {
    throw new RefinementError("invalid-request");
  }
  return result;
}

export function freezeRefinementValue<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) {
      freezeRefinementValue(child);
    }
    Object.freeze(value);
  }
  return value;
}

function boundaries(value: string): Set<number> {
  return new Set([0, value.length, ...Array.from(segmenter.segment(value), (part) => part.index)]);
}

function range(value: Record<string, unknown>, base: string, edges: Set<number>): RefinementEdit {
  const start = revision(value.start);
  const end = revision(value.end);
  if (end < start || end > base.length || !edges.has(start) || !edges.has(end)) {
    throw new RefinementError("invalid-range");
  }
  return { start, end, text: text(value.text, REFINEMENT_LIMITS.outputBytes) };
}

function protection(value: unknown): Pick<ProtectedSpan, "kind" | "identity"> {
  const item = record(value, ["kind", "identity"]);
  const kind = choice(item.kind, ["literal", "snippet", "reference"]);
  const identity = item.identity === undefined ? undefined : id(item.identity);
  if (kind === "reference" && !identity) {
    throw new RefinementError("invalid-request");
  }
  return { kind, ...(identity ? { identity } : {}) };
}

function protectedSpans(value: unknown, base: string): readonly ProtectedSpan[] {
  const entries = array(value, REFINEMENT_LIMITS.spans);
  if (!entries.length) {
    return [];
  }
  const edges = boundaries(base);
  const spans = entries.map((entry) => {
    const item = record(entry, ["start", "end", "kind", "identity"]);
    const start = revision(item.start);
    const end = revision(item.end);
    if (start >= end || end > base.length || !edges.has(start) || !edges.has(end)) {
      throw new RefinementError("invalid-range");
    }
    return Object.assign({ start, end }, protection({ kind: item.kind, identity: item.identity }));
  });
  spans.sort((a, b) => a.start - b.start);
  for (let i = 1; i < spans.length; i++) {
    if (spans[i]!.start < spans[i - 1]!.end) {
      throw new RefinementError("invalid-range");
    }
  }
  return spans;
}

function snapshots(value: unknown, byteLimit: number): readonly RefinementSnapshot[] {
  let bytes = 0;
  const result = array(value, REFINEMENT_LIMITS.snapshots).map((entry) => {
    const item = record(entry, [
      "id",
      "revision",
      "source",
      "authorizationId",
      "expiresAt",
      "text",
    ]);
    const content = text(item.text, byteLimit);
    bytes += refinementByteLength(content);
    if (bytes > byteLimit) {
      throw new RefinementError("payload-limit");
    }
    return {
      id: id(item.id),
      revision: revision(item.revision),
      source: id(item.source),
      authorizationId: id(item.authorizationId),
      expiresAt: finite(item.expiresAt),
      text: content,
    };
  });
  if (new Set(result.map((item) => item.id)).size !== result.length) {
    throw new RefinementError("invalid-request");
  }
  return result;
}

/** Validate and own one bounded immutable snapshot at admission, not once per stage. */
export function validateRefinementRequest(value: unknown): RefinementRequest {
  const item = record(value, [
    "schemaVersion",
    "offsetUnit",
    "captureId",
    "generation",
    "transcriptRevision",
    "rawTranscript",
    "isFinal",
    "mode",
    "locale",
    "target",
    "scope",
    "transcriptProvenance",
    "contextSnapshots",
    "vocabularySnapshots",
    "protectedSpans",
    "authorizedEdits",
    "featurePolicy",
    "providerPolicy",
    "deadlineAt",
  ]);
  if (item.schemaVersion !== 1) {
    throw new RefinementError("unsupported-schema");
  }
  if (item.offsetUnit !== "utf16" || typeof item.isFinal !== "boolean") {
    throw new RefinementError("invalid-request");
  }
  const rawTranscript = text(item.rawTranscript, REFINEMENT_LIMITS.transcriptBytes);
  const locale = record(item.locale, ["tag", "source"]);
  const localeTag = text(locale.tag, 64, false);
  try {
    Intl.getCanonicalLocales(localeTag);
  } catch {
    throw new RefinementError("invalid-request");
  }
  const target = record(item.target, ["id", "revision", "draftRevision"]);
  const scope = record(item.scope, [
    "connectionId",
    "connectionGeneration",
    "accountId",
    "authorizationRevision",
    "policyRevision",
  ]);
  const provenance = record(item.transcriptProvenance, [
    "authorizationRevision",
    "hintSnapshotIds",
  ]);
  const features = record(item.featurePolicy, ["enabled", "processorIds"]);
  const provider = record(item.providerPolicy, ["routeId", "locality"]);
  if (typeof features.enabled !== "boolean") {
    throw new RefinementError("invalid-request");
  }
  const edges = boundaries(rawTranscript);
  const authorizedEdits: AuthorizedRefinementEdit[] = array(
    item.authorizedEdits,
    REFINEMENT_LIMITS.edits,
  ).map((entry) => {
    const edit = record(entry, ["start", "end", "text", "intentId", "kind", "protection"]);
    const kind = choice(edit.kind, ["correction", "expansion", "reference", "literal"]);
    const protectedEdit = edit.protection === undefined ? undefined : protection(edit.protection);
    if (
      (kind === "reference" && protectedEdit?.kind !== "reference") ||
      (kind === "expansion" && protectedEdit?.kind !== "snippet") ||
      (kind === "literal" && protectedEdit?.kind !== "literal")
    ) {
      throw new RefinementError("invalid-request");
    }
    return Object.assign(range(edit, rawTranscript, edges), {
      intentId: id(edit.intentId),
      kind,
      ...(protectedEdit ? { protection: protectedEdit } : {}),
    });
  });
  if (new Set(authorizedEdits.map((edit) => edit.intentId)).size !== authorizedEdits.length) {
    throw new RefinementError("invalid-request");
  }
  const result: RefinementRequest = {
    schemaVersion: 1,
    offsetUnit: "utf16",
    captureId: id(item.captureId),
    generation: revision(item.generation),
    transcriptRevision: revision(item.transcriptRevision),
    rawTranscript,
    isFinal: item.isFinal,
    mode: choice(item.mode, ["dictation", "literal", "developer"]),
    locale: { tag: localeTag, source: choice(locale.source, ["user", "recognizer", "default"]) },
    target: {
      id: id(target.id),
      revision: revision(target.revision),
      draftRevision: revision(target.draftRevision),
    },
    scope: {
      connectionId: id(scope.connectionId),
      connectionGeneration: revision(scope.connectionGeneration),
      accountId: id(scope.accountId),
      authorizationRevision: revision(scope.authorizationRevision),
      policyRevision: revision(scope.policyRevision),
    },
    transcriptProvenance: {
      authorizationRevision: revision(provenance.authorizationRevision),
      hintSnapshotIds: ids(provenance.hintSnapshotIds, REFINEMENT_LIMITS.snapshots * 2),
    },
    contextSnapshots: snapshots(item.contextSnapshots, REFINEMENT_LIMITS.contextBytes),
    vocabularySnapshots: snapshots(item.vocabularySnapshots, REFINEMENT_LIMITS.vocabularyBytes),
    protectedSpans: protectedSpans(item.protectedSpans, rawTranscript),
    authorizedEdits,
    featurePolicy: {
      enabled: features.enabled,
      processorIds: ids(features.processorIds, REFINEMENT_LIMITS.processors),
    },
    providerPolicy: {
      routeId: provider.routeId === null ? null : id(provider.routeId),
      locality: choice(provider.locality, ["strict-local", "selected"]),
    },
    deadlineAt: finite(item.deadlineAt),
  };
  const snapshotIds = [...result.contextSnapshots, ...result.vocabularySnapshots].map(
    (snapshot) => snapshot.id,
  );
  if (new Set(snapshotIds).size !== snapshotIds.length) {
    throw new RefinementError("invalid-request");
  }
  if (refinementByteLength(JSON.stringify(result)) > REFINEMENT_LIMITS.payloadBytes) {
    throw new RefinementError("payload-limit");
  }
  // Validate the exact-base intent set before either deterministic work or egress.
  applyRefinementEdits(rawTranscript, authorizedEdits, result.protectedSpans);
  return freezeRefinementValue(result);
}

export function applyRefinementEdits(
  base: string,
  edits: readonly RefinementEdit[],
  spans: readonly ProtectedSpan[],
): { text: string; protectedSpans: readonly ProtectedSpan[] } {
  if (!edits.length) {
    return { text: text(base, REFINEMENT_LIMITS.outputBytes), protectedSpans: spans };
  }
  const ordered = edits.toSorted((a, b) => a.start - b.start || a.end - b.end);
  const edges = boundaries(base);
  let prior: RefinementEdit | undefined;
  let outputLength = base.length;
  for (const edit of ordered) {
    range(edit, base, edges);
    if (prior && (edit.start < prior.end || edit.start === prior.start)) {
      throw new RefinementError("invalid-range");
    }
    if (
      spans.some(
        (span) =>
          (edit.start < span.end && edit.end > span.start) ||
          (edit.start === edit.end && edit.start > span.start && edit.start < span.end),
      )
    ) {
      throw new RefinementError("protected-content");
    }
    outputLength += edit.text.length - (edit.end - edit.start);
    if (outputLength > REFINEMENT_LIMITS.outputBytes) {
      throw new RefinementError("payload-limit");
    }
    prior = edit;
  }
  const chunks: string[] = [];
  let cursor = 0;
  for (const edit of ordered) {
    chunks.push(base.slice(cursor, edit.start), edit.text);
    cursor = edit.end;
  }
  chunks.push(base.slice(cursor));
  const output = text(chunks.join(""), REFINEMENT_LIMITS.outputBytes);
  const outputEdges = boundaries(output);
  const mapped = spans.map((span) => {
    const offset = ordered.reduce(
      (total, edit) =>
        total + (edit.end <= span.start ? edit.text.length - (edit.end - edit.start) : 0),
      0,
    );
    const next = { ...span, start: span.start + offset, end: span.end + offset };
    if (!outputEdges.has(next.start) || !outputEdges.has(next.end)) {
      throw new RefinementError("protected-content");
    }
    return next;
  });
  return { text: output, protectedSpans: mapped };
}

function occurrences(value: string, literal: string): number[] {
  const positions: number[] = [];
  for (let from = 0; from <= value.length - literal.length;) {
    const position = value.indexOf(literal, from);
    if (position < 0) {
      break;
    }
    positions.push(position);
    from = position + 1;
  }
  return positions;
}

export function validateRefinementCandidate(
  value: unknown,
  base: Readonly<{ text: string; revision: number; protectedSpans: readonly ProtectedSpan[] }>,
): { text: string; protectedSpans: readonly ProtectedSpan[]; needsReview: boolean } {
  try {
    const candidate = record(value, [
      "schemaVersion",
      "offsetUnit",
      "baseRevision",
      "kind",
      "text",
      "edits",
    ]);
    if (candidate.schemaVersion !== 1) {
      throw new RefinementError("unsupported-schema");
    }
    if (candidate.offsetUnit !== "utf16") {
      throw new RefinementError("invalid-candidate");
    }
    if (revision(candidate.baseRevision) !== base.revision) {
      throw new RefinementError("wrong-base");
    }
    let output: { text: string; protectedSpans: readonly ProtectedSpan[] };
    if (candidate.kind === "edits" && candidate.text === undefined) {
      const entries = array(candidate.edits, REFINEMENT_LIMITS.edits);
      const edges = entries.length ? boundaries(base.text) : undefined;
      const edits = edges
        ? entries.map((entry) => range(record(entry, ["start", "end", "text"]), base.text, edges))
        : [];
      output = applyRefinementEdits(base.text, edits, base.protectedSpans);
    } else if (candidate.kind === "text" && candidate.edits === undefined) {
      const replacement = text(candidate.text, REFINEMENT_LIMITS.outputBytes);
      const outputEdges = boundaries(replacement);
      let lastEnd = 0;
      const mapped = base.protectedSpans.map((span) => {
        const literal = base.text.slice(span.start, span.end);
        const before = occurrences(base.text, literal);
        const after = occurrences(replacement, literal);
        const ordinal = before.indexOf(span.start);
        const start = after[ordinal];
        if (
          ordinal < 0 ||
          before.length !== after.length ||
          start === undefined ||
          start < lastEnd ||
          !outputEdges.has(start) ||
          !outputEdges.has(start + literal.length)
        ) {
          throw new RefinementError("protected-content");
        }
        lastEnd = start + literal.length;
        return { ...span, start, end: lastEnd };
      });
      output = { text: replacement, protectedSpans: mapped };
    } else {
      throw new RefinementError("invalid-candidate");
    }
    // Only outer whitespace can change automatically. Interior indentation, case,
    // punctuation, names, quantities, units and negation require explicit review.
    // This conservative check does not prove semantic equivalence.
    const needsReview = base.text.trim() !== output.text.trim();
    return { ...output, needsReview };
  } catch (error) {
    if (error instanceof RefinementError && error.code !== "invalid-request") {
      throw error;
    }
    throw new RefinementError("invalid-candidate");
  }
}
