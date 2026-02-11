/**
 * Heimdall Security Layer — Output Filter
 *
 * Scans outbound text for secrets (API keys, tokens, credentials)
 * and replaces them with `[REDACTED:<pattern name>]` placeholders.
 *
 * Built-in patterns cover common providers (OpenAI, GitHub, AWS).
 * Users can supply additional patterns via OutputFilterConfig.customPatterns.
 */

import type {
  OutputFilterConfig,
  OutputFilterPattern,
  RedactionMatch,
  RedactionResult,
} from "./types.js";
import { DEPLOYMENT_PATTERNS } from "./patterns.js";

export const BUILTIN_PATTERNS: OutputFilterPattern[] = [
  { name: "OpenAI API Key", regex: "sk-[a-zA-Z0-9_\\-]{20,}", flags: "g" },
  { name: "GitHub PAT", regex: "ghp_[a-zA-Z0-9]{36,}", flags: "g" },
  { name: "GitHub OAuth", regex: "gho_[a-zA-Z0-9]{36,}", flags: "g" },
  { name: "GitHub App", regex: "ghs_[a-zA-Z0-9]{36,}", flags: "g" },
  { name: "Bearer Token", regex: "Bearer\\s+[a-zA-Z0-9._\\-]{20,}", flags: "g" },
  { name: "AWS Access Key", regex: "AKIA[A-Z0-9]{16}", flags: "g" },
  ...DEPLOYMENT_PATTERNS,
];

/** Pre-compiled built-in regexes — avoids re-compilation on every redactOutput call. */
const BUILTIN_COMPILED: Array<{ name: string; re: RegExp }> = BUILTIN_PATTERNS.map((p) => ({
  name: p.name,
  re: new RegExp(p.regex, p.flags ?? "g"),
}));

/**
 * Redact secrets from `text` according to built-in + custom patterns.
 *
 * - Returns `text` unchanged when `config.enabled` is explicitly `false`.
 * - Empty input produces an empty result with no matches.
 * - Each matched pattern is replaced with `[REDACTED:<pattern name>]`.
 * - Only patterns with at least one hit appear in `matches`.
 */
export function redactOutput(text: string, config?: OutputFilterConfig): RedactionResult {
  // Disabled explicitly — pass through unchanged.
  if (config?.enabled === false) {
    return { redacted: text, matches: [] };
  }

  // Fast path: nothing to scan.
  if (text.length === 0) {
    return { redacted: "", matches: [] };
  }

  let redacted = text;
  const matches: RedactionMatch[] = [];

  // Scan built-in patterns using pre-compiled regexes.
  for (const { name, re } of BUILTIN_COMPILED) {
    // Reset lastIndex for stateful 'g' flag regexes.
    re.lastIndex = 0;
    let count = 0;
    redacted = redacted.replace(re, () => {
      count++;
      return `[REDACTED:${name}]`;
    });
    if (count > 0) {
      matches.push({ pattern: name, count });
    }
  }

  // Scan custom patterns (compiled on-demand — these vary per config).
  const customPatterns = config?.customPatterns ?? [];
  for (const pattern of customPatterns) {
    let re: RegExp;
    try {
      re = new RegExp(pattern.regex, pattern.flags ?? "g");
    } catch {
      // Skip invalid custom patterns silently — don't crash the pipeline.
      continue;
    }
    let count = 0;
    redacted = redacted.replace(re, () => {
      count++;
      return `[REDACTED:${pattern.name}]`;
    });
    if (count > 0) {
      matches.push({ pattern: pattern.name, count });
    }
  }

  return { redacted, matches };
}
