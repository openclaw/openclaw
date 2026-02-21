/**
 * Masked Secrets — Output Redaction
 *
 * Scans command output (stdout/stderr) for leaked secret values and
 * replaces them with [REDACTED]. This is the safety net — if a secret
 * somehow appears in output (e.g., a program prints its config, an error
 * message includes the key), the agent never sees the real value.
 *
 * Strategy:
 * 1. Exact match: replace known secret values (longest-first to avoid partials)
 * 2. Pattern match: catch common API key formats that might not be in the store
 *    (e.g., sk-ant-..., sk-..., ghp_..., etc.)
 */

import { createSubsystemLogger } from "../../logging/subsystem.js";
import type { SecretStore } from "./secret-store.js";
import type { RedactionResult } from "./types.js";

const log = createSubsystemLogger("security/masked-secrets");

const REDACTED_PLACEHOLDER = "[REDACTED]";

/**
 * Well-known API key patterns. These catch secrets even if they're not
 * in the store (e.g., printed by a third-party tool).
 */
const BUILT_IN_PATTERNS: RegExp[] = [
  // Anthropic
  /sk-ant-[A-Za-z0-9_-]{20,}/g,
  // OpenAI
  /sk-[A-Za-z0-9]{32,}/g,
  // GitHub tokens
  /gh[ps]_[A-Za-z0-9]{36,}/g,
  /github_pat_[A-Za-z0-9_]{20,}/g,
  // AWS
  /AKIA[A-Z0-9]{16}/g,
  // Stripe
  /sk_live_[A-Za-z0-9]{24,}/g,
  /sk_test_[A-Za-z0-9]{24,}/g,
  // Slack
  /xox[bpras]-[A-Za-z0-9-]{10,}/g,
  // Generic bearer tokens (very long base64-like strings after "Bearer ")
  /Bearer\s+[A-Za-z0-9+/=_-]{40,}/g,
];

/**
 * Redact known secret values and common patterns from text.
 */
export function redactOutput(text: string, store: SecretStore): RedactionResult {
  let result = text;
  let count = 0;
  const redactedSecrets: string[] = [];

  // Phase 1: Exact value replacement (longest first)
  const values = store.getValues();
  values.sort((a, b) => b.length - a.length);

  for (const value of values) {
    if (result.includes(value)) {
      const occurrences = result.split(value).length - 1;
      result = result.replaceAll(value, REDACTED_PLACEHOLDER);
      count += occurrences;

      // Find which secret this value belongs to
      for (const name of store.listNames()) {
        if (store.resolve(name) === value) {
          redactedSecrets.push(name);
          break;
        }
      }
    }
  }

  // Phase 2: Pattern-based redaction
  const allPatterns = [
    ...BUILT_IN_PATTERNS,
    ...compileCustomPatterns(store.getConfig().outputPatterns ?? []),
  ];

  for (const pattern of allPatterns) {
    // Reset lastIndex for global patterns
    pattern.lastIndex = 0;
    const matches = result.match(pattern);
    if (matches) {
      for (const match of matches) {
        // Don't double-redact already-redacted text
        if (match.includes(REDACTED_PLACEHOLDER)) {
          continue;
        }
        result = result.replaceAll(match, REDACTED_PLACEHOLDER);
        count++;
      }
    }
  }

  if (count > 0) {
    log.warn(
      `Redacted ${count} secret occurrence(s) from output (${redactedSecrets.length} known secrets)`,
    );
  }

  return { text: result, count, redactedSecrets };
}

/**
 * Compile user-provided regex strings into RegExp objects.
 * Invalid patterns are logged and skipped.
 */
function compileCustomPatterns(patterns: string[]): RegExp[] {
  const compiled: RegExp[] = [];
  for (const pattern of patterns) {
    try {
      compiled.push(new RegExp(pattern, "g"));
    } catch (err) {
      log.warn(`Invalid output redaction pattern: ${pattern}`, err as Record<string, unknown>);
    }
  }
  return compiled;
}
