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

describe("Ollama context-budget Doctor migrations", () => {
  useDoctorLegacyConfigFixture();

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
    const input = legacyConfig({
      models: {
        providers: {
          localOllama: {
            baseUrl: "http://localhost:11434",
            api: "ollama",
            ...provider,
            models: [ollamaModel({ contextWindow: 262_144, contextTokens: 32_768, ...model })],
          },
        },
      },
    });
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
        legacyConfig({
          models: {
            providers: {
              localOllama: {
                baseUrl: "http://localhost:11434",
                api: "ollama",
                maxTokens: 8192,
                models: [
                  ollamaModel({
                    id: "current",
                    api,
                    contextWindow: 262_144,
                    contextTokens: 32_768,
                    params: { temperature: 0.2 },
                  }),
                  ollamaModel({ id: "legacy", contextWindow: 65_536 }),
                  ollamaModel({
                    id: "legacy-inherited",
                    contextWindow: undefined,
                    maxTokens: undefined,
                  }),
                  ollamaModel({
                    id: "compatible",
                    api: "openai-completions",
                    params: { temperature: 0.1 },
                  }),
                ],
              },
            },
          },
        }),
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
      legacyConfig({
        models: {
          providers: {
            ollama: {
              baseUrl: "http://localhost:11434",
              api: "ollama",
              contextTokens: 32_768,
              contextWindow: 262_144,
              maxTokens: 8192,
              models: [ollamaModel({ contextWindow: undefined })],
            },
          },
        },
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

  it("sets native Ollama params.num_ctx from explicit model contextWindow budgets", () => {
    const res = normalizeCompatibilityConfigValues({
      models: {
        providers: {
          ollama: {
            baseUrl: "http://localhost:11434",
            api: "ollama",
            models: [
              ollamaModel({
                params: {
                  temperature: 0.2,
                },
              }),
              ollamaModel({
                id: "llama3.3-small",
                contextWindow: 32768,
                maxTokens: 4096,
                params: {
                  num_ctx: 16384,
                },
              }),
            ],
          },
        },
      },
    });

    expect(res.config.models?.providers?.ollama?.models?.map((model) => model.params)).toEqual([
      { temperature: 0.2, num_ctx: 81920 },
      { num_ctx: 16384 },
    ]);
    expect(res.changes).toEqual([
      "Set models.providers.ollama.models[0].params.num_ctx to 81920 for native Ollama compatibility.",
    ]);
  });

  it("sets native Ollama params.num_ctx from custom provider maxTokens budgets", () => {
    const res = normalizeCompatibilityConfigValues({
      models: {
        providers: {
          localOllama: {
            baseUrl: "http://ollama-box:11434",
            api: "ollama",
            models: [
              ollamaModel({
                contextWindow: 0,
                maxTokens: 24576,
              }),
            ],
          },
        },
      },
    });

    expect(res.config.models?.providers?.localOllama?.models?.[0]?.params).toEqual({
      num_ctx: 24576,
    });
    expect(res.changes).toEqual([
      "Set models.providers.localOllama.models[0].params.num_ctx to 24576 for native Ollama compatibility.",
    ]);
  });

  it("bakes provider contextWindow into the model before native Ollama migration", () => {
    const modelWithoutContextWindow = ollamaModel({
      contextWindow: undefined,
      maxTokens: 4096,
    });
    const res = migrateContextBudgetThenNormalize(
      legacyConfig({
        models: {
          providers: {
            ollama: {
              baseUrl: "http://localhost:11434",
              api: "ollama",
              contextWindow: 65536,
              models: [modelWithoutContextWindow],
            },
          },
        },
      }),
    );

    expect(res.config.models?.providers?.ollama?.models?.[0]?.params).toEqual({
      num_ctx: 65536,
    });
    expect(res.config.models?.providers?.ollama?.params).toBeUndefined();
    expect(res.config.agents?.defaults?.model).toEqual({ primary: "ollama/llama3.3" });
    expect(res.changes).toEqual([
      "models.providers.ollama.contextWindow → models.providers.ollama.models[0].contextWindow.",
      "Removed models.providers.ollama.contextWindow after baking it into explicit model entries.",
      "Preserved the implicit primary model in agents.defaults.model.primary (ollama/llama3.3).",
      "Set models.providers.ollama.models[0].params.num_ctx to 65536 for native Ollama compatibility.",
    ]);
  });

  it("removes provider contextWindow when no explicit Ollama model can receive it", () => {
    const res = migrateContextBudgetThenNormalize(
      legacyConfig({
        models: {
          providers: {
            ollama: {
              baseUrl: "http://localhost:11434",
              api: "ollama",
              contextWindow: 65536,
              models: [],
            },
          },
        },
      }),
    );

    expect(res.config.models?.providers?.ollama?.params).toBeUndefined();
    expect(res.config.models?.providers?.ollama).not.toHaveProperty("contextWindow");
    expect(res.changes).toEqual(["Removed models.providers.ollama.contextWindow."]);
    expect(res.warnings).toEqual([
      "models.providers.ollama.contextWindow had no explicit model entries to receive its value; use models.providers.<provider>.models[].contextTokens instead.",
    ]);
  });

  it("keeps explicit model windows ahead of retired provider defaults", () => {
    const res = migrateContextBudgetThenNormalize(
      legacyConfig({
        models: {
          providers: {
            ollama: {
              baseUrl: "http://localhost:11434",
              api: "ollama",
              contextWindow: 65536,
              models: [
                ollamaModel({
                  contextWindow: 32768,
                }),
              ],
            },
          },
        },
      }),
    );

    expect(res.config.models?.providers?.ollama?.params).toBeUndefined();
    expect(res.config.models?.providers?.ollama?.models?.[0]?.params).toEqual({
      num_ctx: 32768,
    });
    expect(res.config.agents?.defaults?.model).toEqual({ primary: "ollama/llama3.3" });
    expect(res.changes).toEqual([
      "Removed models.providers.ollama.contextWindow after baking it into explicit model entries.",
      "Preserved the implicit primary model in agents.defaults.model.primary (ollama/llama3.3).",
      "Set models.providers.ollama.models[0].params.num_ctx to 32768 for native Ollama compatibility.",
    ]);
  });

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
      legacyConfig({
        models: {
          providers: {
            ollama: {
              baseUrl: "http://localhost:11434",
              api: "ollama",
              contextWindow: 65536,
              params: providerParams,
              models: [
                ollamaModel({
                  contextWindow: 32768,
                  params: modelParams,
                }),
              ],
            },
          },
        },
      }),
    );

    const nextProviderParams = res.config.models?.providers?.ollama?.params as Record<
      string,
      unknown
    >;
    const nextModelParams = res.config.models?.providers?.ollama?.models?.[0]?.params as Record<
      string,
      unknown
    >;
    expect(Object.getPrototypeOf(nextProviderParams)).toBe(Object.prototype);
    expect(Object.getPrototypeOf(nextModelParams)).toBe(Object.prototype);
    expect(Object.getOwnPropertyDescriptor(nextProviderParams, "__proto__")?.value).toEqual({
      think: "high",
    });
    expect(Object.getOwnPropertyDescriptor(nextModelParams, "__proto__")?.value).toEqual({
      keep_alive: "forever",
    });
    expect(nextProviderParams.think).toBeUndefined();
    expect(nextModelParams.keep_alive).toBeUndefined();
    expect(nextProviderParams.num_ctx).toBeUndefined();
    expect(nextModelParams.num_ctx).toBe(32768);
  });

  it("keeps existing provider num_ctx while materializing the model budget", () => {
    const res = migrateContextBudgetThenNormalize(
      legacyConfig({
        models: {
          providers: {
            ollama: {
              baseUrl: "http://localhost:11434",
              api: "ollama",
              contextWindow: 65536,
              params: {
                num_ctx: 32768,
              },
              models: [
                ollamaModel({
                  contextWindow: undefined,
                  maxTokens: undefined,
                }),
              ],
            },
          },
        },
      }),
    );

    expect(res.config.models?.providers?.ollama?.params).toEqual({
      num_ctx: 32768,
    });
    expect(res.config.models?.providers?.ollama?.models?.[0]?.params).toEqual({
      num_ctx: 65536,
    });
    expect(res.config.agents?.defaults?.model).toEqual({ primary: "ollama/llama3.3" });
    expect(res.changes).toEqual([
      "models.providers.ollama.contextWindow → models.providers.ollama.models[0].contextWindow.",
      "Removed models.providers.ollama.contextWindow after baking it into explicit model entries.",
      "Preserved the implicit primary model in agents.defaults.model.primary (ollama/llama3.3).",
      "Set models.providers.ollama.models[0].params.num_ctx to 65536 for native Ollama compatibility.",
    ]);
  });

  it("does not set native Ollama params for OpenAI-compatible Ollama configs", () => {
    const input = {
      models: {
        providers: {
          ollama: {
            baseUrl: "http://localhost:11434/v1",
            api: "openai-completions" as const,
            models: [ollamaModel()],
          },
        },
      },
    };

    const res = normalizeCompatibilityConfigValues(input);

    expect(res.config).toEqual(input);
    expect(res.changes).toEqual([]);
  });

  it("does not set native Ollama params for implicit OpenAI-compatible Ollama configs", () => {
    const input = {
      models: {
        providers: {
          ollama: {
            baseUrl: "http://localhost:11434/v1",
            contextWindow: 65536,
            models: [ollamaModel()],
          },
        },
      },
    };

    const res = migrateContextBudgetThenNormalize(input);

    expect(res.config.models?.providers?.ollama).not.toHaveProperty("contextWindow");
    expect(res.config.models?.providers?.ollama?.models).toEqual(
      input.models.providers.ollama.models,
    );
    expect(res.config.agents?.defaults?.model).toEqual({ primary: "ollama/llama3.3" });
    expect(res.changes).toEqual([
      "Removed models.providers.ollama.contextWindow after baking it into explicit model entries.",
      "Preserved the implicit primary model in agents.defaults.model.primary (ollama/llama3.3).",
    ]);
  });
});
