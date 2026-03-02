type QuantifierRead = {
  consumed: number;
  minRepeat: number;
  maxRepeat: number | null;
};

type TokenState = {
  containsRepetition: boolean;
  hasAmbiguousAlternation: boolean;
  minLength: number;
  maxLength: number;
};

type ParseFrame = {
  lastToken: TokenState | null;
  containsRepetition: boolean;
  hasAlternation: boolean;
  branchMinLength: number;
  branchMaxLength: number;
  altMinLength: number | null;
  altMaxLength: number | null;
};

const SAFE_REGEX_CACHE_MAX = 256;
const safeRegexCache = new Map<string, RegExp | null>();

function createParseFrame(): ParseFrame {
  return {
    lastToken: null,
    containsRepetition: false,
    hasAlternation: false,
    branchMinLength: 0,
    branchMaxLength: 0,
    altMinLength: null,
    altMaxLength: null,
  };
}

function addLength(left: number, right: number): number {
  if (!Number.isFinite(left) || !Number.isFinite(right)) {
    return Number.POSITIVE_INFINITY;
  }
  return left + right;
}

function multiplyLength(length: number, factor: number): number {
  if (!Number.isFinite(length)) {
    return factor === 0 ? 0 : Number.POSITIVE_INFINITY;
  }
  return length * factor;
}

function recordAlternative(frame: ParseFrame): void {
  if (frame.altMinLength === null || frame.altMaxLength === null) {
    frame.altMinLength = frame.branchMinLength;
    frame.altMaxLength = frame.branchMaxLength;
    return;
  }
  frame.altMinLength = Math.min(frame.altMinLength, frame.branchMinLength);
  frame.altMaxLength = Math.max(frame.altMaxLength, frame.branchMaxLength);
}

export function hasNestedRepetition(source: string): boolean {
  // Conservative parser: reject patterns where a repeated token/group is repeated again.
  const frames: ParseFrame[] = [createParseFrame()];
  let inCharClass = false;

  const emitToken = (token: TokenState) => {
    const frame = frames[frames.length - 1];
    frame.lastToken = token;
    if (token.containsRepetition) {
      frame.containsRepetition = true;
    }
    frame.branchMinLength = addLength(frame.branchMinLength, token.minLength);
    frame.branchMaxLength = addLength(frame.branchMaxLength, token.maxLength);
  };

  const emitSimpleToken = () => {
    emitToken({
      containsRepetition: false,
      hasAmbiguousAlternation: false,
      minLength: 1,
      maxLength: 1,
    });
  };

  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];

    if (ch === "\\") {
      i += 1;
      emitSimpleToken();
      continue;
    }

    if (inCharClass) {
      if (ch === "]") {
        inCharClass = false;
      }
      continue;
    }

    if (ch === "[") {
      inCharClass = true;
      emitSimpleToken();
      continue;
    }

    if (ch === "(") {
      frames.push(createParseFrame());
      continue;
    }

    if (ch === ")") {
      if (frames.length > 1) {
        const frame = frames.pop() as ParseFrame;
        if (frame.hasAlternation) {
          recordAlternative(frame);
        }
        const groupMinLength = frame.hasAlternation
          ? (frame.altMinLength ?? 0)
          : frame.branchMinLength;
        const groupMaxLength = frame.hasAlternation
          ? (frame.altMaxLength ?? 0)
          : frame.branchMaxLength;
        emitToken({
          containsRepetition: frame.containsRepetition,
          hasAmbiguousAlternation:
            frame.hasAlternation &&
            frame.altMinLength !== null &&
            frame.altMaxLength !== null &&
            frame.altMinLength !== frame.altMaxLength,
          minLength: groupMinLength,
          maxLength: groupMaxLength,
        });
      }
      continue;
    }

    if (ch === "|") {
      const frame = frames[frames.length - 1];
      frame.hasAlternation = true;
      recordAlternative(frame);
      frame.branchMinLength = 0;
      frame.branchMaxLength = 0;
      frame.lastToken = null;
      continue;
    }

    const quantifier = readQuantifier(source, i);
    if (quantifier) {
      const frame = frames[frames.length - 1];
      const token = frame.lastToken;
      if (!token) {
        continue;
      }
      if (token.containsRepetition) {
        return true;
      }
      if (token.hasAmbiguousAlternation && quantifier.maxRepeat === null) {
        return true;
      }

      const previousMinLength = token.minLength;
      const previousMaxLength = token.maxLength;
      token.minLength = multiplyLength(token.minLength, quantifier.minRepeat);
      token.maxLength =
        quantifier.maxRepeat === null
          ? Number.POSITIVE_INFINITY
          : multiplyLength(token.maxLength, quantifier.maxRepeat);
      token.containsRepetition = true;
      frame.containsRepetition = true;
      frame.branchMinLength = frame.branchMinLength - previousMinLength + token.minLength;

      const branchMaxBase =
        Number.isFinite(frame.branchMaxLength) && Number.isFinite(previousMaxLength)
          ? frame.branchMaxLength - previousMaxLength
          : Number.POSITIVE_INFINITY;
      frame.branchMaxLength = addLength(branchMaxBase, token.maxLength);

      i += quantifier.consumed - 1;
      continue;
    }

    emitSimpleToken();
  }

  return false;
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
  while (i < source.length && /\d/.test(source[i])) {
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
    while (i < source.length && /\d/.test(source[i])) {
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

export function compileSafeRegex(source: string, flags = ""): RegExp | null {
  const trimmed = source.trim();
  if (!trimmed) {
    return null;
  }
  const cacheKey = `${flags}::${trimmed}`;
  if (safeRegexCache.has(cacheKey)) {
    return safeRegexCache.get(cacheKey) ?? null;
  }

  let compiled: RegExp | null = null;
  if (!hasNestedRepetition(trimmed)) {
    try {
      compiled = new RegExp(trimmed, flags);
    } catch {
      compiled = null;
    }
  }

  safeRegexCache.set(cacheKey, compiled);
  if (safeRegexCache.size > SAFE_REGEX_CACHE_MAX) {
    const oldestKey = safeRegexCache.keys().next().value;
    if (oldestKey) {
      safeRegexCache.delete(oldestKey);
    }
  }
  return compiled;
}
