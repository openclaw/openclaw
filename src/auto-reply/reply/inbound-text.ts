export function normalizeInboundTextNewlines(input: string): string {
  // Normalize actual newline characters (CR+LF and CR to LF).
  // Do NOT replace literal backslash-n sequences (\\n) as they may be part of
  // Windows paths like C:\Work\nxxx\README.md or user-intended escape sequences.
  return input.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
}

const BRACKETED_SYSTEM_TAG_RE = /\[\s*(System\s*Message|System|Assistant|Internal)\s*\]/gi;
const LINE_SYSTEM_PREFIX_RE = /^(\s*)System:(?=\s|$)/gim;

/**
 * Neutralize user-controlled strings that spoof internal system markers.
 */
export function sanitizeInboundSystemTags(input: string): string {
  return input
    .replace(BRACKETED_SYSTEM_TAG_RE, (_match, tag: string) => `(${tag})`)
    .replace(LINE_SYSTEM_PREFIX_RE, "$1System (untrusted):");
}
