// Boot-run echo guard: tracks the active boot prompt per session key so that
// downstream user-visible delivery paths (currently the message tool) can
// suppress fallback-model echoes that copy substantial portions of the boot
// prompt without preserving the internal-runtime-context delimiters.
//
// The marker-based strip in `stripInternalRuntimeContext` only catches
// echoes that include the delimiter lines verbatim. A model that paraphrases
// out the wrapper but reproduces a long contiguous chunk of the BOOT.md
// content would slip past the marker strip and reach the user. This module
// adds a defense-in-depth substantial-echo check using the active boot prompt
// as the comparison source. Refs #53732.

const MIN_ECHO_CHARS = 80;

const bootContextBySessionKey = new Map<string, string>();

export function setBootEchoContextForSession(sessionKey: string, bootPrompt: string): void {
  if (!sessionKey || !bootPrompt) {
    return;
  }
  bootContextBySessionKey.set(sessionKey, bootPrompt);
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
  return bootContextBySessionKey.get(sessionKey);
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
  const haystack = outboundText ?? "";
  const needle = (bootPrompt ?? "").trim();
  if (haystack.length < minLen || needle.length < minLen) {
    return false;
  }
  for (let i = 0; i <= needle.length - minLen; i += 1) {
    const chunk = needle.slice(i, i + minLen);
    if (haystack.includes(chunk)) {
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

export function resetBootEchoContextForTests(): void {
  bootContextBySessionKey.clear();
}
