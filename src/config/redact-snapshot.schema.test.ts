import { describe, expect, it } from "vitest";
import {
  REDACTED_SENTINEL,
  redactConfigSnapshot,
  restoreRedactedValues as restoreRedactedValues_orig,
} from "./redact-snapshot.js";
import { redactSnapshotTestHints as mainSchemaHints } from "./redact-snapshot.test-hints.js";
import type { ConfigUiHints } from "./schema.js";
import type { ConfigFileSnapshot } from "./types.openclaw.js";

type TestSnapshot<TConfig extends Record<string, unknown>> = ConfigFileSnapshot & {
  parsed: TConfig;
  resolved: TConfig;
  config: TConfig;
};

function makeSnapshot<TConfig extends Record<string, unknown>>(
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

function restoreRedactedValues<TOriginal>(
  incoming: unknown,
  original: TOriginal,
  hints?: ConfigUiHints,
): TOriginal {
  const result = restoreRedactedValues_orig(incoming, original, hints);
  expect(result.ok).toBe(true);
  return result.result as TOriginal;
}

describe("realredactConfigSnapshot_real", () => {
  it("main schema redact works (samples)", () => {
    const snapshot = makeSnapshot({
      agents: {
        defaults: {
          memorySearch: {
            remote: {
              apiKey: "1234",
            },
          },
        },
        list: [
          {
            memorySearch: {
              remote: {
                apiKey: "6789",
              },
            },
          },
        ],
      },
    });

    const result = redactConfigSnapshot(snapshot, mainSchemaHints);
    const config = result.config as typeof snapshot.config;
    expect(config.agents.defaults.memorySearch.remote.apiKey).toBe(REDACTED_SENTINEL);
    expect(config.agents.list[0].memorySearch.remote.apiKey).toBe(REDACTED_SENTINEL);
    const restored = restoreRedactedValues(result.config, snapshot.config, mainSchemaHints);
    expect(restored.agents.defaults.memorySearch.remote.apiKey).toBe("1234");
    expect(restored.agents.list[0].memorySearch.remote.apiKey).toBe("6789");
  });
});
