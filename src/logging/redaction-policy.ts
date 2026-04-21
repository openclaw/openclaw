import { readLoggingConfig } from "./config.js";
import {
  getDefaultRedactPatterns,
  resolveRedactOptions,
  type ResolvedRedactOptions,
} from "./redact.js";

export type LoggingRedactionPolicy = {
  resolved: ResolvedRedactOptions;
  signature: string;
};

function createRedactionSignature(resolved: ResolvedRedactOptions): string {
  return JSON.stringify({
    mode: resolved.mode,
    patterns: resolved.patterns.map((pattern) => ({
      source: pattern.source,
      flags: pattern.flags,
    })),
  });
}

/**
 * Resolve a shared logging redaction policy without triggering mutating config
 * loads. This is the single policy authority for logging-owned persistence and
 * export boundaries.
 */
export function getLoggingRedactionPolicy(): LoggingRedactionPolicy {
  const cfg = readLoggingConfig();
  const resolved = resolveRedactOptions({
    mode: cfg?.redactSensitive ?? undefined,
    patterns: cfg?.redactPatterns ?? getDefaultRedactPatterns(),
  });
  return {
    resolved,
    signature: createRedactionSignature(resolved),
  };
}
