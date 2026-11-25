import { expect, it } from "vitest";
import { resolveContextTokensForModelFromCache } from "../../../agents/context-resolution.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { migrateLegacyContextBudgetConfig } from "./legacy-context-budget.js";

function expectIdempotent(config: Parameters<typeof migrateLegacyContextBudgetConfig>[0]) {
  const repeated = migrateLegacyContextBudgetConfig(config);
  expect(repeated.config).toBe(config);
  expect(repeated).toEqual({ config, changed: false, changes: [], warnings: [] });
}

it.each([true, false])("migrates provider defaults with explicit models=%s", (hasModels) => {
  const budgets = { contextTokens: 32_000, contextWindow: 64_000 };
  const models = [
    { id: "default", name: "Default" },
    { id: "custom", name: "Custom", contextTokens: 8_000, contextWindow: 16_000 },
  ];
  const example = { ...budgets, ...(hasModels ? { models } : {}) };
  const migrated = migrateLegacyContextBudgetConfig({ models: { providers: { example } } });
  const config = migrated.config as OpenClawConfig;
  const provider = config.models?.providers?.example;
  expect(provider).not.toHaveProperty("contextTokens");
  expect(provider).not.toHaveProperty("contextWindow");
  if (hasModels) {
    const tokens = resolveContextTokensForModelFromCache({
      cfg: config,
      provider: "example",
      model: "default",
      allowCacheLookup: false,
    });
    expect(tokens).toBe(32_000);
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
  expectIdempotent(migrated.config);
});

it("removes every agent-level cap surface and is idempotent", () => {
  const agents = {
    defaults: { contextTokens: 128_000 },
    entries: { ops: { contextTokens: 64_000 }, writer: {} },
    list: [{ id: "legacy", contextTokens: 32_000 }],
  };
  const migrated = migrateLegacyContextBudgetConfig({ agents });
  expect(migrated.config).toEqual({
    agents: { defaults: {}, entries: { ops: {}, writer: {} }, list: [{ id: "legacy" }] },
  });
  expect(migrated.changes).toEqual(
    ["agents.defaults", "agents.entries.ops", "agents.list[0]"].map((scope) => ({
      path: `${scope}.contextTokens`,
      message: `Removed ${scope}.contextTokens.`,
    })),
  );
  expect(migrated.warnings).toHaveLength(3);
  expectIdempotent(migrated.config);
  expect(agents.defaults).toHaveProperty("contextTokens", 128_000);
});
