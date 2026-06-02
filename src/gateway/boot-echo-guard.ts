const MIN_ECHO_CHARS = 80;

type BootEchoContext = {
  bootPrompt: string;
  normalizedBootPrompt: string;
};

const bootContextBySessionKey = new Map<string, BootEchoContext>();
const bootChunksByNormalizedPrompt = new Map<string, Map<number, Set<string>>>();

function normalizeEchoComparisonText(text: string): string {
  return text.replace(/\s+/gu, " ").trim();
}

function getBootPromptChunks(normalizedBootPrompt: string, minLen: number): Set<string> {
  let chunksByLength = bootChunksByNormalizedPrompt.get(normalizedBootPrompt);
  if (!chunksByLength) {
    chunksByLength = new Map();
    bootChunksByNormalizedPrompt.set(normalizedBootPrompt, chunksByLength);
  }
  const cached = chunksByLength.get(minLen);
  if (cached) {
    return cached;
  }
  const chunks = new Set<string>();
  // Cache fixed-width chunks by prompt and threshold so repeated outbound
  // delivery checks do not rebuild the same BOOT.md comparison window.
  for (let i = 0; i <= normalizedBootPrompt.length - minLen; i += 1) {
    chunks.add(normalizedBootPrompt.slice(i, i + minLen));
  }
  chunksByLength.set(minLen, chunks);
  return chunks;
}

/**
 * Store the active BOOT.md prompt for a session so user-visible send paths can
 * suppress model echoes that no longer contain internal-context delimiters.
 */
export function setBootEchoContextForSession(sessionKey: string, bootPrompt: string): void {
  if (!sessionKey || !bootPrompt) {
    return;
  }
  const normalizedBootPrompt = normalizeEchoComparisonText(bootPrompt);
  if (normalizedBootPrompt.length >= MIN_ECHO_CHARS) {
    getBootPromptChunks(normalizedBootPrompt, MIN_ECHO_CHARS);
  }
  bootContextBySessionKey.set(sessionKey, { bootPrompt, normalizedBootPrompt });
}

/** Clear the active boot-echo context and cached chunks for a finished session. */
export function clearBootEchoContextForSession(sessionKey: string): void {
  if (!sessionKey) {
    return;
  }
  const context = bootContextBySessionKey.get(sessionKey);
  if (context) {
    bootChunksByNormalizedPrompt.delete(context.normalizedBootPrompt);
  }
  bootContextBySessionKey.delete(sessionKey);
}

/** Return the active boot prompt for a session, if one is currently guarded. */
export function getBootEchoContextForSession(sessionKey: string | undefined): string | undefined {
  if (!sessionKey) {
    return undefined;
  }
  return bootContextBySessionKey.get(sessionKey)?.bootPrompt;
}

/**
 * Return true when outbound text copies a long contiguous chunk of the active
 * boot prompt, ignoring whitespace normalization but not fuzzy paraphrases.
 */
export function containsSubstantialBootEcho(
  outboundText: string,
  bootPrompt: string,
  minLen: number = MIN_ECHO_CHARS,
): boolean {
  const haystack = normalizeEchoComparisonText(outboundText ?? "");
  const needle = normalizeEchoComparisonText(bootPrompt ?? "");
  if (haystack.length < minLen || needle.length < minLen) {
    return false;
  }
  const bootChunks = getBootPromptChunks(needle, minLen);
  for (let i = 0; i <= haystack.length - minLen; i += 1) {
    if (bootChunks.has(haystack.slice(i, i + minLen))) {
      return true;
    }
  }
  return false;
}

/**
 * Remove outbound text that substantially echoes the active boot prompt.
 * Returning an empty string lets callers drop the send or treat it as empty.
 */
export function stripBootEchoFromOutboundText(
  outboundText: string,
  bootPrompt: string | undefined,
): string {
  if (!bootPrompt) {
    return outboundText;
  }
  return containsSubstantialBootEcho(outboundText, bootPrompt) ? "" : outboundText;
}

/** Reset boot-echo state between tests that share the module singleton. */
export function resetBootEchoContextForTests(): void {
  bootContextBySessionKey.clear();
  bootChunksByNormalizedPrompt.clear();
}
