import { describe, it, expect } from "vitest";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { normalizeLegacyProviderApi } from "./legacy-config-provider-api-migrate.js";

function makeConfigWithProviderApi(providerId: string, api: string): OpenClawConfig {
  return {
    models: {
      providers: {
        [providerId]: {
          baseUrl: "https://example.com/v1",
          api,
          models: [
            {
              id: "test-model",
              name: "Test Model",
              reasoning: false,
              input: ["text"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 4096,
              maxTokens: 4096,
            },
          ],
        },
      },
    },
  } as unknown as OpenClawConfig;
}

describe("normalizeLegacyProviderApi", () => {
  it("migrates stale 'openai' api value to 'openai-completions'", () => {
    const cfg = makeConfigWithProviderApi("openrouter", "openai");
    const changes: string[] = [];
    const result = normalizeLegacyProviderApi(cfg, changes);

    expect(result.models!.providers!["openrouter"].api).toBe("openai-completions");
    expect(changes).toHaveLength(1);
    expect(changes[0]).toContain('"openai" → "openai-completions"');
  });

  it("does not migrate already-valid api values", () => {
    const cfg = makeConfigWithProviderApi("openrouter", "openai-completions");
    const changes: string[] = [];
    const result = normalizeLegacyProviderApi(cfg, changes);

    expect(result.models!.providers!["openrouter"].api).toBe("openai-completions");
    expect(changes).toHaveLength(0);
  });

  it("does not migrate unknown stale values", () => {
    const cfg = makeConfigWithProviderApi("custom", "some-unknown-api");
    const changes: string[] = [];
    const result = normalizeLegacyProviderApi(cfg, changes);

    expect(result.models!.providers!["custom"].api).toBe("some-unknown-api");
    expect(changes).toHaveLength(0);
  });

  it("handles config without providers gracefully", () => {
    const cfg = { models: {} } as unknown as OpenClawConfig;
    const changes: string[] = [];
    const result = normalizeLegacyProviderApi(cfg, changes);
    expect(result).toBe(cfg);
    expect(changes).toHaveLength(0);
  });

  it("handles config without models gracefully", () => {
    const cfg = {} as unknown as OpenClawConfig;
    const changes: string[] = [];
    const result = normalizeLegacyProviderApi(cfg, changes);
    expect(result).toBe(cfg);
    expect(changes).toHaveLength(0);
  });

  it("migrates stale provider while leaving valid providers untouched", () => {
    const cfg = {
      models: {
        providers: {
          openrouter: {
            baseUrl: "https://openrouter.ai/api/v1",
            api: "openai",
            models: [],
          },
          custom: {
            baseUrl: "https://custom.api/v1",
            api: "openai-completions",
            models: [],
          },
        },
      },
    } as unknown as OpenClawConfig;
    const changes: string[] = [];
    const result = normalizeLegacyProviderApi(cfg, changes);

    expect(result.models!.providers!["openrouter"].api).toBe("openai-completions");
    expect(result.models!.providers!["custom"].api).toBe("openai-completions");
    expect(changes).toHaveLength(1);
  });

  it("skips providers without an api field", () => {
    const cfg = {
      models: {
        providers: {
          ollama: {
            baseUrl: "http://localhost:11434",
            models: [],
          },
        },
      },
    } as unknown as OpenClawConfig;
    const changes: string[] = [];
    const result = normalizeLegacyProviderApi(cfg, changes);
    expect(result).toBe(cfg);
    expect(changes).toHaveLength(0);
  });
});
