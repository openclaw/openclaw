// Suppress substantial boot-prompt echoes even when the model omits the
// internal-runtime-context delimiters that normally keep BOOT.md private.

import { sliceUtf16Safe } from "@openclaw/normalization-core/utf16-slice";

const MIN_ECHO_CHARS = 80;
const ECHO_WINDOW_LENGTHS = [MIN_ECHO_CHARS, MIN_ECHO_CHARS + 1];

function* echoWindows(input: string) {
  for (let start = 0; start <= input.length - MIN_ECHO_CHARS; start++) {
    for (const length of ECHO_WINDOW_LENGTHS) {
      const window = sliceUtf16Safe(input, start, start + length);
      if (window.length === length) {
        yield window;
      }
    }
  }
}

type BootEchoContext = {
  bootPrompt: string;
  normalizedBootPrompt: string;
};

const bootContextBySessionKey = new Map<string, BootEchoContext>();
const bootChunksByNormalizedPrompt = new Map<string, Set<string>>();

function normalizeEchoComparisonText(text: string): string {
  return text.replace(/\s+/gu, " ").trim();
}

function getBootPromptChunks(normalizedBootPrompt: string): Set<string> {
  const cached = bootChunksByNormalizedPrompt.get(normalizedBootPrompt);
  if (cached) {
    return cached;
  }
  const chunks = new Set(echoWindows(normalizedBootPrompt));
  bootChunksByNormalizedPrompt.set(normalizedBootPrompt, chunks);
  return chunks;
}

export function setBootEchoContextForSession(sessionKey: string, bootPrompt: string): void {
  if (!sessionKey || !bootPrompt) {
    return;
  }
  const normalizedBootPrompt = normalizeEchoComparisonText(bootPrompt);
  bootContextBySessionKey.set(sessionKey, { bootPrompt, normalizedBootPrompt });
}

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
  const bootChunks = getBootPromptChunks(needle);
  for (const chunk of echoWindows(haystack)) {
    if (bootChunks.has(chunk)) {
      return true;
    }
  }
  return false;
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
