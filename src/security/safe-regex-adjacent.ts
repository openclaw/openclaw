// Adjacent unbounded-repeat overlap for the safe-regex analyzer.
import { readScalarEscape, stripAlternativeAnchors } from "./safe-regex-tokens.js";

function isZeroWidthAtom(language: string): boolean {
  return (
    language === "" ||
    language === "^" ||
    language === "$" ||
    language === "\\b" ||
    language === "\\B" ||
    language === "(?:)" ||
    language === "(?=)" ||
    language === "(?!)" ||
    language === "(?<=)" ||
    language === "(?<!)"
  );
}

export function isZeroWidthLanguage(language: string, alternatives: readonly string[]): boolean {
  return isZeroWidthAtom(language) || alternatives.every((alt) => isZeroWidthAtom(alt));
}

function unionPendingAlts(left: readonly string[], right: readonly string[]): string[] {
  const seen = new Set(left);
  const out = [...left];
  for (const alt of right) {
    if (!seen.has(alt)) {
      seen.add(alt);
      out.push(alt);
    }
  }
  return out;
}

export function nextPendingAdjacentAlts(
  previous: string[] | null,
  newAlts: readonly string[],
  minRepeat: number,
  maxRepeat: number | null,
  isZeroWidth: boolean,
): string[] | null {
  if (isZeroWidth) {
    return previous;
  }
  if (maxRepeat === null && newAlts.length > 0) {
    if (minRepeat === 0 && previous) {
      return unionPendingAlts(previous, newAlts);
    }
    return [...newAlts];
  }
  if (minRepeat === 0) {
    return previous;
  }
  return null;
}

export function isLookaroundPrefix(source: string, contentStart: number): boolean {
  const prefix = source.slice(Math.max(0, contentStart - 4), contentStart);
  return (
    prefix.endsWith("?=") ||
    prefix.endsWith("?!") ||
    prefix.endsWith("?<=") ||
    prefix.endsWith("?<!")
  );
}

function walkRegexSource(
  source: string,
  visit: (ch: string, index: number, depth: number) => void,
): boolean {
  let depth = 0;
  let inClass = false;
  for (let index = 0; index < source.length; index += 1) {
    const ch = source[index];
    if (ch === undefined) {
      continue;
    }
    if (ch === "\\") {
      index += 1;
      continue;
    }
    if (inClass) {
      if (ch === "]") {
        inClass = false;
      }
      continue;
    }
    if (ch === "[") {
      inClass = true;
      continue;
    }
    if (ch === "(") {
      depth += 1;
      visit(ch, index, depth);
      continue;
    }
    if (ch === ")") {
      depth -= 1;
      if (depth < 0) {
        return false;
      }
      visit(ch, index, depth);
      continue;
    }
    visit(ch, index, depth);
  }
  return depth === 0;
}

function isSingleWrappingGroup(source: string): boolean {
  if (source.length < 2 || source[0] !== "(" || source[source.length - 1] !== ")") {
    return false;
  }
  let closedEarly = false;
  const balanced = walkRegexSource(source, (ch, index, depth) => {
    if (ch === ")" && depth === 0 && index !== source.length - 1) {
      closedEarly = true;
    }
  });
  return balanced && !closedEarly;
}

function tryUnwrapOuterGroup(source: string): string | null {
  if (!isSingleWrappingGroup(source)) {
    return null;
  }
  if (source.startsWith("(?=") || source.startsWith("(?!") || source.startsWith("(?<=")) {
    return null;
  }
  if (source.startsWith("(?:")) {
    return source.slice(3, -1);
  }
  if (source.startsWith("(?")) {
    return null;
  }
  return source.slice(1, -1);
}

function splitTopLevelAlternatives(source: string): string[] {
  const cuts: number[] = [];
  walkRegexSource(source, (ch, index, depth) => {
    if (ch === "|" && depth === 0) {
      cuts.push(index);
    }
  });
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

function flattenAlternatives(alternatives: readonly string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const visit = (raw: string) => {
    let current = raw;
    for (let depth = 0; depth < 8; depth += 1) {
      const inner = tryUnwrapOuterGroup(current);
      if (inner === null) {
        break;
      }
      current = inner;
    }
    const parts = splitTopLevelAlternatives(current);
    if (parts.length > 1) {
      for (const part of parts) {
        visit(part);
      }
      return;
    }
    if (!seen.has(current)) {
      seen.add(current);
      out.push(current);
    }
  };
  for (const alternative of alternatives) {
    visit(alternative);
  }
  return out.length > 0 ? out : [""];
}

function sameAlternativeSet(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) {
    return false;
  }
  const sortedLeft = [...left].toSorted();
  const sortedRight = [...right].toSorted();
  return sortedLeft.every((alt, index) => alt === sortedRight[index]);
}

function isCharacterClassAlternative(source: string): boolean {
  let body = source;
  if (body.startsWith("^")) {
    body = body.slice(1);
  }
  if (body.endsWith("$")) {
    body = body.slice(0, -1);
  }
  return body.startsWith("[") && body.endsWith("]") && body.length >= 2;
}

export function shouldRejectAdjacentOverlap(
  leftAlts: readonly string[],
  rightAlts: readonly string[],
  ignoreCase: boolean,
  failClosedUnprobedUnicode: boolean,
  singleTokenPairOverlaps: (left: string, right: string, ignoreCase: boolean) => boolean,
): boolean {
  if (!adjacentRepeatsOverlap(leftAlts, rightAlts, ignoreCase, singleTokenPairOverlaps)) {
    return false;
  }
  if (
    !failClosedUnprobedUnicode &&
    sameAlternativeSet(leftAlts, rightAlts) &&
    leftAlts.every((alt) => isCharacterClassAlternative(alt))
  ) {
    return false;
  }
  return true;
}

export function adjacentRepeatsOverlap(
  leftAlts: readonly string[],
  rightAlts: readonly string[],
  ignoreCase: boolean,
  singleTokenPairOverlaps: (left: string, right: string, ignoreCase: boolean) => boolean,
): boolean {
  const leftFlat = flattenAlternatives(leftAlts);
  const rightFlat = flattenAlternatives(rightAlts);
  for (const left of leftFlat) {
    for (const right of rightFlat) {
      if (left === right) {
        return true;
      }
      if (singleTokenPairOverlaps(left, right, ignoreCase)) {
        return true;
      }
    }
  }
  return false;
}

export function mixedSequencesOverlap(
  leftAtoms: readonly string[],
  rightAtoms: readonly string[],
  ignoreCase: boolean,
  failClosedUnprobedUnicode: boolean,
  singleTokenPairOverlaps: (
    left: string,
    right: string,
    ignoreCase: boolean,
    failClosedUnprobedUnicode: boolean,
  ) => boolean,
): boolean {
  const sharedLength = Math.min(leftAtoms.length, rightAtoms.length);
  for (let index = 0; index < sharedLength; index += 1) {
    const leftAtom = leftAtoms[index];
    const rightAtom = rightAtoms[index];
    if (leftAtom === undefined || rightAtom === undefined) {
      return true;
    }
    if (!singleTokenPairOverlaps(leftAtom, rightAtom, ignoreCase, failClosedUnprobedUnicode)) {
      return false;
    }
  }
  // Common prefix overlaps. Unequal length is a prefix language (unsafe).
  return true;
}

/** Characters named by a token, used as overlap witnesses outside ASCII probes. */
function collectAtomWitnesses(source: string, captureCount: number): string[] {
  const body = stripAlternativeAnchors(source);
  const chars: string[] = [];
  const seen = new Set<string>();
  const add = (ch: string) => {
    if (!ch || seen.has(ch)) {
      return;
    }
    seen.add(ch);
    chars.push(ch);
  };
  let inClass = false;
  for (let index = 0; index < body.length;) {
    if (body[index] === "\\") {
      const scalar = readScalarEscape(body, index, false, captureCount);
      if (scalar) {
        add(scalar.value);
        index = scalar.nextIndex;
        continue;
      }
      index = Math.min(index + 2, body.length);
      continue;
    }
    if (!inClass && body[index] === "[") {
      inClass = true;
      index += 1;
      if (body[index] === "^") {
        index += 1;
      }
      continue;
    }
    if (inClass && body[index] === "]") {
      inClass = false;
      index += 1;
      continue;
    }
    const cp = body.codePointAt(index);
    if (cp === undefined) {
      break;
    }
    const unit = body[index] ?? "";
    if (inClass || !".$^*+?(){}|".includes(unit)) {
      add(String.fromCodePoint(cp));
    }
    index += cp > 0xffff ? 2 : 1;
  }
  return chars;
}

/** True if an alternative may match outside the finite ASCII+probe set. */
function alternativeHasUnprobedNonAscii(source: string, captureCount = 0): boolean {
  const body = stripAlternativeAnchors(source);
  // Decode known scalar escapes so \u0061 stays ASCII-probed (disjoint a|b).
  let decoded = "";
  for (let index = 0; index < body.length; index += 1) {
    if (body[index] === "\\") {
      const scalar = readScalarEscape(body, index, false, captureCount);
      if (scalar) {
        decoded += scalar.value;
        index = scalar.nextIndex - 1;
        continue;
      }
      // Unicode property escapes cannot be fully probed with a finite set.
      if (body[index + 1] === "p" || body[index + 1] === "P") {
        return true;
      }
      if (body[index + 1] === "u" && body[index + 2] === "{") {
        return true;
      }
      decoded += body[index];
      continue;
    }
    decoded += body[index];
  }
  // Avoid control-char regex (eslint no-control-regex); compare code units.
  for (let i = 0; i < decoded.length; i += 1) {
    if (decoded.charCodeAt(i) > 0x7f) {
      return true;
    }
  }
  return false;
}

function isUnicodePropertyAtom(source: string): boolean {
  const body = stripAlternativeAnchors(source);
  const inner =
    body.startsWith("[") && body.endsWith("]") && !body.slice(1, -1).includes("[")
      ? body.slice(1, -1)
      : body;
  return /^\\[pP]\{[A-Za-z_][A-Za-z0-9_]*(=[A-Za-z0-9_]+)?\}$/.test(inner);
}

function isMixedPropertyClass(source: string): boolean {
  const body = stripAlternativeAnchors(source);
  if (!body.startsWith("[") || !body.endsWith("]")) {
    return false;
  }
  const inner = body.slice(1, -1);
  if (!/\\[pP]\{/.test(inner)) {
    return false;
  }
  return !/^\\[pP]\{[A-Za-z_][A-Za-z0-9_]*(=[A-Za-z0-9_]+)?\}$/.test(inner);
}

/** Probe whether two single-token alternatives can match the same character. */
export function singleTokenAlternativesMayOverlap(
  left: string,
  right: string,
  ignoreCase: boolean,
  failClosedUnprobedUnicode: boolean,
  unicodeMode = false,
  dotAll = false,
): boolean {
  const flags = `${ignoreCase ? "i" : ""}${unicodeMode ? "u" : ""}${dotAll ? "s" : ""}`;
  let leftRe: RegExp;
  let rightRe: RegExp;
  try {
    leftRe = new RegExp(`^(?:${stripAlternativeAnchors(left)})$`, flags);
    rightRe = new RegExp(`^(?:${stripAlternativeAnchors(right)})$`, flags);
  } catch {
    return true;
  }
  let leftHit = false;
  let rightHit = false;
  const consider = (ch: string): boolean => {
    const leftMatch = leftRe.test(ch);
    const rightMatch = rightRe.test(ch);
    if (leftMatch) {
      leftHit = true;
    }
    if (rightMatch) {
      rightHit = true;
    }
    return leftMatch && rightMatch;
  };
  for (let code = 0; code < 128; code += 1) {
    if (consider(String.fromCharCode(code))) {
      return true;
    }
  }
  // Light non-ASCII probes for Unicode property / word-class overlap.
  for (const ch of ["\u00A0", "\u00E9", "\u4E2D"]) {
    if (consider(ch)) {
      return true;
    }
  }
  // Named atoms such as [Ā] vs Ā share U+0100, which the finite set misses.
  for (const ch of [...collectAtomWitnesses(left, 0), ...collectAtomWitnesses(right, 0)]) {
    if (consider(ch)) {
      return true;
    }
  }
  // Property languages such as \p{L} vs \p{Script=Greek} can miss the finite
  // probe set on one side. ASCII hits Letter, none hit Greek, and source
  // witnesses add no Greek character. Fail closed unless both property
  // languages were observed without a shared witness. [猫]|[犬] is not a
  // property atom and stays accepted on the shared compiler.
  if (isUnicodePropertyAtom(left) && isUnicodePropertyAtom(right) && !(leftHit && rightHit)) {
    return true;
  }
  // [0\p{Script=Greek}] vs \p{L} can miss Greek on the finite probe set.
  // Mixed vs mixed, or mixed vs a property atom, stays uncertain.
  // Mixed vs a probed ASCII class such as [1] stays disjoint when no
  // witness matched.
  if (
    (isMixedPropertyClass(left) || isMixedPropertyClass(right)) &&
    (isUnicodePropertyAtom(left) ||
      isUnicodePropertyAtom(right) ||
      (isMixedPropertyClass(left) && isMixedPropertyClass(right)) ||
      failClosedUnprobedUnicode)
  ) {
    return true;
  }
  // Finite probe cannot prove safety for unprobed Unicode alternatives
  // (e.g. /(?:[\u0100]|\u0100)+/). Exec approvals fail closed; shared
  // compileSafeRegex must not reject safe disjoint Unicode classes like
  // [猫]|[犬] used by group mentions / cron / plugins.
  if (
    failClosedUnprobedUnicode &&
    (alternativeHasUnprobedNonAscii(left) || alternativeHasUnprobedNonAscii(right))
  ) {
    return true;
  }
  return false;
}
