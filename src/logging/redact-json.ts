import { expectDefined } from "@openclaw/normalization-core";
import {
  applyRedactionEdits,
  mergeRedactionEdits,
  composeRedactionEdits,
  rebaseRedactionEdits,
  type RedactionEdit,
} from "./redact-edit-composition.js";
import {
  readBatchTokens,
  readScalarTokens,
  type ScalarToken,
  type EncodedEdit,
  type RedactionOrigins,
  type RedactionField,
} from "./redact-json-tokens.js";
import {
  iterateRedactMatches,
  type RedactMatch,
  type ResolvedRedactPattern,
} from "./redact-pattern-runtime.js";

export type { RedactionField, RedactionOrigins } from "./redact-json-tokens.js";

export type RedactionTarget = {
  start: number;
  end: number;
  value: string;
};
export type RedactionEditSelector = (
  match: RedactMatch,
  pattern: ResolvedRedactPattern,
  project: (start: number, end: number) => RedactionTarget | undefined,
) => RedactionEdit | undefined;

export function getPatternRedactionEdits(
  value: string,
  pattern: ResolvedRedactPattern,
  getEdit: RedactionEditSelector,
): RedactionEdit[] {
  const edits: RedactionEdit[] = [];
  for (const match of iterateRedactMatches(value, pattern)) {
    const edit = getEdit(match, pattern, (start, end) => ({
      start,
      end,
      value: value.slice(start, end),
    }));
    if (edit && edit.end >= edit.start) {
      edits.push(edit);
    }
  }
  return edits;
}

export type RedactionMessage = {
  text: string;
  contentLength: number;
  finish: (text: string) => string;
  parts: {
    key: string;
    json: boolean;
    messageField: boolean;
    start: number;
    primitiveLength?: number;
  }[];
};

function stringBoundaries(text: string, token: ScalarToken): Map<number, number> {
  const boundaries = new Map<number, number>();
  let decoded = 0;
  for (let offset = token.start + 1; offset < token.end - 1; decoded += 1) {
    boundaries.set(offset, decoded);
    offset += text[offset] === "\\" ? (text[offset + 1] === "u" ? 6 : 2) : 1;
  }
  boundaries.set(token.end - 1, decoded);
  return boundaries;
}

function decodedBoundary(text: string, token: ScalarToken, offset: number): number | undefined {
  if (!token.escaped) {
    return offset - token.start - 1;
  }
  token.boundaries ??= stringBoundaries(text, token);
  return token.boundaries.get(offset);
}

function encodedBoundary(text: string, token: ScalarToken, offset: number): number {
  if (!token.escaped) {
    return token.start + 1 + offset;
  }
  if (!token.encodedBoundaries) {
    token.boundaries ??= stringBoundaries(text, token);
    token.encodedBoundaries = [];
    for (const [encoded, decoded] of token.boundaries) {
      token.encodedBoundaries[decoded] = encoded;
    }
  }
  return expectDefined(token.encodedBoundaries[offset], "decoded JSON edit boundary");
}

type ProjectedEdit = RedactionEdit & { scalar: boolean };

function projectMessageEdits(
  input: string,
  tokens: ScalarToken[],
  message: RedactionMessage,
  getEdits: (token: ScalarToken) => RedactionEdit[],
): ProjectedEdit[] {
  const parts = new Map(message.parts.map((part) => [part.key, part]));
  const projected: ProjectedEdit[] = [];
  for (const token of tokens) {
    if (!token.isKey && token.path.length === 1 && token.key === "message") {
      continue;
    }
    const part = token.rootKey === undefined ? undefined : parts.get(token.rootKey);
    if (!part) {
      continue;
    }
    if (
      !part.json &&
      (token.isKey ||
        (part.messageField
          ? token.path.length !== 2 || token.key !== "message"
          : token.path.length !== 1))
    ) {
      continue;
    }
    const edits = getEdits(token);
    for (const edit of edits) {
      let start: number;
      let end: number;
      let replacement = edit.replacement;
      if (part.json) {
        const base = part.start - expectDefined(token.rootValueStart, "displayed JSON argument");
        if (token.string) {
          start = base + encodedBoundary(input, token, edit.start);
          end = base + encodedBoundary(input, token, edit.end);
          replacement = JSON.stringify(replacement).slice(1, -1);
        } else {
          start = base + token.start;
          end = base + token.end;
          replacement = JSON.stringify(replacement);
        }
      } else {
        start = part.start + edit.start;
        end = part.start + (part.primitiveLength ?? edit.end);
      }
      if (start < message.contentLength) {
        projected.push({
          start,
          end: Math.min(end, message.contentLength),
          replacement,
          scalar: part.json && !token.string,
        });
      }
    }
  }
  return projected.toSorted((left, right) => left.start - right.start || left.end - right.end);
}

function firstIntersectingToken(tokens: ScalarToken[], start: number): number {
  let low = 0;
  let high = tokens.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (expectDefined(tokens[middle], "bounded JSON token search").currentEnd <= start) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  return low;
}

function updateCurrentToken(input: string, token: ScalarToken): void {
  if (token.raw || token.deferEncoding) {
    token.currentRaw = token.currentValue;
    return;
  }
  const parts: string[] = [];
  const encodedEdits: EncodedEdit[] = [];
  let cursor = token.start + (token.string ? 1 : 0);
  let encodedLength = 0;
  let decodedShift = 0;
  for (const edit of token.edits) {
    const start = token.string
      ? encodedBoundary(input, token, edit.start)
      : token.start + edit.start;
    const end = token.string ? encodedBoundary(input, token, edit.end) : token.start + edit.end;
    const replacement = JSON.stringify(edit.replacement).slice(1, -1);
    const encodedStart = encodedLength + start - cursor;
    const encodedEnd = encodedStart + replacement.length;
    encodedEdits.push({
      start: encodedStart,
      end: encodedEnd,
      decodedStart: edit.start + decodedShift,
      decodedEnd: edit.start + decodedShift + edit.replacement.length,
      sourceEnd: end,
      sourceDecodedEnd: edit.end,
      replacement,
    });
    parts.push(input.slice(cursor, start), replacement);
    encodedLength = encodedEnd;
    decodedShift += edit.replacement.length - (edit.end - edit.start);
    cursor = end;
  }
  parts.push(input.slice(cursor, token.end - (token.string ? 1 : 0)));
  token.currentRaw = `"${parts.join("")}"`;
  token.encodedEdits = encodedEdits;
}

function currentDecodedBoundary(
  input: string,
  token: ScalarToken,
  position: number,
  replacements: Map<string, Map<number, number>>,
): number | undefined {
  const offset = position - token.currentStart - 1;
  const edits = token.encodedEdits;
  if (!edits) {
    return decodedBoundary(input, token, token.start + 1 + offset);
  }
  let low = 0;
  let high = edits.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (expectDefined(edits[middle], "current encoded edit").end < offset) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  const edit = edits[low];
  if (edit && offset >= edit.start) {
    const within = offset - edit.start;
    if (!edit.replacement.includes("\\")) {
      return edit.decodedStart + within;
    }
    let boundaries = replacements.get(edit.replacement);
    if (!boundaries) {
      boundaries = new Map();
      let decoded = 0;
      for (let encoded = 0; encoded < edit.replacement.length; decoded += 1) {
        boundaries.set(encoded, decoded);
        encoded +=
          edit.replacement[encoded] === "\\" ? (edit.replacement[encoded + 1] === "u" ? 6 : 2) : 1;
      }
      boundaries.set(edit.replacement.length, decoded);
      replacements.set(edit.replacement, boundaries);
    }
    const decoded = boundaries.get(within);
    return decoded === undefined ? undefined : edit.decodedStart + decoded;
  }
  const previous = edits[low - 1];
  const original = offset + (previous ? previous.sourceEnd - previous.end : token.start + 1);
  const decoded = decodedBoundary(input, token, original);
  return decoded === undefined
    ? undefined
    : decoded + (previous ? previous.decodedEnd - previous.sourceDecodedEnd : 0);
}

function commitPatternEdits(token: ScalarToken): boolean {
  const pending = token.pending;
  token.pending = undefined;
  if (!pending) {
    return false;
  }
  const edits = mergeRedactionEdits(pending);
  const value = applyRedactionEdits(token.currentValue, edits);
  if (value === token.currentValue) {
    return false;
  }
  token.edits = composeRedactionEdits(token.value.length, token.edits, edits);
  token.currentValue = value;
  return true;
}

function changedRedactionEdits(
  previous: RedactionEdit[],
  current: RedactionEdit[],
): RedactionEdit[] {
  let index = 0;
  return current.filter((edit) => {
    while (
      previous[index] &&
      expectDefined(previous[index], "previous configured edit").start < edit.start
    ) {
      index += 1;
    }
    const before = previous[index];
    return (
      !before ||
      before.start !== edit.start ||
      before.end !== edit.end ||
      before.replacement !== edit.replacement
    );
  });
}

function commitOriginalEdits(token: ScalarToken, edits: RedactionEdit[]): boolean {
  if (edits.length === 0) {
    return false;
  }
  const combined = mergeRedactionEdits([...token.edits, ...edits]);
  const value = applyRedactionEdits(token.value, combined);
  if (value === token.currentValue) {
    return false;
  }
  token.edits = combined;
  token.currentValue = value;
  return true;
}

function updateCurrentRecord(
  input: string,
  current: string,
  tokens: ScalarToken[],
  changed: ReadonlySet<ScalarToken>,
): string {
  const parts: string[] = [];
  let cursor = 0;
  let shift = 0;
  for (const token of tokens) {
    const start = token.currentStart;
    const end = token.currentEnd;
    if (changed.has(token)) {
      updateCurrentToken(input, token);
      const raw = expectDefined(token.currentRaw, "changed JSON token");
      parts.push(current.slice(cursor, start), raw);
      cursor = end;
      token.currentStart = start + shift;
      shift += raw.length - (end - start);
    } else {
      token.currentStart = start + shift;
    }
    token.currentEnd = end + shift;
  }
  parts.push(current.slice(cursor));
  return parts.join("");
}

function projectedStringEnd(
  input: string,
  tokens: ScalarToken[],
  message: RedactionMessage,
  token: ScalarToken,
  start: number,
  end: number,
): number {
  const jsonParts = new Set(message.parts.filter((part) => part.json).map((part) => part.key));
  const spans = projectMessageEdits(input, tokens, message, (source) =>
    source.string && !source.isKey && source.rootKey !== undefined && jsonParts.has(source.rootKey)
      ? [{ start: 0, end: source.value.length, replacement: "" }]
      : [],
  ).filter((span) => span.end < message.contentLength);
  const containing = rebaseRedactionEdits(token.edits, spans).filter(
    (span) => span.start <= start && start < span.end && end <= span.end,
  );
  return containing.length === 1
    ? expectDefined(containing[0], "displayed source string").end
    : token.currentValue.length;
}

export function redactJsonRecord(
  input: string,
  origins: RedactionOrigins,
  patternPhases: readonly [ResolvedRedactPattern[], ResolvedRedactPattern[]],
  getEdit: RedactionEditSelector,
  legacyFieldEdits: (field: RedactionField, currentValue: string) => RedactionEdit[],
  fieldEdits: (field: RedactionField) => RedactionEdit[],
  prepEdits: (field: RedactionField) => RedactionEdit[],
  skipDecodedPatterns: (field: RedactionField, currentValue: string) => boolean,
  message?: RedactionMessage,
  batch?: { preserveLines: boolean },
): string {
  let tokens = batch ? [] : readScalarTokens(input, origins);
  const messageToken = message
    ? tokens.find((token) => !token.isKey && token.path.length === 1 && token.key === "message")
    : undefined;
  const replacementBoundaries = new Map<string, Map<number, number>>();
  let projectedMessageEdits: RedactionEdit[] = [];
  let projectedMessageValue = messageToken?.value ?? "";
  let current = input;
  const prepared = new Set<ScalarToken>();
  for (const token of tokens) {
    if (commitOriginalEdits(token, prepEdits(token))) {
      prepared.add(token);
    }
  }
  if (prepared.size > 0) {
    current = updateCurrentRecord(input, current, tokens, prepared);
  }
  const decodedTokens = tokens.filter(
    (token) => !token.isKey && token.string && !skipDecodedPatterns(token, token.currentValue),
  );
  const projectMessage = (): boolean => {
    if (!messageToken || !message) {
      return false;
    }
    const projected = projectMessageEdits(input, tokens, message, (token) => {
      const edits = changedRedactionEdits(token.projectedEdits, token.edits);
      token.projectedEdits = token.edits;
      return edits;
    });
    if (projected.length === 0) {
      return false;
    }
    const sourceEdits = rebaseRedactionEdits(projectedMessageEdits, projected);
    const messageEdits = rebaseRedactionEdits(messageToken.edits, projected);
    let generatedIndex = 0;
    for (let index = 0; index < messageEdits.length; index += 1) {
      const edit = expectDefined(messageEdits[index], "projected message edit");
      const sourceEdit = expectDefined(sourceEdits[index], "projected source edit");
      const projection = expectDefined(projected[index], "source projection");
      while (
        messageToken.edits[generatedIndex] &&
        expectDefined(messageToken.edits[generatedIndex], "generated message span").start <
          projection.start
      ) {
        generatedIndex += 1;
      }
      const generated = messageToken.edits[generatedIndex];
      const scalarPromotion =
        projection.scalar &&
        generated?.start === projection.start &&
        generated.end === projection.end &&
        edit.replacement === JSON.stringify(generated.replacement);
      const before = messageToken.currentValue.slice(edit.start, edit.end);
      if (
        !scalarPromotion &&
        before !== edit.replacement &&
        before !== projectedMessageValue.slice(sourceEdit.start, sourceEdit.end)
      ) {
        // A source update cannot restore text hidden by a message-only rule.
        edit.replacement = projection.scalar ? JSON.stringify("***") : "***";
      }
    }
    messageToken.pending = messageEdits;
    projectedMessageValue = applyRedactionEdits(projectedMessageValue, sourceEdits);
    projectedMessageEdits = composeRedactionEdits(
      messageToken.value.length,
      projectedMessageEdits,
      sourceEdits,
    );
    return commitPatternEdits(messageToken);
  };
  for (const [phase, patterns] of patternPhases.entries()) {
    const changed = new Set<ScalarToken>();
    const pending = new Set<ScalarToken>();
    const add = (token: ScalarToken, edit: RedactionEdit) => {
      (token.pending ??= []).push(edit);
      pending.add(token);
    };
    for (const pattern of patterns) {
      if (phase === 0) {
        for (const token of decodedTokens) {
          for (const edit of getPatternRedactionEdits(token.currentValue, pattern, getEdit)) {
            add(token, edit);
          }
        }
      } else {
        for (const match of iterateRedactMatches(current, pattern)) {
          let capture: { start: number; end: number } | undefined;
          getEdit(match, pattern, (start, end) => {
            capture = { start, end };
            return undefined;
          });
          if (!capture || capture.end < capture.start) {
            continue;
          }
          // Batch rules need token coordinates only after a serialized match exists.
          if (batch && tokens.length === 0) {
            tokens = readBatchTokens(input, origins, batch.preserveLines);
          }
          for (
            let index = firstIntersectingToken(tokens, capture.start);
            index < tokens.length;
            index += 1
          ) {
            const token = expectDefined(tokens[index], "serialized capture token");
            if (token.currentStart >= capture.end) {
              break;
            }
            const unquoted = token.raw || token.deferEncoding;
            const padding = unquoted ? 0 : 1;
            const captureInsideToken =
              capture.start >= token.currentStart + padding &&
              capture.end <= token.currentEnd - padding;
            if (batch && token.isKey && !captureInsideToken) {
              continue;
            }
            const value = token.currentValue;
            if (!token.raw && !token.string && token.edits.length === 0) {
              add(token, { start: 0, end: value.length, replacement: "***" });
              continue;
            }
            let startPosition = Math.max(capture.start, token.currentStart + padding);
            let start = unquoted
              ? startPosition - token.currentStart
              : currentDecodedBoundary(input, token, startPosition, replacementBoundaries);
            let endPosition = Math.min(capture.end, token.currentEnd - padding);
            let end = unquoted
              ? endPosition - token.currentStart
              : currentDecodedBoundary(input, token, endPosition, replacementBoundaries);
            if (start === undefined || end === undefined) {
              while (start === undefined) {
                start = currentDecodedBoundary(
                  input,
                  token,
                  --startPosition,
                  replacementBoundaries,
                );
              }
              while (end === undefined) {
                end = currentDecodedBoundary(input, token, ++endPosition, replacementBoundaries);
              }
              const maskEnd =
                token === messageToken && message
                  ? projectedStringEnd(input, tokens, message, token, start, end)
                  : value.length;
              add(token, { start, end: maskEnd, replacement: "***" });
              continue;
            }
            if (end < start || (batch && end === start)) {
              continue;
            }
            const { start: captureStart, end: captureEnd } = capture;
            const edit = getEdit(match, pattern, () => ({
              start,
              end,
              value: current.slice(
                Math.max(captureStart, token.currentStart + padding),
                Math.min(captureEnd, token.currentEnd - padding),
              ),
            }));
            if (!edit) {
              continue;
            }
            let replacement = "***";
            if (captureInsideToken) {
              try {
                replacement = unquoted ? edit.replacement : JSON.parse(`"${edit.replacement}"`);
              } catch {
                // A legacy hint can cut an escape; its selected span still receives a full mask.
              }
            }
            add(token, { ...edit, replacement });
          }
        }
      }
      if (pending.size === 0) {
        continue;
      }
      for (const token of pending) {
        if (!commitPatternEdits(token)) {
          pending.delete(token);
        } else if (phase === 0) {
          changed.add(token);
        }
      }
      // Decoded rules read current field values; serialized rules need each rebuilt record.
      if (phase !== 0 && pending.size > 0) {
        current = updateCurrentRecord(input, current, tokens, pending);
      }
      pending.clear();
    }
    for (const token of tokens) {
      if (phase === 0) {
        token.pending = legacyFieldEdits(token, token.currentValue);
        if (commitPatternEdits(token)) {
          changed.add(token);
        }
      } else if (commitOriginalEdits(token, fieldEdits(token))) {
        // Final field protection must not change the hints consumed by configured rules.
        changed.add(token);
      }
    }
    if (
      (phase !== 0 || prepared.size > 0 || changed.size > 0) &&
      projectMessage() &&
      messageToken
    ) {
      changed.add(messageToken);
    }
    if (changed.size > 0) {
      current = updateCurrentRecord(input, current, tokens, changed);
    }
  }
  if (messageToken && message) {
    const finished = message.finish(messageToken.currentValue);
    if (finished !== messageToken.currentValue) {
      return applyRedactionEdits(current, [
        {
          start: messageToken.currentStart,
          end: messageToken.currentEnd,
          replacement: JSON.stringify(finished),
        },
      ]);
    }
  }
  return applyRedactionEdits(
    current,
    tokens.flatMap((token) =>
      token.deferEncoding && token.edits.length > 0
        ? [
            {
              start: token.currentStart,
              end: token.currentEnd,
              replacement: JSON.stringify(token.currentValue),
            },
          ]
        : [],
    ),
  );
}
