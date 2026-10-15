/** Verifies provider auth choice helper defaults, sorting, and config matching. */
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import type { ModelProviderConfig } from "../config/types.models.js";
import { applyProviderAuthConfigPatch } from "./provider-auth-choice-helpers.js";

const providerConfigNormalizer = ({ providerConfig }: { providerConfig: ModelProviderConfig }) =>
  providerConfig;

describe("applyProviderAuthConfigPatch", () => {
  const base = {
    agents: {
      defaults: {
        model: { primary: "anthropic/claude-sonnet-4-6", fallbacks: ["openai/gpt-5.2"] },
        models: {
          "anthropic/claude-sonnet-4-6": { alias: "Sonnet" },
          "anthropic/claude-opus-4-6": { alias: "Opus" },
          "openai/gpt-5.2": {},
        },
      },
    },
  };

  it("merges default model maps by default so other providers survive login", () => {
    const patch = { agents: { defaults: { models: { "openai/gpt-5.5": {} } } } };
    const next = applyProviderAuthConfigPatch(base, patch);
    expect(next.agents?.defaults?.models).toEqual({
      ...base.agents.defaults.models,
      "openai/gpt-5.5": {},
    });
    expect(next.agents?.defaults?.model).toEqual(base.agents.defaults.model);
  });

  it("ignores undefined deletions under blocked __proto__ keys without mutating input", () => {
    const blockedKey = "__proto__";
    const config = { [blockedKey]: { retained: "before" } };
    const baseLocal = {
      plugins: { entries: { example: { config } } },
    } satisfies OpenClawConfig;
    const patch = {
      plugins: {
        entries: {
          example: { config: { [blockedKey]: { retained: undefined } } },
        },
      },
    };

    const next = applyProviderAuthConfigPatch(baseLocal, patch);

    expect(config[blockedKey]).toEqual({ retained: "before" });
    expect(next.plugins?.entries?.example?.config?.[blockedKey]).toEqual({ retained: "before" });
  });

  it("drops prototype-pollution keys from opt-in model replacement", () => {
    const patch = JSON.parse(
      '{"agents":{"defaults":{"models":{"__proto__":{"polluted":true},"claude-cli/claude-sonnet-4-6":{"alias":"Sonnet","params":{"constructor":{"polluted":true},"maxTokens":12000}}}}}}',
    );
    const next = applyProviderAuthConfigPatch(base, patch, { replaceDefaultModels: true });
    const models = next.agents?.defaults?.models;
    expect(models).toEqual({
      "claude-cli/claude-sonnet-4-6": {
        alias: "Sonnet",
        params: { maxTokens: 12000 },
      },
    });
    expect(Object.hasOwn(models ?? {}, "__proto__")).toBe(false);
    expect(Object.getPrototypeOf(Object.assign({}, models)).polluted).toBeUndefined();
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("deletes provider auth fields marked undefined by auth patches", () => {
    const baseLocal = {
      models: {
        providers: {
          "microsoft-foundry": {
            baseUrl: "https://example.services.ai.azure.com/openai/v1",
            api: "anthropic-messages",
            authHeader: false,
            apiKey: "FOUNDRY_API_KEY",
            headers: { "api-key": "FOUNDRY_API_KEY" },
            models: [],
          },
        },
      },
    } satisfies OpenClawConfig;
    const patch = {
      models: {
        providers: {
          "microsoft-foundry": {
            authHeader: true,
            apiKey: undefined,
            headers: undefined,
          },
        },
      },
    };

    const next = applyProviderAuthConfigPatch(baseLocal, patch, { providerConfigNormalizer });
    const provider = next.models?.providers?.["microsoft-foundry"] as
      | Record<string, unknown>
      | undefined;

    expect(provider).toMatchObject({ authHeader: true });
    expect(provider).not.toHaveProperty("apiKey");
    expect(provider).not.toHaveProperty("headers");
  });

  it("normalizes retired Google Gemini per-agent refs from provider config patches", () => {
    const patch = {
      agents: {
        entries: {
          ops: {
            model: {
              primary: "google/gemini-3-pro-preview",
              fallbacks: ["google/gemini-3-pro-preview"],
            },
            models: {
              "google/gemini-3-pro-preview": {
                alias: "ops-gemini",
              },
            },
          },
        },
      },
    };

    const next = applyProviderAuthConfigPatch({}, patch);

    expect(next.agents?.entries?.ops?.model).toEqual({
      primary: "google/gemini-3.1-pro-preview",
      fallbacks: ["google/gemini-3.1-pro-preview"],
    });
    expect(next.agents?.entries?.ops?.models).toEqual({
      "google/gemini-3.1-pro-preview": {
        alias: "ops-gemini",
      },
    });
  });

  it("normalizes retired Google Gemini provider catalog rows from provider config patches", () => {
    const patch = {
      models: {
        providers: {
          google: {
            baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
            api: "openai-completions",
            apiKey: "GOOGLE_API_KEY",
            models: [
              {
                id: "google/gemini-3-pro-preview",
                name: "Gemini 3 Pro Preview",
                input: ["text", "image"],
                reasoning: true,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 1_048_576,
                maxTokens: 65_536,
              },
            ],
          },
        },
      },
    } satisfies OpenClawConfig;

    const next = applyProviderAuthConfigPatch({}, patch, { providerConfigNormalizer });

    expect(next.models?.providers?.google?.models?.[0]?.id).toBe("google/gemini-3.1-pro-preview");
    expect(next.models?.providers?.google?.api).toBe("openai-completions");
  });

  it("normalizes nested retired Gemini provider catalog rows from proxy config patches", () => {
    const patch = {
      models: {
        providers: {
          kilocode: {
            baseUrl: "https://proxy.example/v1",
            api: "openai-completions",
            apiKey: "KILOCODE_API_KEY",
            models: [
              {
                id: "google/gemini-3-pro-preview",
                name: "Gemini via Kilo",
                input: ["text", "image"],
                reasoning: true,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 1_048_576,
                maxTokens: 65_536,
              },
            ],
          },
        },
      },
    } satisfies OpenClawConfig;

    const next = applyProviderAuthConfigPatch({}, patch, { providerConfigNormalizer });

    expect(next.models?.providers?.kilocode?.models?.[0]?.id).toBe("google/gemini-3.1-pro-preview");
  });
});
