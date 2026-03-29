import { expect } from "vitest";
import { restoreRedactedValues as restoreRedactedValues_orig } from "./redact-snapshot.js";
import type { ConfigUiHints } from "./schema.js";
import type { ConfigFileSnapshot } from "./types.openclaw.js";

export type TestSnapshot<TConfig extends Record<string, unknown>> = ConfigFileSnapshot & {
  parsed: TConfig;
  resolved: TConfig;
  config: TConfig;
};

export function makeSnapshot<TConfig extends Record<string, unknown>>(
  config: TConfig,
  raw?: string,
): TestSnapshot<TConfig> {
  return {
    path: "/home/user/.openclaw/config.json5",
    exists: true,
    raw: raw ?? JSON.stringify(config),
    parsed: config,
    resolved: config as ConfigFileSnapshot["resolved"],
    valid: true,
    config: config as ConfigFileSnapshot["config"],
    hash: "abc123",
    issues: [],
    warnings: [],
    legacyIssues: [],
  } as unknown as TestSnapshot<TConfig>;
}

export function restoreRedactedValues<TOriginal>(
  incoming: unknown,
  original: TOriginal,
  hints?: ConfigUiHints,
): TOriginal {
  const result = restoreRedactedValues_orig(incoming, original, hints);
  expect(result.ok).toBe(true);
  return result.result as TOriginal;
}
