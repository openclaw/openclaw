// Finite atom-sequence expansion for alternative overlap analysis.

export type AtomSequence = {
  atoms: string[];
  complete: boolean;
  nextAtom?: string;
  unknownTail?: boolean;
  /** Omitted tail is more copies of nextAtom (34 vs 68 `a`s), not a later distinct suffix. */
  unknownTailHomogeneous?: boolean;
};

export function sequenceAtomsForOverlap(seq: AtomSequence): string[] {
  return seq.nextAtom === undefined ? seq.atoms : [...seq.atoms, seq.nextAtom];
}

function withNextAtom(
  atoms: string[],
  complete: boolean,
  nextAtom: string | undefined,
  unknownTail = false,
  unknownTailHomogeneous = false,
): AtomSequence {
  const seq: AtomSequence = { atoms, complete };
  if (!complete && nextAtom !== undefined) {
    seq.nextAtom = nextAtom;
  }
  if (!complete && unknownTail) {
    seq.unknownTail = true;
    if (unknownTailHomogeneous) {
      seq.unknownTailHomogeneous = true;
    }
  }
  return seq;
}

/** Truncated equal prefixes prove overlap only if one language is fully witnessed. */
export function sequenceOverlapIsProven(leftSeq: AtomSequence, rightSeq: AtomSequence): boolean {
  if (leftSeq.atoms.length < rightSeq.atoms.length) {
    return leftSeq.complete;
  }
  if (rightSeq.atoms.length < leftSeq.atoms.length) {
    return rightSeq.complete;
  }
  if (leftSeq.complete || rightSeq.complete) {
    return true;
  }
  if (leftSeq.unknownTail === true && rightSeq.unknownTail === true) {
    return false;
  }
  return leftSeq.nextAtom !== undefined && rightSeq.nextAtom !== undefined;
}

export const ATOM_SEQUENCE_OVERFLOW = "overflow";

export type AtomSequenceRead = AtomSequence[] | typeof ATOM_SEQUENCE_OVERFLOW | null;

export const MAX_ALTERNATIVE_SEQUENCES = 16;
const MAX_SEQUENCE_ATOMS = 32;

function cloneAtomSequence(seq: AtomSequence): AtomSequence {
  return withNextAtom(
    [...seq.atoms],
    seq.complete,
    seq.nextAtom,
    seq.unknownTail === true,
    seq.unknownTailHomogeneous === true,
  );
}

/** `[a]` and `a` are one character. A range, negated class, or multi-character class is not. */
function singleCharLanguage(atom: string): string | null {
  if (atom.length === 1) {
    return atom === "." || atom === "^" || atom === "$" ? null : atom;
  }
  if (!atom.startsWith("[") || !atom.endsWith("]") || atom.startsWith("[^") || atom.includes("-")) {
    return null;
  }
  const inner = atom.slice(1, -1);
  if (inner.length === 1) {
    return inner === "^" || inner === "-" ? null : inner;
  }
  if (inner.length === 2 && inner.startsWith("\\") && !/[0-9A-Za-z]/.test(inner[1] ?? "")) {
    return inner[1] ?? null;
  }
  return null;
}

function sameSingleCharAtom(left: string, right: string): boolean {
  const language = singleCharLanguage(left);
  return language !== null && language === singleCharLanguage(right);
}

function omittedTailIsHomogeneous(suffix: AtomSequence, room: number): boolean {
  const next = suffix.atoms[room];
  if (next === undefined) {
    return false;
  }
  if (suffix.unknownTail === true) {
    return false;
  }
  if (suffix.nextAtom !== undefined && !sameSingleCharAtom(suffix.nextAtom, next)) {
    return false;
  }
  return suffix.atoms.slice(room + 1).every((atom) => sameSingleCharAtom(atom, next));
}

/** Collapse ax|bx|…|qx into one (?:a|b|…|q)x sequence when tails match. */
function collapseEqualTailSequences(sequences: readonly AtomSequence[]): AtomSequence[] | null {
  if (sequences.length < 2) {
    return null;
  }
  const first = sequences[0];
  if (!first?.complete || first.atoms.length < 2 || first.unknownTail === true) {
    return null;
  }
  const tail = first.atoms.slice(1);
  const tailKey = tail.join("\0");
  const heads: string[] = [];
  for (const seq of sequences) {
    if (
      !seq.complete ||
      seq.unknownTail === true ||
      seq.atoms.length !== first.atoms.length ||
      seq.atoms.slice(1).join("\0") !== tailKey
    ) {
      return null;
    }
    const head = seq.atoms[0];
    if (head === undefined) {
      return null;
    }
    heads.push(head);
  }
  const firstHead = heads[0];
  if (firstHead === undefined) {
    return null;
  }
  const union = heads.length === 1 ? firstHead : `(?:${heads.join("|")})`;
  return [{ atoms: [union, ...tail], complete: true }];
}

export function appendCollapsedSequences(
  all: AtomSequence[],
  sequences: AtomSequence[],
): typeof ATOM_SEQUENCE_OVERFLOW | null {
  if (all.length + sequences.length <= MAX_ALTERNATIVE_SEQUENCES) {
    all.push(...sequences);
    return null;
  }
  const collapsed = collapseEqualTailSequences([...all, ...sequences]);
  if (!collapsed) {
    return ATOM_SEQUENCE_OVERFLOW;
  }
  all.length = 0;
  all.push(...collapsed);
  return null;
}

function concatAtomSequence(prefix: AtomSequence, suffix: AtomSequence): AtomSequence {
  if (prefix.atoms.length + suffix.atoms.length <= MAX_SEQUENCE_ATOMS) {
    return withNextAtom(
      [...prefix.atoms, ...suffix.atoms],
      prefix.complete && suffix.complete,
      prefix.complete ? suffix.nextAtom : prefix.nextAtom,
      prefix.unknownTail === true ||
        suffix.unknownTail === true ||
        (!prefix.complete && suffix.atoms.length > 0),
    );
  }
  const room = Math.max(0, MAX_SEQUENCE_ATOMS - prefix.atoms.length);
  const kept = room > 0 ? [...prefix.atoms, ...suffix.atoms.slice(0, room)] : [...prefix.atoms];
  if (!prefix.complete) {
    const suffixAtom = suffix.atoms.length === 1 ? suffix.atoms[0] : undefined;
    // Keep homogeneity when the next copy is spelled `[a]` instead of `a`.
    const sameAsNext =
      prefix.nextAtom !== undefined &&
      suffixAtom !== undefined &&
      sameSingleCharAtom(suffixAtom, prefix.nextAtom);
    const homogeneous =
      sameAsNext && (prefix.unknownTailHomogeneous === true || prefix.unknownTail !== true);
    return withNextAtom(kept, false, prefix.nextAtom, true, homogeneous);
  }
  const fromSuffix = room < suffix.atoms.length;
  const unknownTail =
    suffix.unknownTail === true ||
    (fromSuffix && (!suffix.complete || suffix.atoms.length - room > 1));
  return withNextAtom(
    kept,
    false,
    fromSuffix ? suffix.atoms[room] : suffix.nextAtom,
    unknownTail,
    unknownTail && fromSuffix && omittedTailIsHomogeneous(suffix, room),
  );
}

const PLAIN_LITERAL_META = new Set([
  ".",
  "*",
  "+",
  "?",
  "{",
  "}",
  "[",
  "]",
  "(",
  ")",
  "|",
  "^",
  "$",
  "\\",
]);

function splitTopLevelPlain(source: string): string[] | null {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < source.length; index += 1) {
    const ch = source[index];
    if (ch === "\\") {
      index += 1;
      if (index >= source.length) {
        return null;
      }
      continue;
    }
    if (ch === "(") {
      depth += 1;
      continue;
    }
    if (ch === ")") {
      depth -= 1;
      if (depth < 0) {
        return null;
      }
      continue;
    }
    if (ch === "|" && depth === 0) {
      parts.push(source.slice(start, index));
      start = index + 1;
    }
  }
  if (depth !== 0) {
    return null;
  }
  parts.push(source.slice(start));
  return parts;
}

function unwrapOneGroup(source: string): string | null {
  if (!source.startsWith("(") || !source.endsWith(")")) {
    return null;
  }
  let depth = 0;
  for (let index = 0; index < source.length; index += 1) {
    const ch = source[index];
    if (ch === "\\") {
      index += 1;
      continue;
    }
    if (ch === "(") {
      depth += 1;
      continue;
    }
    if (ch === ")") {
      depth -= 1;
      if (depth === 0 && index !== source.length - 1) {
        return null;
      }
    }
  }
  if (depth !== 0) {
    return null;
  }
  let inner = source.slice(1, -1);
  if (inner.startsWith("?:")) {
    inner = inner.slice(2);
  } else if (inner.startsWith("?")) {
    return null;
  }
  return inner;
}

function readSingleCharClass(source: string, start: number): { char: string; end: number } | null {
  if (source[start] !== "[") {
    return null;
  }
  let end = -1;
  for (let cursor = start + 1; cursor < source.length; cursor += 1) {
    if (source[cursor] === "\\") {
      cursor += 1;
      continue;
    }
    if (source[cursor] === "]") {
      end = cursor;
      break;
    }
  }
  if (end < 0) {
    return null;
  }
  const char = singleCharLanguage(source.slice(start, end + 1));
  return char === null ? null : { char, end: end + 1 };
}

function readPlainLiteral(source: string): string | null {
  let literal = "";
  for (let index = 0; index < source.length; index += 1) {
    const ch = source[index];
    if (ch === undefined) {
      return null;
    }
    if (ch === "\\") {
      const escaped = source[index + 1];
      if (escaped === undefined || /[0-9A-Za-z]/.test(escaped)) {
        return null;
      }
      literal += escaped;
      index += 1;
      continue;
    }
    if (ch === "[") {
      const single = readSingleCharClass(source, index);
      if (single === null) {
        return null;
      }
      literal += single.char;
      index = single.end - 1;
      continue;
    }
    if (PLAIN_LITERAL_META.has(ch)) {
      return null;
    }
    literal += ch;
  }
  return literal.length > 0 ? literal : null;
}

/**
 * True when one alternative is the other plus a non-empty continuation.
 * Atom truncation hides the second copy of `[a]ba...|[a]ba...[a]ba...`, but the
 * source text still shows that one language is a prefix of the other.
 */
export function alternativeSourcesHavePrefixOverlap(left: string, right: string): boolean {
  return (
    (left.length > 0 && right.length > left.length && right.startsWith(left)) ||
    (right.length > 0 && left.length > right.length && left.startsWith(right))
  );
}

function collectPlainLiterals(source: string, depth: number): string[] | null {
  if (depth > 3) {
    return null;
  }
  const parts = splitTopLevelPlain(source);
  if (!parts || parts.length === 0 || parts.some((part) => part.length === 0)) {
    return null;
  }
  if (parts.length === 1) {
    const only = parts[0];
    if (only === undefined) {
      return null;
    }
    const unwrapped = unwrapOneGroup(only);
    if (unwrapped !== null) {
      return collectPlainLiterals(unwrapped, depth + 1);
    }
    const literal = readPlainLiteral(only);
    return literal === null ? null : [literal];
  }
  const literals: string[] = [];
  for (const part of parts) {
    const nested = collectPlainLiterals(part, depth + 1);
    if (!nested) {
      return null;
    }
    literals.push(...nested);
  }
  return literals;
}

function foldPlainLiteral(literal: string, ignoreCase: boolean): string | null {
  if (!ignoreCase) {
    return literal;
  }
  for (let index = 0; index < literal.length; index += 1) {
    if (literal.charCodeAt(index) > 0x7f) {
      return null;
    }
  }
  return literal.toLowerCase();
}

/**
 * True only when both sides enumerate to the same width of plain literals
 * and none of those strings repeat. With ignoreCase, ASCII letters fold
 * before that check. A non-ASCII literal stays unproven. Expansion overflow
 * is not overlap for that code. Anything else stays unproven.
 */
export function fixedWidthLiteralAlternativesAreDisjoint(
  left: string,
  right: string,
  ignoreCase = false,
): boolean {
  const leftLiterals = collectPlainLiterals(left, 0);
  const rightLiterals = collectPlainLiterals(right, 0);
  if (!leftLiterals || !rightLiterals) {
    return false;
  }
  const folded: string[] = [];
  for (const literal of [...leftLiterals, ...rightLiterals]) {
    const next = foldPlainLiteral(literal, ignoreCase);
    if (next === null) {
      return false;
    }
    folded.push(next);
  }
  if (folded.length === 0 || folded.length > 64) {
    return false;
  }
  const width = folded[0]?.length ?? 0;
  if (width === 0 || folded.some((literal) => literal.length !== width)) {
    return false;
  }
  return new Set(folded).size === folded.length;
}

export function cartesianConcatSequences(
  left: readonly AtomSequence[],
  right: readonly AtomSequence[],
): AtomSequence[] | typeof ATOM_SEQUENCE_OVERFLOW {
  if (left.length === 0) {
    return right.map(cloneAtomSequence);
  }
  if (right.length === 0) {
    return left.map(cloneAtomSequence);
  }
  if (left.length * right.length > MAX_ALTERNATIVE_SEQUENCES) {
    return ATOM_SEQUENCE_OVERFLOW;
  }
  const out: AtomSequence[] = [];
  for (const prefix of left) {
    for (const suffix of right) {
      out.push(concatAtomSequence(prefix, suffix));
    }
  }
  return out;
}
