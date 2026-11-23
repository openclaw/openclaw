// Suppress substantial boot-prompt echoes even when the model omits the
// internal-runtime-context delimiters that normally keep BOOT.md private.

const MIN_ECHO_CHARS = 80;
const ECHO_WINDOW_LENGTHS = [MIN_ECHO_CHARS, MIN_ECHO_CHARS + 1];
// Two wrapping 32-bit polynomial hashes; the first and 20 bits of the second
// pack exactly into one double. Hash hits are always confirmed by exact search.
const HASH_BASES = [0x01000193, 0x5bd1e995] as const;
const SECOND_HASH_BITS = 2 ** 20;
const SURROGATE_CODE_UNIT = /[\uD800-\uDFFF]/;

function isHighSurrogate(codeUnit: number): boolean {
  return codeUnit >= 0xd800 && codeUnit <= 0xdbff;
}

function isLowSurrogate(codeUnit: number): boolean {
  return codeUnit >= 0xdc00 && codeUnit <= 0xdfff;
}

// Matches sliceUtf16Safe: an echo window never starts or ends inside a surrogate pair.
function isWindowEdge(text: string, index: number): boolean {
  return (
    index === 0 ||
    index >= text.length ||
    !(isHighSurrogate(text.charCodeAt(index - 1)) && isLowSurrogate(text.charCodeAt(index)))
  );
}

function includesSafeWindow(text: string, window: string): boolean {
  for (let start = text.indexOf(window); start >= 0; start = text.indexOf(window, start + 1)) {
    if (isWindowEdge(text, start) && isWindowEdge(text, start + window.length)) {
      return true;
    }
  }
  return false;
}

/** Visits each surrogate-safe window hash in O(text.length) time; stops when visit returns true. */
function someWindowHash(
  text: string,
  length: number,
  visit: (start: number, hash: number) => boolean,
): boolean {
  if (text.length < length) {
    return false;
  }
  const [b1, b2] = HASH_BASES;
  let h1 = 0;
  let h2 = 0;
  let p1 = 1;
  let p2 = 1;
  for (let index = 0; index < length; index++) {
    const code = text.charCodeAt(index);
    h1 = (Math.imul(h1, b1) + code) | 0;
    h2 = (Math.imul(h2, b2) + code) | 0;
    if (index > 0) {
      p1 = Math.imul(p1, b1);
      p2 = Math.imul(p2, b2);
    }
  }
  for (let start = 0; ; start++) {
    const end = start + length;
    if (
      isWindowEdge(text, start) &&
      isWindowEdge(text, end) &&
      visit(start, (h1 >>> 0) * SECOND_HASH_BITS + (h2 & (SECOND_HASH_BITS - 1)))
    ) {
      return true;
    }
    if (end >= text.length) {
      return false;
    }
    const removed = text.charCodeAt(start);
    const added = text.charCodeAt(end);
    h1 = (Math.imul((h1 - Math.imul(removed, p1)) | 0, b1) + added) | 0;
    h2 = (Math.imul((h2 - Math.imul(removed, p2)) | 0, b2) + added) | 0;
  }
}

function hasSortedHash(hashes: Float64Array, hash: number): boolean {
  let low = 0;
  let high = hashes.length - 1;
  while (low <= high) {
    const mid = (low + high) >>> 1;
    const value = hashes[mid];
    if (value === hash) {
      return true;
    }
    if (value !== undefined && value < hash) {
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return false;
}

// Memory stays proportional to the shorter text: its window hashes go into one
// typed array (no Set size limit), and hash hits are confirmed by exact search.
function sharesEchoWindow(first: string, second: string): boolean {
  const [shorter, longer] = first.length <= second.length ? [first, second] : [second, first];
  // Without surrogates in the shorter text, every shared 81-unit window starts with a
  // shared 80-unit window at safe edges, so the second scan of the longer text is redundant.
  const lengths = SURROGATE_CODE_UNIT.test(shorter) ? ECHO_WINDOW_LENGTHS : [MIN_ECHO_CHARS];
  return lengths.some((length) => {
    const hashes = new Float64Array(Math.max(shorter.length - length + 1, 0));
    let count = 0;
    someWindowHash(shorter, length, (_start, hash) => {
      hashes[count++] = hash;
      return false;
    });
    const sorted = hashes.subarray(0, count).toSorted();
    return someWindowHash(
      longer,
      length,
      (start, hash) =>
        hasSortedHash(sorted, hash) &&
        includesSafeWindow(shorter, longer.slice(start, start + length)),
    );
  });
}

type BootEchoContext = {
  bootPrompt: string;
};

const bootContextBySessionKey = new Map<string, BootEchoContext>();

function normalizeEchoComparisonText(text: string): string {
  return text.replace(/\s+/gu, " ").trim();
}

export function setBootEchoContextForSession(sessionKey: string, bootPrompt: string): void {
  if (!sessionKey || !bootPrompt) {
    return;
  }
  bootContextBySessionKey.set(sessionKey, { bootPrompt });
}

export function clearBootEchoContextForSession(sessionKey: string): void {
  if (!sessionKey) {
    return;
  }
  bootContextBySessionKey.delete(sessionKey);
}

export function getBootEchoContextForSession(sessionKey: string | undefined): string | undefined {
  if (!sessionKey) {
    return undefined;
  }
  return bootContextBySessionKey.get(sessionKey)?.bootPrompt;
}

// Short prompts never suppress legitimate BOOT.md-directed sends such as "good morning".
function containsSubstantialBootEcho(outboundText: string, bootPrompt: string): boolean {
  const haystack = normalizeEchoComparisonText(outboundText);
  if (haystack.length < MIN_ECHO_CHARS) {
    return false;
  }
  const needle = normalizeEchoComparisonText(bootPrompt);
  if (needle.length < MIN_ECHO_CHARS) {
    return false;
  }
  return sharesEchoWindow(haystack, needle);
}

/** Empty output lets the delivery owner discard substantial boot-prompt echoes. */
export function stripBootEchoFromOutboundText(
  outboundText: string,
  bootPrompt: string | undefined,
): string {
  if (!bootPrompt) {
    return outboundText;
  }
  return containsSubstantialBootEcho(outboundText, bootPrompt) ? "" : outboundText;
}
