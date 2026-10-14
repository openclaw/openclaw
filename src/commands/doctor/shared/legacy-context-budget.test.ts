import { describe, expect, it } from "vitest";
import { resolveContextTokensForModelFromCache } from "../../../agents/context-resolution.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { migrateLegacyContextBudgetConfig } from "./legacy-context-budget.js";

const noCachedValue = () => undefined;

describe("legacy context-budget config migration", () => {
  it.each([true, false])("migrates provider defaults with explicit models=%s", (hasModels) => {
    const models = [
      { id: "default", name: "Default" },
      { id: "custom", name: "Custom", contextTokens: 8_000, contextWindow: 16_000 },
    ];
    const raw = {
      models: {
        providers: {
          example: {
            contextTokens: 32_000,
            contextWindow: 64_000,
            ...(hasModels ? { models } : {}),
          },
        },
      },
    };
    const migrated = migrateLegacyContextBudgetConfig(raw);
    const config = migrated.config as OpenClawConfig;
    const provider = config.models?.providers?.example;
    expect(provider).not.toHaveProperty("contextTokens");
    expect(provider).not.toHaveProperty("contextWindow");
    if (hasModels) {
      expect(
        resolveContextTokensForModelFromCache(
          { cfg: config, provider: "example", model: "default" },
          noCachedValue,
          noCachedValue,
        ),
      ).toBe(
        resolveContextTokensForModelFromCache(
          { provider: "example", model: "default", modelContextTokens: 32_000 },
          noCachedValue,
          noCachedValue,
        ),
      );
      expect(provider?.models).toMatchObject([
        { contextTokens: 32_000, contextWindow: 64_000 },
        { contextTokens: 8_000, contextWindow: 16_000 },
      ]);
    } else {
      expect(config).toEqual({ models: { providers: { example: {} } } });
    }
    expect(migrated.changes).toEqual(
      ["contextTokens", "contextWindow"].flatMap((key) => {
        const path = `models.providers.example.${key}`;
        return hasModels
          ? [
              { path, message: `${path} → models.providers.example.models[0].${key}.` },
              { path, message: `Removed ${path} after baking it into explicit model entries.` },
            ]
          : [{ path, message: `Removed ${path}.` }];
      }),
    );
    expect(migrated.warnings).toEqual(
      hasModels
        ? []
        : ["contextTokens", "contextWindow"].map((key) => ({
            path: `models.providers.example.${key}`,
            message: `models.providers.example.${key} had no explicit model entries to receive its value; use models.providers.<provider>.models[].contextTokens instead.`,
          })),
    );
    const repeated = migrateLegacyContextBudgetConfig(migrated.config);
    expect(repeated.config).toBe(migrated.config);
    expect(repeated).toEqual({
      config: migrated.config,
      changed: false,
      changes: [],
      warnings: [],
    });
  });

  it("removes every agent-level cap surface and is idempotent", () => {
    const raw = {
      agents: {
        defaults: { contextTokens: 128_000 },
        entries: { ops: { contextTokens: 64_000 }, writer: {} },
        list: [{ id: "legacy", contextTokens: 32_000 }],
      },
    };

    const migrated = migrateLegacyContextBudgetConfig(raw);

    expect(migrated.config).toEqual({
      agents: { defaults: {}, entries: { ops: {}, writer: {} }, list: [{ id: "legacy" }] },
    });
    expect(migrated.changes).toEqual([
      {
        path: "agents.defaults.contextTokens",
        message: "Removed agents.defaults.contextTokens.",
      },
      {
        path: "agents.entries.ops.contextTokens",
        message: "Removed agents.entries.ops.contextTokens.",
      },
      {
        path: "agents.list[0].contextTokens",
        message: "Removed agents.list[0].contextTokens.",
      },
    ]);
    expect(migrated.warnings).toHaveLength(3);
    expect(migrateLegacyContextBudgetConfig(migrated.config)).toEqual({
      config: migrated.config,
      changed: false,
      changes: [],
      warnings: [],
    });
    expect(raw.agents.defaults).toHaveProperty("contextTokens", 128_000);
  });
});
