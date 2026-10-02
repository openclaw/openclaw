// Suppress substantial boot-prompt echoes even when the model omits the
// internal-runtime-context delimiters that normally keep BOOT.md private.

import { sliceUtf16Safe } from "@openclaw/normalization-core/utf16-slice";

const MIN_ECHO_CHARS = 80;

function sliceEchoWindow(input: string, start: number, length: number): string | undefined {
  const window = sliceUtf16Safe(input, start, start + length);
  return window.length === length ? window : undefined;
}

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
    const chunk = sliceEchoWindow(normalizedBootPrompt, i, minLen);
    if (chunk) {
      chunks.add(chunk);
    }
  }
  chunksByLength.set(minLen, chunks);
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
function containsSubstantialBootEcho(
  outboundText: string,
  bootPrompt: string,
  minLen: number = MIN_ECHO_CHARS,
): boolean {
  const haystack = normalizeEchoComparisonText(outboundText ?? "");
  if (haystack.length < minLen) {
    return false;
  }
  const needle = normalizeEchoComparisonText(bootPrompt ?? "");
  if (needle.length < minLen) {
    return false;
  }
  const bootChunks = getBootPromptChunks(needle, minLen);
  const nextBootChunks = getBootPromptChunks(needle, minLen + 1);
  for (let i = 0; i <= haystack.length - minLen; i += 1) {
    const chunk = sliceEchoWindow(haystack, i, minLen);
    const nextChunk = sliceEchoWindow(haystack, i, minLen + 1);
    if ((chunk && bootChunks.has(chunk)) || (nextChunk && nextBootChunks.has(nextChunk))) {
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
