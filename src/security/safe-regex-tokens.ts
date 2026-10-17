// Tokenizes user-supplied regex sources for the safe-regex analyzer.
import {
  ATOM_SEQUENCE_OVERFLOW,
  appendCollapsedSequences,
  cartesianConcatSequences,
  MAX_ALTERNATIVE_SEQUENCES,
  type AtomSequence,
  type AtomSequenceRead,
} from "./safe-regex-sequences.js";

export {
  ATOM_SEQUENCE_OVERFLOW,
  sequenceAtomsForOverlap,
  sequenceOverlapIsProven,
  type AtomSequence,
} from "./safe-regex-sequences.js";

type QuantifierRead = {
  consumed: number;
  minRepeat: number;
  maxRepeat: number | null;
};

export type PatternToken =
  | { kind: "simple-token"; source: string }
  | { kind: "group-open"; contentStart: number }
  | { kind: "group-close"; start: number }
  | { kind: "alternation"; start: number; end: number }
  | { kind: "quantifier"; quantifier: QuantifierRead };

function readGroupContentStart(source: string, index: number): number {
  if (source[index + 1] !== "?") {
    return index + 1;
  }
  const marker = source[index + 2];
  if (marker === ":" || marker === "=" || marker === "!") {
    return index + 3;
  }
  if (marker !== "<") {
    return index + 1;
  }
  if (source[index + 3] === "=" || source[index + 3] === "!") {
    return index + 4;
  }
  const nameEnd = source.indexOf(">", index + 3);
  return nameEnd === -1 ? index + 1 : nameEnd + 1;
}

function readQuantifier(source: string, index: number): QuantifierRead | null {
  const ch = source[index];
  const consumed = source[index + 1] === "?" ? 2 : 1;
  if (ch === "*") {
    return { consumed, minRepeat: 0, maxRepeat: null };
  }
  if (ch === "+") {
    return { consumed, minRepeat: 1, maxRepeat: null };
  }
  if (ch === "?") {
    return { consumed, minRepeat: 0, maxRepeat: 1 };
  }
  if (ch !== "{") {
    return null;
  }

  let i = index + 1;
  while (i < source.length && /\d/.test(source.charAt(i))) {
    i += 1;
  }
  if (i === index + 1) {
    return null;
  }

  const minRepeat = Number.parseInt(source.slice(index + 1, i), 10);
  let maxRepeat: number | null = minRepeat;
  if (source[i] === ",") {
    i += 1;
    const maxStart = i;
    while (i < source.length && /\d/.test(source.charAt(i))) {
      i += 1;
    }
    maxRepeat = i === maxStart ? null : Number.parseInt(source.slice(maxStart, i), 10);
  }

  if (source[i] !== "}") {
    return null;
  }
  i += 1;
  if (source[i] === "?") {
    i += 1;
  }
  if (maxRepeat !== null && maxRepeat < minRepeat) {
    return null;
  }

  return { consumed: i - index, minRepeat, maxRepeat };
}

function isUnicodePropertyName(interior: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*(=[A-Za-z0-9_]+)?$/.test(interior);
}

/**
 * Last index of one escape atom (`\p{L}`, `\u0041`, `\x41`), else the
 * one-char escape after `\`. `\p{L}` is one property atom only with
 * `u`/`v`; without those flags `\p` is identity `p`. Do not swallow
 * `\p{(a+)+}`: the group must still be analyzed.
 */
export function readEscapeAtomEnd(
  source: string,
  backslashIndex: number,
  unicodeMode = false,
  captureCount = 0,
): number {
  if (backslashIndex + 1 >= source.length) {
    return backslashIndex;
  }
  const kind = source[backslashIndex + 1];
  const afterKind = backslashIndex + 2;

  if ((kind === "p" || kind === "P") && source[afterKind] === "{") {
    if (!unicodeMode) {
      return backslashIndex + 1;
    }
    const close = source.indexOf("}", afterKind + 1);
    if (close !== -1 && isUnicodePropertyName(source.slice(afterKind + 1, close))) {
      return close;
    }
    return backslashIndex + 1;
  }

  if (kind === "u" && source[afterKind] === "{") {
    if (!unicodeMode) {
      return backslashIndex + 1;
    }
    const close = source.indexOf("}", afterKind + 1);
    if (close !== -1 && /^[0-9a-fA-F]{1,6}$/.test(source.slice(afterKind + 1, close))) {
      const cp = Number.parseInt(source.slice(afterKind + 1, close), 16);
      if (Number.isFinite(cp) && cp >= 0 && cp <= 0x10ffff) {
        return close;
      }
    }
    return backslashIndex + 1;
  }

  if (kind === "u" && /^[0-9a-fA-F]{4}/.test(source.slice(afterKind, afterKind + 4))) {
    return afterKind + 3;
  }

  if (kind === "x" && /^[0-9a-fA-F]{2}/.test(source.slice(afterKind, afterKind + 2))) {
    return afterKind + 1;
  }

  const backref = readDecimalBackref(source, backslashIndex, captureCount);
  if (backref) {
    return backref.nextIndex - 1;
  }

  const octal = readLegacyOctalEscape(source, backslashIndex, unicodeMode);
  if (octal) {
    return octal.nextIndex - 1;
  }

  return backslashIndex + 1;
}

/**
 * Decimal `\1`..`\k` is a backref when k <= capturing groups. `\0` is never
 * a backref. Consume the full digit run so `\400` stays one atom when group
 * 400 exists, instead of two-digit octal `\40` plus leftover `0`.
 */
function readDecimalBackref(
  source: string,
  index: number,
  captureCount: number,
): { nextIndex: number } | null {
  if (captureCount <= 0 || source[index] !== "\\") {
    return null;
  }
  const first = source[index + 1];
  if (first === undefined || first < "1" || first > "9") {
    return null;
  }
  let end = index + 1;
  while (end + 1 < source.length) {
    const next = source[end + 1];
    if (next === undefined || next < "0" || next > "9") {
      break;
    }
    end += 1;
  }
  const n = Number.parseInt(source.slice(index + 1, end + 1), 10);
  if (!Number.isFinite(n) || n > captureCount) {
    return null;
  }
  return { nextIndex: end + 1 };
}

/**
 * Non-unicode `\141` is one octal atom (`a`), not `\1` plus leftover digits.
 * First digit 4-7 stops at two digits, so `\400` is `\40` plus literal `0`.
 * Unicode mode forbids octal; those stay one-char escapes / backrefs.
 */
function readLegacyOctalEscape(
  source: string,
  index: number,
  unicodeMode: boolean,
): { value: string; nextIndex: number } | null {
  if (unicodeMode || source[index] !== "\\") {
    return null;
  }
  const kind = source[index + 1];
  if (kind === undefined || kind < "0" || kind > "7") {
    return null;
  }
  let end = index + 1;
  const maxExtra = kind <= "3" ? 2 : 1;
  for (let extra = 0; extra < maxExtra; extra += 1) {
    const next = source[end + 1];
    if (next === undefined || next < "0" || next > "7") {
      break;
    }
    end += 1;
  }
  return {
    value: String.fromCharCode(Number.parseInt(source.slice(index + 1, end + 1), 8)),
    nextIndex: end + 1,
  };
}

/**
 * Octal that cannot be a backref: 3 digits (`\141`), a `\0` form, or
 * two digits starting with 4-7 (`\40`). Single `\1`..`\7` stay unproven
 * so `(a)(\1|aa)+` remains overlapping.
 */
export function readUnambiguousOctalEscape(
  source: string,
  index: number,
  unicodeMode: boolean,
  captureCount = 0,
): { value: string; nextIndex: number } | null {
  if (readDecimalBackref(source, index, captureCount)) {
    return null;
  }
  const octal = readLegacyOctalEscape(source, index, unicodeMode);
  if (!octal) {
    return null;
  }
  const digits = source.slice(index + 1, octal.nextIndex);
  const first = digits[0];
  const twoDigitHighOctal =
    digits.length === 2 && first !== undefined && first >= "4" && first <= "7";
  if (digits.length < 3 && !digits.startsWith("0") && !twoDigitHighOctal) {
    return null;
  }
  return octal;
}

/**
 * Decode a single \uXXXX / \xXX / \u{...} / unambiguous octal escape at
 * `index` (points at backslash). Numeric backrefs stay unproven.
 */
export function readScalarEscape(
  source: string,
  index: number,
  unicodeMode = false,
  captureCount = 0,
): { value: string; nextIndex: number } | null {
  if (source[index] !== "\\") {
    return null;
  }
  const kind = source[index + 1];
  if (kind === "u" && source[index + 2] === "{") {
    if (!unicodeMode) {
      return null;
    }
    const close = source.indexOf("}", index + 3);
    if (close < 0) {
      return null;
    }
    const hex = source.slice(index + 3, close);
    if (!/^[0-9a-fA-F]{1,6}$/.test(hex)) {
      return null;
    }
    const cp = Number.parseInt(hex, 16);
    if (!Number.isFinite(cp) || cp < 0 || cp > 0x10ffff) {
      return null;
    }
    return { value: String.fromCodePoint(cp), nextIndex: close + 1 };
  }
  if (kind === "u" && /^[0-9a-fA-F]{4}/.test(source.slice(index + 2, index + 6))) {
    const cp = Number.parseInt(source.slice(index + 2, index + 6), 16);
    return { value: String.fromCodePoint(cp), nextIndex: index + 6 };
  }
  if (kind === "x" && /^[0-9a-fA-F]{2}/.test(source.slice(index + 2, index + 4))) {
    const cp = Number.parseInt(source.slice(index + 2, index + 4), 16);
    return { value: String.fromCharCode(cp), nextIndex: index + 4 };
  }
  return readUnambiguousOctalEscape(source, index, unicodeMode, captureCount);
}

function isCapturingGroupOpen(source: string, contentStart: number): boolean {
  let open = contentStart - 1;
  while (open >= 0 && source[open] !== "(") {
    open -= 1;
  }
  if (open < 0) {
    return false;
  }
  if (source[open + 1] !== "?") {
    return true;
  }
  const marker = source[open + 2];
  if (marker === ":" || marker === "=" || marker === "!") {
    return false;
  }
  if (marker === "<" && (source[open + 3] === "=" || source[open + 3] === "!")) {
    return false;
  }
  return true;
}

export function countCapturingGroups(source: string, tokens: readonly PatternToken[]): number {
  let count = 0;
  for (const token of tokens) {
    if (token.kind === "group-open" && isCapturingGroupOpen(source, token.contentStart)) {
      count += 1;
    }
  }
  return count;
}

function tokenizePatternWithCaptures(
  source: string,
  unicodeMode: boolean,
  captureCount: number,
): PatternToken[] {
  const tokens: PatternToken[] = [];

  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];

    if (ch === "\\") {
      const end = readEscapeAtomEnd(source, i, unicodeMode, captureCount);
      tokens.push({ kind: "simple-token", source: source.slice(i, end + 1) });
      i = end;
      continue;
    }

    if (ch === "[") {
      const start = i;
      i += 1;
      while (i < source.length) {
        if (source[i] === "\\") {
          i += 2;
          continue;
        }
        if (source[i] === "]") {
          break;
        }
        i += 1;
      }
      tokens.push({
        kind: "simple-token",
        source: source.slice(start, Math.min(i + 1, source.length)),
      });
      continue;
    }

    if (ch === "(") {
      const contentStart = readGroupContentStart(source, i);
      tokens.push({ kind: "group-open", contentStart });
      i = contentStart - 1;
      continue;
    }

    if (ch === ")") {
      tokens.push({ kind: "group-close", start: i });
      continue;
    }

    if (ch === "|") {
      tokens.push({ kind: "alternation", start: i, end: i + 1 });
      continue;
    }

    const quantifier = readQuantifier(source, i);
    if (quantifier) {
      tokens.push({ kind: "quantifier", quantifier });
      i += quantifier.consumed - 1;
      continue;
    }

    tokens.push({ kind: "simple-token", source: source.slice(i, i + 1) });
  }

  return tokens;
}

export function tokenizePattern(source: string, flags = "", captureCount?: number): PatternToken[] {
  const unicodeMode = flags.includes("u") || flags.includes("v");
  if (captureCount === undefined) {
    const firstPass = tokenizePatternWithCaptures(source, unicodeMode, 0);
    const counted = countCapturingGroups(source, firstPass);
    if (counted === 0) {
      return firstPass;
    }
    return tokenizePatternWithCaptures(source, unicodeMode, counted);
  }
  return tokenizePatternWithCaptures(source, unicodeMode, captureCount);
}

const ZERO_WIDTH_SIMPLE_ATOMS = new Set(["^", "$", "\\b", "\\B"]);
const NAMED_CHAR_ESCAPES: Record<string, string> = {
  "\\n": "\n",
  "\\t": "\t",
  "\\r": "\r",
  "\\f": "\f",
  "\\v": "\v",
};

function isLookaroundGroupPrefix(source: string, contentStart: number): boolean {
  const prefix = source.slice(0, contentStart);
  return (
    prefix.endsWith("?=") ||
    prefix.endsWith("?!") ||
    prefix.endsWith("?<=") ||
    prefix.endsWith("?<!")
  );
}

function findMatchingGroupClose(tokens: readonly PatternToken[], openIndex: number): number {
  let depth = 0;
  for (let index = openIndex; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token) {
      return -1;
    }
    if (token.kind === "group-open") {
      depth += 1;
    } else if (token.kind === "group-close") {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
  }
  return -1;
}

function escapeDecodedLiteral(value: string, unicodeMode: boolean): string {
  let escaped = "";
  for (const ch of value) {
    const code = ch.codePointAt(0);
    if (code === undefined) {
      continue;
    }
    // `\xNN` and `\uXXXX` keep literal identity with or without `u`.
    // `\u{hex}` requires unicode mode; non-unicode probes would drop `u`
    // and treat `\u{e9}` as identity `u{e9}` instead of é.
    if (code < 0x100) {
      escaped += `\\x${code.toString(16).padStart(2, "0")}`;
      continue;
    }
    if (code < 0x10000) {
      escaped += `\\u${code.toString(16).padStart(4, "0")}`;
      continue;
    }
    if (unicodeMode) {
      escaped += `\\u{${code.toString(16)}}`;
      continue;
    }
    const units = String.fromCodePoint(code);
    for (let index = 0; index < units.length; index += 1) {
      escaped += `\\u${units.charCodeAt(index).toString(16).padStart(4, "0")}`;
    }
  }
  return escaped;
}

/**
 * One consumed character for overlap compare, or null when width is unproven
 * (backref, incomplete escape). Decoded scalars are emitted as `\xNN`
 * / `\uXXXX` so `$` and `.` stay literals during overlap probing.
 */
function decodeFixedWidthSimpleToken(
  source: string,
  unicodeMode: boolean,
  captureCount: number,
): string | null {
  if (!source.startsWith("\\")) {
    return source;
  }
  if (/^\\x[0-9a-fA-F]{2}$/.test(source)) {
    return escapeDecodedLiteral(
      String.fromCharCode(Number.parseInt(source.slice(2), 16)),
      unicodeMode,
    );
  }
  if (/^\\u[0-9a-fA-F]{4}$/.test(source)) {
    return escapeDecodedLiteral(
      String.fromCharCode(Number.parseInt(source.slice(2), 16)),
      unicodeMode,
    );
  }
  if (unicodeMode && /^\\u\{[0-9a-fA-F]{1,6}\}$/.test(source)) {
    const cp = Number.parseInt(source.slice(3, -1), 16);
    if (!Number.isFinite(cp) || cp < 0 || cp > 0x10ffff) {
      return null;
    }
    return escapeDecodedLiteral(String.fromCodePoint(cp), unicodeMode);
  }
  const octal = readUnambiguousOctalEscape(source, 0, unicodeMode, captureCount);
  if (octal && octal.nextIndex === source.length) {
    return escapeDecodedLiteral(octal.value, unicodeMode);
  }
  const named = NAMED_CHAR_ESCAPES[source];
  if (named !== undefined) {
    return escapeDecodedLiteral(named, unicodeMode);
  }
  if (source.length === 2) {
    const escaped = source[1];
    if (escaped !== undefined && !/[0-9A-Za-z]/.test(escaped)) {
      return escapeDecodedLiteral(escaped, unicodeMode);
    }
    // Non-unicode `\p` / `\P` are identity letters, not property atoms.
    if (!unicodeMode && (source === "\\p" || source === "\\P") && escaped !== undefined) {
      return escapeDecodedLiteral(escaped, unicodeMode);
    }
  }
  if (/^\\[dDsSwW]$/.test(source) || source.startsWith("\\p{") || source.startsWith("\\P{")) {
    return source;
  }
  return null;
}

function splitTopLevelAlternativeSources(
  source: string,
  unicodeMode: boolean,
  captureCount: number,
): string[] {
  const tokens = tokenizePattern(source, unicodeMode ? "u" : "", captureCount);
  const cuts: number[] = [];
  let depth = 0;
  for (const token of tokens) {
    if (token.kind === "group-open") {
      depth += 1;
      continue;
    }
    if (token.kind === "group-close") {
      depth -= 1;
      continue;
    }
    if (token.kind === "alternation" && depth === 0) {
      cuts.push(token.start);
    }
  }
  if (cuts.length === 0) {
    return [source];
  }
  const parts: string[] = [];
  let start = 0;
  for (const cut of cuts) {
    parts.push(source.slice(start, cut));
    start = cut + 1;
  }
  parts.push(source.slice(start));
  return parts;
}

function collectAtomSequences(
  source: string,
  unicodeMode: boolean,
  captureCount: number,
): AtomSequenceRead {
  const tokens = tokenizePattern(source, unicodeMode ? "u" : "", captureCount);
  let sequences: AtomSequence[] = [{ atoms: [], complete: true }];
  for (let index = 0; index < tokens.length;) {
    const token = tokens[index];
    if (!token) {
      return null;
    }
    if (
      token.kind === "quantifier" ||
      token.kind === "alternation" ||
      token.kind === "group-close"
    ) {
      return null;
    }
    if (token.kind === "group-open") {
      const closeIndex = findMatchingGroupClose(tokens, index);
      const close = tokens[closeIndex];
      if (closeIndex < 0 || !close || close.kind !== "group-close") {
        return null;
      }
      const contentStart = token.contentStart;
      if (isLookaroundGroupPrefix(source, contentStart)) {
        index = closeIndex + 1;
        continue;
      }
      const interior = source.slice(contentStart, close.start);
      const inner = interior
        ? readAlternativeAtomSequences(interior, unicodeMode, captureCount)
        : [{ atoms: [], complete: true }];
      if (inner === ATOM_SEQUENCE_OVERFLOW) {
        return ATOM_SEQUENCE_OVERFLOW;
      }
      if (!inner) {
        return null;
      }
      const next = cartesianConcatSequences(sequences, inner);
      if (next === ATOM_SEQUENCE_OVERFLOW) {
        return ATOM_SEQUENCE_OVERFLOW;
      }
      sequences = next;
      index = closeIndex + 1;
      continue;
    }
    if (ZERO_WIDTH_SIMPLE_ATOMS.has(token.source)) {
      index += 1;
      continue;
    }
    const decoded = decodeFixedWidthSimpleToken(token.source, unicodeMode, captureCount);
    if (decoded === null) {
      return null;
    }
    const next = cartesianConcatSequences(sequences, [{ atoms: [decoded], complete: true }]);
    if (next === ATOM_SEQUENCE_OVERFLOW) {
      return ATOM_SEQUENCE_OVERFLOW;
    }
    sequences = next;
    index += 1;
  }
  const nonempty = sequences.filter((seq) => seq.atoms.length > 0);
  return nonempty.length > 0 ? nonempty : null;
}

/**
 * Drop unescaped start/end anchors only. `a\$` must keep the literal dollar.
 */
export function stripAlternativeAnchors(source: string): string {
  let start = 0;
  let end = source.length;
  if (source[start] === "^") {
    start += 1;
  }
  if (end > start && source[end - 1] === "$") {
    let slashes = 0;
    for (let i = end - 2; i >= start && source[i] === "\\"; i -= 1) {
      slashes += 1;
    }
    if (slashes % 2 === 0) {
      end -= 1;
    }
  }
  return source.slice(start, end);
}

/**
 * Finite atom sequences for one alternative, expanding nested groups.
 * Null when a quantifier or unknown-width atom makes length unproven.
 * Sequences longer than the atom cap keep a truncated prefix so
 * proven-disjoint first atoms still screen; `complete` is false then.
 */
export function readAlternativeAtomSequences(
  source: string,
  unicodeMode = false,
  captureCount = 0,
): AtomSequenceRead {
  const body = stripAlternativeAnchors(source);
  if (!body) {
    return null;
  }
  const parts = splitTopLevelAlternativeSources(body, unicodeMode, captureCount);
  if (parts.length === 1) {
    return collectAtomSequences(body, unicodeMode, captureCount);
  }
  const all: AtomSequence[] = [];
  let unionAtoms: string[] = [];
  const flushUnion = (): typeof ATOM_SEQUENCE_OVERFLOW | null => {
    if (unionAtoms.length === 0) {
      return null;
    }
    const atom = unionAtoms.length === 1 ? unionAtoms[0] : `(?:${unionAtoms.join("|")})`;
    unionAtoms = [];
    if (!atom || all.length + 1 > MAX_ALTERNATIVE_SEQUENCES) {
      return ATOM_SEQUENCE_OVERFLOW;
    }
    all.push({ atoms: [atom], complete: true });
    return null;
  };
  for (const part of parts) {
    const sequences = collectAtomSequences(part, unicodeMode, captureCount);
    if (sequences === ATOM_SEQUENCE_OVERFLOW) {
      return ATOM_SEQUENCE_OVERFLOW;
    }
    if (!sequences) {
      return null;
    }
    const single =
      sequences.length === 1 &&
      sequences[0]?.complete === true &&
      sequences[0].atoms.length === 1 &&
      sequences[0].atoms[0] !== undefined
        ? sequences[0].atoms[0]
        : undefined;
    if (single !== undefined) {
      unionAtoms.push(single);
      continue;
    }
    if (flushUnion() === ATOM_SEQUENCE_OVERFLOW) {
      return ATOM_SEQUENCE_OVERFLOW;
    }
    if (appendCollapsedSequences(all, sequences) === ATOM_SEQUENCE_OVERFLOW) {
      return ATOM_SEQUENCE_OVERFLOW;
    }
  }
  if (flushUnion() === ATOM_SEQUENCE_OVERFLOW) {
    return ATOM_SEQUENCE_OVERFLOW;
  }
  return all;
}
