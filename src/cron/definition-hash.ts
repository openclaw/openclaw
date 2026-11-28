import { stableStringify } from "@openclaw/normalization-core";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { sha256Base64Url } from "../infra/crypto-digest.js";

/** Hashes one canonical cron definition while preserving meaningful env-key order. */
export function hashCronJobDefinition(definition: Record<string, unknown>): string {
  const payload = isRecord(definition.payload) ? definition.payload : undefined;
  const env = payload && isRecord(payload.env) ? payload.env : undefined;
  if (payload?.kind !== "command" || !env) {
    return `sha256:${sha256Base64Url(stableStringify(definition))}`;
  }

  const foldedKeys = new Set<string>();
  const hasWindowsCollision = Object.keys(env).some((key) => {
    const folded = key.toLowerCase();
    if (foldedKeys.has(folded)) {
      return true;
    }
    foldedKeys.add(folded);
    return false;
  });
  if (!hasWindowsCollision) {
    return `sha256:${sha256Base64Url(stableStringify(definition))}`;
  }

  // Windows resolves case-insensitive duplicate env keys in insertion order.
  // Preserve that order only when it changes command execution semantics.
  const { env: _env, ...payloadWithoutEnv } = payload;
  const orderedDefinition = {
    ...definition,
    payload: { ...payloadWithoutEnv, envEntries: Object.entries(env) },
  };
  return `sha256:${sha256Base64Url(stableStringify(orderedDefinition))}`;
}
