type QuantifierRead = {
  consumed: number;
};

type TokenState = {
  containsRepetition: boolean;
};

type ParseFrame = {
  lastToken: TokenState | null;
  containsRepetition: boolean;
};

const SAFE_REGEX_CACHE_MAX = 256;
const safeRegexCache = new Map<string, RegExp | null>();

export function hasNestedRepetition(source: string): boolean {
  // Conservative parser: reject patterns where a repeated token/group is repeated again.
  const frames: ParseFrame[] = [{ lastToken: null, containsRepetition: false }];
  let inCharClass = false;

  const emitToken = (token: TokenState) => {
    const frame = frames[frames.length - 1];
    frame.lastToken = token;
    if (token.containsRepetition) {
      frame.containsRepetition = true;
    }
  };

  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];

    if (ch === "\\") {
      i += 1;
      emitToken({ containsRepetition: false });
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
      emitToken({ containsRepetition: false });
      continue;
    }

    if (ch === "(") {
      frames.push({ lastToken: null, containsRepetition: false });
      continue;
    }

    if (ch === ")") {
      if (frames.length > 1) {
        const frame = frames.pop() as ParseFrame;
        emitToken({ containsRepetition: frame.containsRepetition });
      }
      continue;
    }

    if (ch === "|") {
      const frame = frames[frames.length - 1];
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
      token.containsRepetition = true;
      frame.containsRepetition = true;
      i += quantifier.consumed - 1;
      continue;
    }

    emitToken({ containsRepetition: false });
  }

  return false;
}

function readQuantifier(source: string, index: number): QuantifierRead | null {
  const ch = source[index];
  if (ch === "*" || ch === "+" || ch === "?") {
    return { consumed: source[index + 1] === "?" ? 2 : 1 };
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
  if (source[i] === ",") {
    i += 1;
    while (i < source.length && /\d/.test(source[i])) {
      i += 1;
    }
  }
  if (source[i] !== "}") {
    return null;
  }
  i += 1;
  if (source[i] === "?") {
    i += 1;
  }
  return { consumed: i - index };
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
