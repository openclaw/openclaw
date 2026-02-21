/**
 * Masked Secrets — Substitution Engine
 *
 * Handles the {{secret:NAME}} syntax in commands. Before a shell command
 * is executed, any {{secret:NAME}} references are replaced with the real
 * secret value. The agent never sees the real value — it only writes the
 * reference syntax.
 *
 * Example:
 *   Agent writes:  curl -H "Authorization: Bearer {{secret:MY_API_KEY}}" https://api.example.com
 *   Runtime sees:  curl -H "Authorization: Bearer sk-abc123..." https://api.example.com
 *   Agent sees:    curl -H "Authorization: Bearer {{secret:MY_API_KEY}}" https://api.example.com
 */

import type { SecretStore } from "./secret-store.js";
import type { SubstitutionResult } from "./types.js";

/** Pattern to match {{secret:NAME}} references in text */
const SECRET_REF_PATTERN = /\{\{secret:([A-Za-z_][A-Za-z0-9_]*)\}\}/g;

/**
 * Substitute all {{secret:NAME}} references in a string with real values.
 * Returns the substituted text and metadata about what was replaced.
 */
export function substituteSecrets(text: string, store: SecretStore): SubstitutionResult {
  const substituted: string[] = [];
  const missing: string[] = [];

  const result = text.replace(SECRET_REF_PATTERN, (match, name: string) => {
    const value = store.resolve(name);
    if (value !== undefined) {
      substituted.push(name);
      return value;
    }
    missing.push(name);
    return match; // Leave unresolved references as-is
  });

  return { text: result, substituted, missing };
}

/**
 * Check if a string contains any {{secret:NAME}} references.
 */
export function hasSecretRefs(text: string): boolean {
  return SECRET_REF_PATTERN.test(text);
}

/**
 * Extract all secret names referenced in a string.
 */
export function extractSecretRefs(text: string): string[] {
  const refs: string[] = [];
  let match: RegExpExecArray | null;
  const pattern = new RegExp(SECRET_REF_PATTERN.source, "g");
  while ((match = pattern.exec(text)) !== null) {
    refs.push(match[1]);
  }
  return refs;
}
