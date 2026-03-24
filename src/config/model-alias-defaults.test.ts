import { describe, expect, it } from "vitest";
import { DEFAULT_CONTEXT_TOKENS } from "../agents/defaults.js";
import { applyModelDefaults } from "./defaults.js";
import type { OpenClawConfig } from "./types.js";

describe("applyModelDefaults", () => {
  function buildProxyProviderConfig(overrides?: { contextWindow?: number; maxTokens?: number }) {
    return {
      models: {
        providers: {
          myproxy: {
            baseUrl: "https://proxy.example/v1",
            apiKey: "sk-test",
            api: "openai-completions",
            models: [
              {
                id: "gpt-5.2",
                name: "GPT-5.2",
                reasoning: false,
                input: ["text"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: overrides?.contextWindow ?? 200_000,
                maxTokens: overrides?.maxTokens ?? 8192,
              },
            ],
          },
        },
      },
    } satisfies OpenClawConfig;
  }

  function buildMistralProviderConfig(overrides?: {
    modelId?: string;
    contextWindow?: number;
    maxTokens?: number;
  }) {
    return {
      models: {
        providers: {
          mistral: {
            baseUrl: "https://api.mistral.ai/v1",
            apiKey: "sk-mistral", // pragma: allowlist secret
            api: "openai-completions",
            models: [
              {
                id: overrides?.modelId ?? "mistral-large-latest",
                name: "Mistral",
                reasoning: false,
                input: ["text", "image"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: overrides?.contextWindow ?? 262_144,
                maxTokens: overrides?.maxTokens ?? 262_144,
              },
            ],
          },
        },
      },
    } satisfies OpenClawConfig;
  }

  it("adds default aliases when models are present", () => {
    const cfg = {
      agents: {
        defaults: {
          models: {
            "anthropic/claude-opus-4-6": {},
            "openai/gpt-5.4": {},
          },
        },
      },
    } satisfies OpenClawConfig;
    const next = applyModelDefaults(cfg);

    expect(next.agents?.defaults?.models?.["anthropic/claude-opus-4-6"]?.alias).toBe("opus");
    expect(next.agents?.defaults?.models?.["openai/gpt-5.4"]?.alias).toBe("gpt");
  });

  it("does not override existing aliases", () => {
    const cfg = {
      agents: {
        defaults: {
          models: {
            "anthropic/claude-opus-4-5": { alias: "Opus" },
          },
        },
      },
    } satisfies OpenClawConfig;

    const next = applyModelDefaults(cfg);

    expect(next.agents?.defaults?.models?.["anthropic/claude-opus-4-5"]?.alias).toBe("Opus");
  });

  it("respects explicit empty alias disables", () => {
    const cfg = {
      agents: {
        defaults: {
          models: {
            "google/gemini-3.1-pro-preview": { alias: "" },
            "google/gemini-3-flash-preview": {},
            "google/gemini-3.1-flash-lite-preview": {},
          },
        },
      },
    } satisfies OpenClawConfig;

    const next = applyModelDefaults(cfg);

    expect(next.agents?.defaults?.models?.["google/gemini-3.1-pro-preview"]?.alias).toBe("");
    expect(next.agents?.defaults?.models?.["google/gemini-3-flash-preview"]?.alias).toBe(
      "gemini-flash",
    );
    expect(next.agents?.defaults?.models?.["google/gemini-3.1-flash-lite-preview"]?.alias).toBe(
      "gemini-flash-lite",
    );
  });

  it("fills missing model provider defaults", () => {
    const cfg = buildProxyProviderConfig();

    const next = applyModelDefaults(cfg);
    const model = next.models?.providers?.myproxy?.models?.[0];

    expect(model?.reasoning).toBe(false);
    expect(model?.input).toEqual(["text"]);
    expect(model?.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
    expect(model?.contextWindow).toBe(DEFAULT_CONTEXT_TOKENS);
    expect(model?.maxTokens).toBe(8192);
  });

  it("clamps maxTokens to contextWindow", () => {
    const cfg = buildProxyProviderConfig({ contextWindow: 32768, maxTokens: 40960 });

    const next = applyModelDefaults(cfg);
    const model = next.models?.providers?.myproxy?.models?.[0];

    expect(model?.contextWindow).toBe(32768);
    expect(model?.maxTokens).toBe(32768);
  });

  it("normalizes stale mistral maxTokens that matched the full context window", () => {
    const cfg = buildMistralProviderConfig();

    const next = applyModelDefaults(cfg);
    const model = next.models?.providers?.mistral?.models?.[0];

    expect(model?.contextWindow).toBe(262144);
    expect(model?.maxTokens).toBe(16384);
  });

  it("defaults anthropic provider and model api to anthropic-messages", () => {
    const cfg = {
      models: {
        providers: {
          anthropic: {
            baseUrl: "https://relay.example.com/api",
            apiKey: "cr_xxxx", // pragma: allowlist secret
            models: [
              {
                id: "claude-opus-4-6",
                name: "Claude Opus 4.6",
                reasoning: false,
                input: ["text"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 200_000,
                maxTokens: 8192,
              },
            ],
          },
        },
      },
    } satisfies OpenClawConfig;

    const next = applyModelDefaults(cfg);
    const provider = next.models?.providers?.anthropic;
    const model = provider?.models?.[0];

    expect(provider?.api).toBe("anthropic-messages");
    expect(model?.api).toBe("anthropic-messages");
  });

  it("propagates provider api to models when model api is missing", () => {
    const cfg = buildProxyProviderConfig();

    const next = applyModelDefaults(cfg);
    const model = next.models?.providers?.myproxy?.models?.[0];
    expect(model?.api).toBe("openai-completions");
  });

  it("does not treat num_ctx as contextWindow for non-Ollama OpenAI proxies", () => {
    const cfg = {
      models: {
        providers: {
          myproxy: {
            baseUrl: "https://proxy.example/v1",
            api: "openai-completions",
            models: [
              {
                id: "gpt-5.2",
                name: "GPT-5.2",
                options: { num_ctx: 32768 },
              },
            ],
          },
        },
      },
    } as unknown as OpenClawConfig;

    const next = applyModelDefaults(cfg);
    const model = next.models?.providers?.myproxy?.models?.[0];

    expect(model?.contextWindow).toBe(DEFAULT_CONTEXT_TOKENS);
  });

  it("uses num_ctx as contextWindow for native Ollama models", () => {
    const cfg = {
      models: {
        providers: {
          ollama: {
            baseUrl: "http://127.0.0.1:11434",
            api: "ollama",
            models: [
              {
                id: "qwen3.5:9b",
                name: "Qwen 3.5 9B",
                options: { num_ctx: 65536 },
              },
            ],
          },
        },
      },
    } as unknown as OpenClawConfig;

    const next = applyModelDefaults(cfg);
    const model = next.models?.providers?.ollama?.models?.[0];

    expect(model?.contextWindow).toBe(65536);
  });

  it("does not use num_ctx as contextWindow for native Ollama providers when api is omitted", () => {
    const cfg = {
      models: {
        providers: {
          ollama: {
            baseUrl: "http://127.0.0.1:11434",
            models: [
              {
                id: "qwen3.5:9b",
                name: "Qwen 3.5 9B",
                options: { num_ctx: 65536 },
              },
            ],
          },
        },
      },
    } as unknown as OpenClawConfig;

    const next = applyModelDefaults(cfg);
    const model = next.models?.providers?.ollama?.models?.[0];

    expect(model?.contextWindow).toBe(DEFAULT_CONTEXT_TOKENS);
  });

  it("uses num_ctx as contextWindow for enabled Ollama compat providers", () => {
    const cfg = {
      models: {
        providers: {
          "my-ollama": {
            baseUrl: "http://192.168.1.50:11434/v1",
            api: "openai-completions",
            models: [
              {
                id: "qwen3.5:9b",
                name: "Qwen 3.5 9B",
                options: { num_ctx: 49152 },
              },
            ],
          },
        },
      },
    } as unknown as OpenClawConfig;

    const next = applyModelDefaults(cfg);
    const model = next.models?.providers?.["my-ollama"]?.models?.[0];

    expect(model?.contextWindow).toBe(49152);
  });
});
