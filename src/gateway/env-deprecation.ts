/**
 * Detects legacy CLAWDBOT_* and MOLTBOT_* env vars and emits a single
 * deprecation warning listing each detected key and its OPENCLAW_* replacement.
 *
 * The breaking removal happened in v2026.3.22 (commit 6b9915a106).
 * We do not restore fallback behavior — only surface the rename.
 */

const LEGACY_PREFIX_MAP: ReadonlyArray<[legacy: string, modern: string]> = [
  ["CLAWDBOT_", "OPENCLAW_"],
  ["MOLTBOT_", "OPENCLAW_"],
];

let warned = false;

export function warnLegacyEnvVars(env: NodeJS.ProcessEnv = process.env): void {
  if (warned) {
    return;
  }
  // Suppress in test environments.
  if (process.env.VITEST === "true" || process.env.NODE_ENV === "test") {
    return;
  }

  const hits: Array<{ legacy: string; replacement: string }> = [];

  for (const key of Object.keys(env)) {
    for (const [legacyPrefix, modernPrefix] of LEGACY_PREFIX_MAP) {
      if (key.startsWith(legacyPrefix)) {
        const suffix = key.slice(legacyPrefix.length);
        hits.push({ legacy: key, replacement: `${modernPrefix}${suffix}` });
      }
    }
  }

  if (hits.length === 0) {
    return;
  }

  const lines = hits.map((h) => `  ${h.legacy} -> ${h.replacement}`);
  process.emitWarning(
    [
      "Legacy environment variables detected (no longer supported since v2026.3.22):",
      ...lines,
      "Rename them to their OPENCLAW_* equivalents; the old names are silently ignored.",
    ].join("\n"),
    {
      type: "DeprecationWarning",
      code: "OPENCLAW_LEGACY_ENV_VARS",
    },
  );

  warned = true;
}

/**
 * Reset internal state — only for tests.
 * @internal
 */
export function _resetLegacyEnvWarning(): void {
  warned = false;
}
