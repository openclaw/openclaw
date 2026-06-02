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
  for (let i = 0; i <= normalizedBootPrompt.length - minLen; i += 1) {
    chunks.add(normalizedBootPrompt.slice(i, i + minLen));
  }
  chunksByLength.set(minLen, chunks);
  return chunks;
}

/**
 * Register the active boot prompt for user-visible send guards on this session.
 *
 * The marker-based internal-context strip only catches delimiter-preserving
 * echoes; this context lets delivery paths suppress long raw BOOT.md excerpts.
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

/** Clear boot echo state when a boot run finishes or a session is discarded. */
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

/** Return the active boot prompt text for delivery paths that need echo suppression. */
export function getBootEchoContextForSession(sessionKey: string | undefined): string | undefined {
  if (!sessionKey) {
    return undefined;
  }
  return bootContextBySessionKey.get(sessionKey)?.bootPrompt;
}

/**
 * Returns true if `outboundText` contains a contiguous substring of
 * `bootPrompt` of at least `minLen` characters, ignoring leading/trailing
 * whitespace on the boot prompt itself. Short boot prompts (< minLen chars)
 * never trigger to avoid suppressing legitimate short BOOT.md-directed
 * sends like a literal "good morning".
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
 * Removes any user-supplied outbound text that substantially echoes the
 * active boot prompt. Returns an empty string when an echo is detected so
 * the caller can either drop the send entirely or treat the outbound text
 * as empty. The boot prompt itself is unchanged.
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

/** Reset module-local boot echo caches between tests. */
export function resetBootEchoContextForTests(): void {
  bootContextBySessionKey.clear();
  bootChunksByNormalizedPrompt.clear();
}
