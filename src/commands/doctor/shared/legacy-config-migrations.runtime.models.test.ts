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

    migration!.apply(raw, changes);

    expect(raw.models.providers.deepseek.models[0].contextWindow).toBe(1_000_000);
    expect(changes).toHaveLength(1);
    expect(changes[0]).toContain("200000 → 1000000");
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

  it("handles provider-prefixed model IDs", () => {
    const changes: string[] = [];
    const raw = {
      models: {
        providers: {
          opencode: {
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

    expect(raw.models.providers.opencode.models[0].contextWindow).toBe(1_000_000);
    expect(changes).toHaveLength(1);
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
