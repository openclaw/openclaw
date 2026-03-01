import { escapeRegExp } from "../utils.js";

export const HEARTBEAT_TOKEN = "HEARTBEAT_OK";
export const SILENT_REPLY_TOKEN = "NO_REPLY";

/**
 * Prefix token for agent internal reasoning blocks.
 * Text starting with `[THINK]` is stripped before delivery to chat channels,
 * allowing agents to include chain-of-thought reasoning that is silently suppressed.
 *
 * Supports an optional closing `[/THINK]` tag:
 * - `[THINK] reasoning` → entire text suppressed
 * - `[THINK] reasoning [/THINK] actual reply` → only "actual reply" is delivered
 * - `[THINK] reasoning [/THINK]` (nothing after) → suppressed
 */
export const THINK_PREFIX = "[THINK]";
export const THINK_CLOSE = "[/THINK]";

/**
 * Strips `[THINK]...[/THINK]` blocks from the beginning of text.
 *
 * - If the text starts with `[THINK]` and contains a closing `[/THINK]`,
 *   everything between (inclusive) is removed and the remainder is returned.
 * - If the text starts with `[THINK]` but has no closing tag, the entire
 *   text is considered internal reasoning and is stripped completely.
 * - The check is case-insensitive and ignores leading whitespace.
 *
 * @param text  The raw reply text to process.
 * @returns An object with the cleaned text and whether a think prefix was found.
 */
export function stripThinkPrefix(text: string): { text: string; hadThinkPrefix: boolean } {
  const trimmed = text.trimStart();
  const upper = trimmed.toUpperCase();

  if (!upper.startsWith(THINK_PREFIX)) {
    return { text, hadThinkPrefix: false };
  }

  // Look for the closing tag (case-insensitive)
  const closeIdx = upper.indexOf(THINK_CLOSE);
  if (closeIdx === -1) {
    // No closing tag — the entire text is think content
    return { text: "", hadThinkPrefix: true };
  }

  // Strip everything from start through the closing tag
  const afterClose = trimmed.slice(closeIdx + THINK_CLOSE.length).trim();
  return { text: afterClose, hadThinkPrefix: true };
}

export function isSilentReplyText(
  text: string | undefined,
  token: string = SILENT_REPLY_TOKEN,
): boolean {
  if (!text) {
    return false;
  }
  const escaped = escapeRegExp(token);
  // Match only the exact silent token with optional surrounding whitespace.
  // This prevents
  // substantive replies ending with NO_REPLY from being suppressed (#19537).
  return new RegExp(`^\\s*${escaped}\\s*$`).test(text);
}

export function isSilentReplyPrefixText(
  text: string | undefined,
  token: string = SILENT_REPLY_TOKEN,
): boolean {
  if (!text) {
    return false;
  }
  const normalized = text.trimStart().toUpperCase();
  if (!normalized) {
    return false;
  }
  if (!normalized.includes("_")) {
    return false;
  }
  if (/[^A-Z_]/.test(normalized)) {
    return false;
  }
  return token.toUpperCase().startsWith(normalized);
}
