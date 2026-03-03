import { escapeRegExp } from "../utils.js";

export const HEARTBEAT_TOKEN = "HEARTBEAT_OK";
export const SILENT_REPLY_TOKEN = "NO_REPLY";

/**
 * Prefix token for agent internal reasoning blocks.
 * Text starting with `[THINK]` or `[THINKING]` is stripped before delivery to
 * chat channels, allowing agents to include chain-of-thought reasoning that is
 * silently suppressed.
 *
 * Supports optional closing tags `[/THINK]` or `[/THINKING]`:
 * - `[THINK] reasoning` → entire text suppressed
 * - `[THINKING] reasoning` → entire text suppressed
 * - `[THINK] reasoning [/THINK] actual reply` → only "actual reply" is delivered
 * - `[THINKING] reasoning [/THINKING] actual reply` → only "actual reply" is delivered
 * - `[THINK] reasoning [/THINK]` (nothing after) → suppressed
 */
export const THINK_PREFIX = "[THINK]";
export const THINK_CLOSE = "[/THINK]";

/**
 * Regex matching `[THINK]` or `[THINKING]` at the start (case-insensitive).
 * Captures the variant so the matching closing tag can be derived.
 */
const THINK_OPEN_RE = /^\[THINK(?:ING)?\]/i;

/**
 * Regex for finding a closing `[/THINK]` or `[/THINKING]` tag (case-insensitive).
 * Built dynamically from the matched open tag to ensure the variants pair correctly.
 */
function buildCloseTagRegex(openTag: string): RegExp {
  // openTag is e.g. "[THINK]" or "[THINKING]" — derive "[/THINK]" or "[/THINKING]"
  const closeTag = `[/${openTag.slice(1)}`;
  return new RegExp(closeTag.replace(/[[\]]/g, "\\$&"), "i");
}

/**
 * Strips `[THINK]...[/THINK]` or `[THINKING]...[/THINKING]` blocks from the
 * beginning of text. Handles multiple consecutive think blocks.
 *
 * - If the text starts with `[THINK]` or `[THINKING]` and contains a matching
 *   closing tag, everything between (inclusive) is removed and the remainder
 *   is processed for additional think blocks.
 * - If the text starts with a think tag but has no closing tag, the entire
 *   text is considered internal reasoning and is stripped completely.
 * - The check is case-insensitive and ignores leading whitespace.
 *
 * @param text  The raw reply text to process.
 * @returns An object with the cleaned text and whether a think prefix was found.
 */
export function stripThinkPrefix(text: string): { text: string; hadThinkPrefix: boolean } {
  let current = text.trimStart();
  let hadThinkPrefix = false;

  // Loop to strip consecutive think blocks (e.g. [THINK]...[/THINK] [THINK]...[/THINK] reply)
  let match = THINK_OPEN_RE.exec(current);
  while (match) {
    hadThinkPrefix = true;
    const openTag = match[0];
    const closeRe = buildCloseTagRegex(openTag);

    // Search for closing tag after the open tag — using regex avoids
    // the Unicode toUpperCase length-mismatch problem (e.g. ß → SS).
    const searchFrom = current.slice(openTag.length);
    const closeMatch = closeRe.exec(searchFrom);

    if (!closeMatch) {
      // No closing tag — the entire remaining text is think content
      return { text: "", hadThinkPrefix: true };
    }

    // Strip everything from start through the closing tag
    const afterClose = searchFrom.slice(closeMatch.index + closeMatch[0].length).trimStart();
    current = afterClose;
    match = THINK_OPEN_RE.exec(current);
  }

  if (!hadThinkPrefix) {
    return { text, hadThinkPrefix: false };
  }

  return { text: current, hadThinkPrefix: true };
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
