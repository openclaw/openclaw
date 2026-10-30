// Covers bundled config migrations through the plugin setup registry.
import path from "node:path";
import { describe, expect, test } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { runPluginSetupConfigMigrations } from "./setup-registry.js";

function runMigration(config: OpenClawConfig) {
  return runPluginSetupConfigMigrations({
    env: {
      ...process.env,
      OPENCLAW_BUNDLED_PLUGINS_DIR: path.resolve("extensions"),
    },
    config,
  });
}

describe("bundled setup config migrations", () => {
  test("preserves Voice Call canonical settings and converges through the bundled registry", () => {
    const current = {
      apiKey: { source: "env", provider: "default", id: "SYNTHETIC_VOICE_KEY" },
      model: "synthetic-current-model",
      silenceDurationMs: 900,
      vadThreshold: 0,
      keep: "current",
    };
    const config = {
      plugins: {
        entries: {
          "voice-call": {
            enabled: false,
            config: {
              responseSystemPrompt: "synthetic-preserved-instructions",
              streaming: {
                openaiApiKey: "synthetic-legacy-key",
                sttModel: "synthetic-legacy-model",
                silenceDurationMs: 700,
                vadThreshold: 0.4,
                providers: { openai: current },
              },
            },
          },
        },
      },
    } satisfies OpenClawConfig;
    const before = structuredClone(config);
    const result = runMigration(config);

    expect(result.config.plugins?.entries?.["voice-call"]).toEqual({
      enabled: false,
      config: expect.objectContaining({
        responseSystemPrompt: "synthetic-preserved-instructions",
        streaming: { provider: undefined, providers: { openai: current } },
      }),
    });
    expect(result.changes).toHaveLength(4);
    expect(result.changes.every((change) => change.includes("(kept "))).toBe(true);
    expect(config).toEqual(before);
    expect(runMigration(result.config)).toEqual({ config: result.config, changes: [] });
  });
});
