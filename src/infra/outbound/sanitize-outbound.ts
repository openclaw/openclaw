import crypto from "node:crypto";
import { logWarn } from "../../logger.js";

/**
 * Blocklist patterns for internal/system text that must never reach end users.
 * Each entry has a label (for logging) and a regex.
 */
const OUTBOUND_BLOCKLIST: Array<{ label: string; pattern: RegExp }> = [
  { label: "reasoning_en", pattern: /^Reasoning:\s.*/gm },
  { label: "reasoning_zh", pattern: /^推理:\s.*/gm },
  { label: "thinking_zh", pattern: /^思考:\s.*/gm },
  { label: "thinking_tag", pattern: /<thinking>[\s\S]*?<\/thinking>/g },
  { label: "tool_call", pattern: /^Tool call:\s.*/gm },
  { label: "internal_bracket", pattern: /^\[internal\].*/gim },
  { label: "system_bracket", pattern: /^\[system\]\s.*/gim },
  { label: "tool_use_tag", pattern: /<tool_use>[\s\S]*?<\/tool_use>/g },
  { label: "tool_code_fence", pattern: /^```tool_code[\s\S]*?^```/gm },
  { label: "scratchpad_tag", pattern: /<scratchpad>[\s\S]*?<\/scratchpad>/g },
  {
    label: "draft_block",
    pattern: /^--- ?(?:draft|internal|debug) ?---[\s\S]*?^--- ?(?:end) ?---/gim,
  },
];

export type SanitizeResult = {
  /** Cleaned text, or null if the entire message was stripped / empty. */
  text: string | null;
  /** Whether any blocklist rule matched. */
  matched: boolean;
  /** Labels of rules that fired. */
  matchedRules: string[];
};

function hashContent(content: string): string {
  return crypto.createHash("sha256").update(content, "utf-8").digest("hex").slice(0, 16);
}

/**
 * Strip internal/system text from outbound messages.
 * Returns cleaned text (or null if nothing remains).
 * Logs a sanitised warning (hash + rule + length) for every match — never the original text.
 */
export function sanitizeOutbound(text: string | undefined | null): SanitizeResult {
  if (text == null || text.length === 0) {
    return { text: null, matched: false, matchedRules: [] };
  }

  let cleaned = text;
  const matchedRules: string[] = [];

  for (const { label, pattern } of OUTBOUND_BLOCKLIST) {
    // Reset lastIndex for stateful (global) regexes.
    pattern.lastIndex = 0;
    const matches = cleaned.match(pattern);
    if (matches && matches.length > 0) {
      for (const m of matches) {
        logWarn(
          JSON.stringify({
            event: "outbound_sanitized",
            ts: Date.now(),
            rule: label,
            matchHash: `sha256:${hashContent(m)}`,
            matchLength: m.length,
            action: "stripped",
          }),
        );
      }
      matchedRules.push(label);
      pattern.lastIndex = 0;
      cleaned = cleaned.replace(pattern, "");
    }
  }

  if (matchedRules.length === 0) {
    return { text, matched: false, matchedRules: [] };
  }

  // Collapse excessive blank lines left by stripping.
  cleaned = cleaned.replace(/\n{3,}/g, "\n\n").trim();

  if (cleaned.length === 0) {
    logWarn(
      JSON.stringify({
        event: "outbound_sanitized",
        ts: Date.now(),
        rule: "full_block",
        matchHash: `sha256:${hashContent(text)}`,
        matchLength: text.length,
        action: "blocked",
      }),
    );
    return { text: null, matched: true, matchedRules };
  }

  return { text: cleaned, matched: true, matchedRules };
}
