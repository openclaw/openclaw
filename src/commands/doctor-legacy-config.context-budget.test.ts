// Load the shared migration mocks before their production consumers.
// oxfmt-ignore
import { legacyConfig, useDoctorLegacyConfigFixture } from "./doctor/shared/legacy-config-fixture.test-support.js";
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { applyLegacyDoctorMigrations } from "./doctor/shared/legacy-config-compat.js";
import { normalizeCompatibilityConfigValues } from "./doctor/shared/legacy-config-core-migrate.js";

function migrateContextBudgetThenNormalize(config: OpenClawConfig) {
  const early = applyLegacyDoctorMigrations(config, { sourceConfigBeforeMigrations: config });
  const normalized = normalizeCompatibilityConfigValues(legacyConfig(early.next ?? config));
  return {
    ...normalized,
    changes: [...early.changes, ...normalized.changes],
    warnings: [...(early.warnings ?? []), ...(normalized.warnings ?? [])],
  };
}

const ollamaModel = (overrides: Record<string, unknown> = {}) => ({
  id: "llama3.3",
  name: "Llama 3.3",
  reasoning: false,
  input: ["text"] as Array<"text">,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 81920,
  maxTokens: 8192,
  ...overrides,
});
function ollamaConfig(
  models: ReturnType<typeof ollamaModel>[],
  provider: Record<string, unknown> = {},
  id = "ollama",
) {
  return legacyConfig({
    models: {
      providers: {
        [id]: { baseUrl: "http://localhost:11434", api: "ollama", ...provider, models },
      },
    },
  });
}

const bakedWindow =
  "models.providers.ollama.contextWindow → models.providers.ollama.models[0].contextWindow.";
const removedWindow =
  "Removed models.providers.ollama.contextWindow after baking it into explicit model entries.";
const preservedPrimary =
  "Preserved the implicit primary model in agents.defaults.model.primary (ollama/llama3.3).";

describe("Ollama context-budget Doctor migrations", () => {
  useDoctorLegacyConfigFixture();

  it.each([
    { label: "provider output budget", provider: { maxTokens: 8192 }, model: {} },
    {
      label: "explicit provider num_ctx",
      provider: { maxTokens: 8192, params: { num_ctx: 16_384 } },
      model: {},
    },
    {
      label: "explicit model num_ctx",
      provider: { maxTokens: 8192 },
      model: { params: { num_ctx: 16_384 } },
    },
  ])("preserves current Ollama contextTokens with $label", ({ provider, model }) => {
    const input = ollamaConfig(
      [ollamaModel({ contextWindow: 262_144, contextTokens: 32_768, ...model })],
      provider,
      "localOllama",
    );
    const expected = structuredClone(input);
    const result = normalizeCompatibilityConfigValues(input);
    expect(result.config).toEqual(expected);
    expect(result.changes).toEqual([]);
    const repeated = normalizeCompatibilityConfigValues(result.config);
    expect(repeated.config).toEqual(expected);
    expect(repeated.changes).toEqual([]);
  });

  it.each(["ollama", "openai-completions"] as const)(
    "migrates legacy Ollama siblings without pinning a current %s model",
    (api) => {
      const result = normalizeCompatibilityConfigValues(
        ollamaConfig(
          [
            ollamaModel({
              id: "current",
              api,
              contextWindow: 262_144,
              contextTokens: 32_768,
              params: { temperature: 0.2 },
            }),
            ollamaModel({ id: "legacy", contextWindow: 65_536 }),
            ollamaModel({ id: "legacy-inherited", contextWindow: undefined, maxTokens: undefined }),
            ollamaModel({
              id: "compatible",
              api: "openai-completions",
              params: { temperature: 0.1 },
            }),
          ],
          { maxTokens: 8192 },
          "localOllama",
        ),
      );
      const provider = result.config.models?.providers?.localOllama;
      expect(provider?.params).toBeUndefined();
      expect(provider?.models?.[0]).toMatchObject({
        id: "current",
        api,
        contextWindow: 262_144,
        contextTokens: 32_768,
        params: { temperature: 0.2 },
      });
      expect(provider?.models?.[0]?.params).not.toHaveProperty("num_ctx");
      expect(provider?.models?.[1]?.params).toEqual({ num_ctx: 65_536 });
      expect(provider?.models?.[2]?.params).toEqual({ num_ctx: 8192 });
      expect(provider?.models?.[3]?.params).toEqual({ temperature: 0.1 });
      const repeated = normalizeCompatibilityConfigValues(result.config);
      expect(repeated.config).toEqual(result.config);
      expect(repeated.changes).toEqual([]);
    },
  );

  it("keeps retired provider contextTokens usable without adding an Ollama num_ctx pin", () => {
    const result = migrateContextBudgetThenNormalize(
      ollamaConfig([ollamaModel({ contextWindow: undefined })], {
        contextTokens: 32_768,
        contextWindow: 262_144,
        maxTokens: 8192,
      }),
    );
    const provider = result.config.models?.providers?.ollama;
    expect(provider).not.toHaveProperty("contextTokens");
    expect(provider).not.toHaveProperty("contextWindow");
    expect(provider?.params).toBeUndefined();
    expect(provider?.models?.[0]).toMatchObject({ contextTokens: 32_768, contextWindow: 262_144 });
    expect(provider?.models?.[0]?.params).toBeUndefined();
    const repeated = migrateContextBudgetThenNormalize(result.config);
    expect(repeated.config).toEqual(result.config);
    expect(repeated.changes).toEqual([]);
  });

  it.each([
    {
      id: "ollama",
      budget: "contextWindow",
      models: [
        ollamaModel({ params: { temperature: 0.2 } }),
        ollamaModel({
          id: "llama3.3-small",
          contextWindow: 32768,
          maxTokens: 4096,
          params: { num_ctx: 16384 },
        }),
      ],
      params: [{ temperature: 0.2, num_ctx: 81920 }, { num_ctx: 16384 }],
      numCtx: 81920,
    },
    {
      id: "localOllama",
      budget: "maxTokens",
      models: [ollamaModel({ contextWindow: 0, maxTokens: 24576 })],
      params: [{ num_ctx: 24576 }],
      numCtx: 24576,
    },
  ])(
    "sets native Ollama params from $id model $budget budgets",
    ({ id, models, params, numCtx }) => {
      const res = normalizeCompatibilityConfigValues(ollamaConfig(models, {}, id));
      expect(res.config.models?.providers?.[id]?.models?.map((model) => model.params)).toEqual(
        params,
      );
      expect(res.changes).toEqual([
        `Set models.providers.${id}.models[0].params.num_ctx to ${numCtx} for native Ollama compatibility.`,
      ]);
    },
  );

  it.each([
    {
      label: "inherited window",
      models: [ollamaModel({ contextWindow: undefined, maxTokens: 4096 })],
      params: undefined,
      expected: [{ num_ctx: 65536 }],
      changes: [
        bakedWindow,
        removedWindow,
        preservedPrimary,
        "Set models.providers.ollama.models[0].params.num_ctx to 65536 for native Ollama compatibility.",
      ],
      warnings: [],
    },
    {
      label: "explicit model window",
      models: [ollamaModel({ contextWindow: 32768 })],
      params: undefined,
      expected: [{ num_ctx: 32768 }],
      changes: [
        removedWindow,
        preservedPrimary,
        "Set models.providers.ollama.models[0].params.num_ctx to 32768 for native Ollama compatibility.",
      ],
      warnings: [],
    },
    {
      label: "existing provider pin",
      models: [ollamaModel({ contextWindow: undefined, maxTokens: undefined })],
      params: { num_ctx: 32768 },
      expected: [{ num_ctx: 65536 }],
      changes: [
        bakedWindow,
        removedWindow,
        preservedPrimary,
        "Set models.providers.ollama.models[0].params.num_ctx to 65536 for native Ollama compatibility.",
      ],
      warnings: [],
    },
    {
      label: "no explicit models",
      models: [],
      params: undefined,
      expected: [],
      changes: ["Removed models.providers.ollama.contextWindow."],
      warnings: [
        "models.providers.ollama.contextWindow had no explicit model entries to receive its value; use models.providers.<provider>.models[].contextTokens instead.",
      ],
    },
  ])(
    "migrates retired provider contextWindow with $label",
    ({ models, params, expected, changes, warnings }) => {
      const expectedProviderParams = structuredClone(params);
      const res = migrateContextBudgetThenNormalize(
        ollamaConfig(models, { contextWindow: 65536, params }),
      );
      const provider = res.config.models?.providers?.ollama;
      expect(provider).not.toHaveProperty("contextWindow");
      expect(provider?.params).toEqual(expectedProviderParams);
      expect(provider?.models?.map((model) => model.params)).toEqual(expected);
      if (models.length) {
        expect(res.config.agents?.defaults?.model).toEqual({ primary: "ollama/llama3.3" });
      }
      expect(res.changes).toEqual(changes);
      expect(res.warnings).toEqual(warnings);
    },
  );

  it("keeps native Ollama params prototype-safe while setting num_ctx", () => {
    const providerParams: Record<string, unknown> = { temperature: 0.2 };
    Object.defineProperty(providerParams, "__proto__", {
      enumerable: true,
      value: { think: "high" },
    });
    const modelParams: Record<string, unknown> = { top_p: 0.9 };
    Object.defineProperty(modelParams, "__proto__", {
      enumerable: true,
      value: { keep_alive: "forever" },
    });
    const res = migrateContextBudgetThenNormalize(
      ollamaConfig([ollamaModel({ contextWindow: 32768, params: modelParams })], {
        contextWindow: 65536,
        params: providerParams,
      }),
    );
    const nextProviderParams = res.config.models?.providers?.ollama?.params;
    const nextModelParams = res.config.models?.providers?.ollama?.models?.[0]?.params;
    expect(Object.getPrototypeOf(nextProviderParams)).toBe(Object.prototype);
    expect(Object.getPrototypeOf(nextModelParams)).toBe(Object.prototype);
    expect(Object.getOwnPropertyDescriptor(nextProviderParams, "__proto__")?.value).toEqual({
      think: "high",
    });
    expect(Object.getOwnPropertyDescriptor(nextModelParams, "__proto__")?.value).toEqual({
      keep_alive: "forever",
    });
    expect(nextProviderParams?.think).toBeUndefined();
    expect(nextModelParams?.keep_alive).toBeUndefined();
    expect(nextProviderParams?.num_ctx).toBeUndefined();
    expect(nextModelParams?.num_ctx).toBe(32768);
  });

  it.each([false, true])(
    "does not pin OpenAI-compatible Ollama configs (implicit=%s)",
    (implicit) => {
      const input = ollamaConfig([ollamaModel()], {
        baseUrl: "http://localhost:11434/v1",
        api: implicit ? undefined : "openai-completions",
        ...(implicit ? { contextWindow: 65536 } : {}),
      });
      const res = implicit
        ? migrateContextBudgetThenNormalize(input)
        : normalizeCompatibilityConfigValues(input);
      if (implicit) {
        expect(res.config.models?.providers?.ollama).not.toHaveProperty("contextWindow");
        expect(res.config.models?.providers?.ollama?.models).toEqual(
          input.models?.providers?.ollama?.models,
        );
        expect(res.config.agents?.defaults?.model).toEqual({ primary: "ollama/llama3.3" });
        expect(res.changes).toEqual([removedWindow, preservedPrimary]);
      } else {
        expect(res.config).toEqual(input);
        expect(res.changes).toEqual([]);
      }
    },
  );
});
