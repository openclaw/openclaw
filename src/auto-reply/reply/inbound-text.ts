import { wrapExternalContent } from "../../security/external-content.js";

/**
 * Non-channel providers that should not receive external content wrapping.
 * CLI, node SDK, and internal event sources are trusted input surfaces.
 */
const TRUSTED_PROVIDERS = new Set(["node", "cli", "exec-event"]);

/**
 * Returns true when the provider string indicates an external messaging channel
 * (Telegram, Discord, WhatsApp, etc.) whose message body should be treated as
 * untrusted external content.
 */
export function isExternalChannelProvider(provider: string | undefined): boolean {
  if (!provider) {
    return false;
  }
  return !TRUSTED_PROVIDERS.has(provider.toLowerCase());
}

/**
 * Wraps a channel message body with external content security boundaries.
 *
 * Channel messages arrive from untrusted external users and should receive
 * the same wrapExternalContent treatment that hooks/gmail/webhooks already get.
 * The body is first sanitized for system-tag spoofing, then wrapped with
 * random-ID boundary markers and a security notice.
 */
export function wrapChannelMessageBody(body: string, provider: string): string {
  if (!body.trim()) {
    return body;
  }
  return wrapExternalContent(sanitizeInboundSystemTags(body), {
    source: "channel",
    sender: provider,
    includeWarning: true,
  });
}

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
