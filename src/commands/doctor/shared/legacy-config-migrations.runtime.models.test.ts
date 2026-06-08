// Runtime model migration tests cover doctor legacy config migrations for model runtime shape.
import { describe, it, expect } from "vitest";
import { LEGACY_CONFIG_MIGRATIONS_RUNTIME_MODELS } from "./legacy-config-migrations.runtime.models.js";

describe("stale contextWindow migration", () => {
  const migration = LEGACY_CONFIG_MIGRATIONS_RUNTIME_MODELS.find(
    (m) => m.id === "models.providers.*.models.*.contextWindow-stale",
  );

  it("repairs deepseek-v4-flash contextWindow from 200K to 1M", () => {
    const changes: string[] = [];
    const raw = {
      models: {
        providers: {
          deepseek: {
            models: [
              {
                id: "deepseek-v4-flash",
                contextWindow: 200_000,
                maxTokens: 61_440,
              },
            ],
          },
        },
      },
    };

    expect(migration!.legacyRules?.[0]?.match?.(raw.models.providers, raw)).toBe(true);

    migration!.apply(raw, changes);

    expect(raw.models.providers.deepseek.models[0].contextWindow).toBe(1_000_000);
    expect(changes).toHaveLength(1);
    expect(changes[0]).toContain("200000 → 1000000");
    expect(migration!.legacyRules?.[0]?.match?.(raw.models.providers, raw)).toBe(false);
  });

  it("does not modify correct contextWindow values", () => {
    const changes: string[] = [];
    const raw = {
      models: {
        providers: {
          deepseek: {
            models: [
              {
                id: "deepseek-v4-flash",
                contextWindow: 1_000_000,
                maxTokens: 61_440,
              },
            ],
          },
        },
      },
    };

    migration!.apply(raw, changes);

    expect(raw.models.providers.deepseek.models[0].contextWindow).toBe(1_000_000);
    expect(changes).toHaveLength(0);
  });

  it("preserves non-stale custom contextWindow values", () => {
    const changes: string[] = [];
    const raw = {
      models: {
        providers: {
          deepseek: {
            models: [
              {
                id: "deepseek-v4-flash",
                contextWindow: 500_000,
                maxTokens: 61_440,
              },
            ],
          },
        },
      },
    };

    migration!.apply(raw, changes);

    expect(raw.models.providers.deepseek.models[0].contextWindow).toBe(500_000);
    expect(changes).toHaveLength(0);
  });

  it("does not modify bare ids from other providers", () => {
    const changes: string[] = [];
    const raw = {
      models: {
        providers: {
          custom: {
            models: [
              {
                id: "deepseek-v4-flash",
                contextWindow: 200_000,
                maxTokens: 61_440,
              },
            ],
          },
        },
      },
    };

    migration!.apply(raw, changes);

    expect(raw.models.providers.custom.models[0].contextWindow).toBe(200_000);
    expect(changes).toHaveLength(0);
    expect(migration!.legacyRules?.[0]?.match?.(raw.models.providers, raw)).toBe(false);
  });

  it("handles provider-prefixed model IDs under the native provider", () => {
    const changes: string[] = [];
    const raw = {
      models: {
        providers: {
          deepseek: {
            models: [
              {
                id: "deepseek/deepseek-v4-flash",
                contextWindow: 200_000,
                maxTokens: 61_440,
              },
            ],
          },
        },
      },
    };

    migration!.apply(raw, changes);

    expect(raw.models.providers.deepseek.models[0].contextWindow).toBe(1_000_000);
    expect(changes).toHaveLength(1);
  });

  it("does not modify provider-prefixed ids from other providers", () => {
    const changes: string[] = [];
    const raw = {
      models: {
        providers: {
          openrouter: {
            models: [
              {
                id: "deepseek/deepseek-v4-flash",
                contextWindow: 200_000,
                maxTokens: 61_440,
              },
            ],
          },
        },
      },
    };

    migration!.apply(raw, changes);

    expect(raw.models.providers.openrouter.models[0].contextWindow).toBe(200_000);
    expect(changes).toHaveLength(0);
    expect(migration!.legacyRules?.[0]?.match?.(raw.models.providers, raw)).toBe(false);
  });

  it("skips models not in the stale fixes registry", () => {
    const changes: string[] = [];
    const raw = {
      models: {
        providers: {
          openai: {
            models: [
              {
                id: "gpt-4o",
                contextWindow: 128_000,
                maxTokens: 16_384,
              },
            ],
          },
        },
      },
    };

    migration!.apply(raw, changes);

    expect(raw.models.providers.openai.models[0].contextWindow).toBe(128_000);
    expect(changes).toHaveLength(0);
  });

  it("handles missing providers gracefully", () => {
    const changes: string[] = [];
    const raw = {};

    migration!.apply(raw, changes);

    expect(changes).toHaveLength(0);
  });

  it("handles non-array models gracefully", () => {
    const changes: string[] = [];
    const raw = {
      models: {
        providers: {
          deepseek: {
            models: "not-an-array",
          },
        },
      },
    };

    migration!.apply(raw, changes);

    expect(changes).toHaveLength(0);
  });

  it("handles missing model id gracefully", () => {
    const changes: string[] = [];
    const raw = {
      models: {
        providers: {
          deepseek: {
            models: [
              {
                contextWindow: 200_000,
              },
            ],
          },
        },
      },
    };

    migration!.apply(raw, changes);

    expect(changes).toHaveLength(0);
  });
});

describe("legacy codex context metadata migration", () => {
  const migration = LEGACY_CONFIG_MIGRATIONS_RUNTIME_MODELS.find(
    (m) => m.id === "models.providers.openai-codex->models.providers.openai",
  );

  it("copies model with contextTokens when canonical openai provider has empty models", () => {
    const changes: string[] = [];
    const raw = {
      models: {
        providers: {
          openai: {
            models: [],
          },
          "openai-codex": {
            models: [
              { id: "gpt-5.5", contextTokens: 200_000, contextWindow: 200_000, maxTokens: 8_192 },
            ],
          },
        },
      },
    };

    migration!.apply(raw, changes);

    const openaiProvider = (
      (raw.models as Record<string, unknown>).providers as Record<string, unknown>
    ).openai as Record<string, unknown>;
    const openaiModels = Array.isArray(openaiProvider.models) ? openaiProvider.models : [];
    expect(openaiModels).toHaveLength(1);
    expect(openaiModels[0]).toMatchObject({
      id: "gpt-5.5",
      contextTokens: 200_000,
      contextWindow: 200_000,
      maxTokens: 8_192,
    });
    expect(changes.filter((c) => c.includes("Copied"))).toHaveLength(1);
  });

  it("merges missing contextTokens into existing canonical model entry", () => {
    const changes: string[] = [];
    const raw = {
      models: {
        providers: {
          openai: {
            models: [{ id: "gpt-5.5", maxTokens: 8_192 }],
          },
          "openai-codex": {
            models: [{ id: "gpt-5.5", contextTokens: 200_000, contextWindow: 200_000 }],
          },
        },
      },
    };

    migration!.apply(raw, changes);

    const openaiProvider = (
      (raw.models as Record<string, unknown>).providers as Record<string, unknown>
    ).openai as Record<string, unknown>;
    const openaiModels = openaiProvider.models as Record<string, unknown>[];
    expect(openaiModels).toHaveLength(1);
    expect(openaiModels[0].contextTokens).toBe(200_000);
    expect(openaiModels[0].contextWindow).toBe(200_000);
    expect(changes).toHaveLength(2);
    expect(changes.some((c) => c.startsWith("Merged"))).toBe(true);
  });

  it("does not overwrite explicit context metadata on canonical model", () => {
    const changes: string[] = [];
    const raw = {
      models: {
        providers: {
          openai: {
            models: [
              { id: "gpt-5.5", contextTokens: 128_000, contextWindow: 128_000, maxTokens: 8_192 },
            ],
          },
          "openai-codex": {
            models: [{ id: "gpt-5.5", contextTokens: 200_000, contextWindow: 200_000 }],
          },
        },
      },
    };

    migration!.apply(raw, changes);

    const openaiProvider = (
      (raw.models as Record<string, unknown>).providers as Record<string, unknown>
    ).openai as Record<string, unknown>;
    const openaiModels = openaiProvider.models as Record<string, unknown>[];
    expect(openaiModels[0].contextTokens).toBe(128_000);
    expect(openaiModels[0].contextWindow).toBe(128_000);
    expect(changes.filter((c) => c.includes("openai-codex"))).toHaveLength(1);
    expect(changes[changes.length - 1]).toContain("Removed");
  });

  it("handles no openai-codex provider gracefully", () => {
    const changes: string[] = [];
    const raw = {
      models: {
        providers: {
          openai: {
            models: [{ id: "gpt-5.5", contextTokens: 128_000 }],
          },
        },
      },
    };

    migration!.apply(raw, changes);

    expect(changes).toHaveLength(0);
  });
});
