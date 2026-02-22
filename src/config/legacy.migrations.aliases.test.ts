import { describe, expect, it } from "vitest";
import { applyLegacyMigrations } from "./legacy.js";

describe("aliases migration", () => {
  it("migrates top-level aliases to agents.defaults.models.*.alias", () => {
    const raw = {
      aliases: {
        fast: "ollama/minimax-m2.5:cloud",
        deep: "ollama/kimi-k2.5:cloud",
      },
    };

    const { next, changes } = applyLegacyMigrations(raw);

    expect(next).not.toBeNull();
    expect(next?.aliases).toBeUndefined();
    expect(next?.agents?.defaults?.models?.["ollama/minimax-m2.5:cloud"]?.alias).toBe("fast");
    expect(next?.agents?.defaults?.models?.["ollama/kimi-k2.5:cloud"]?.alias).toBe("deep");
    expect(changes).toContain("Migrated aliases → agents.defaults.models.*.alias.");
  });

  it("does not overwrite existing alias", () => {
    const raw = {
      aliases: {
        fast: "ollama/minimax-m2.5:cloud",
      },
      agents: {
        defaults: {
          models: {
            "ollama/minimax-m2.5:cloud": { alias: "minimax" },
          },
        },
      },
    };

    const { next } = applyLegacyMigrations(raw);

    expect(next).not.toBeNull();
    // Existing alias should be preserved
    expect(next?.agents?.defaults?.models?.["ollama/minimax-m2.5:cloud"]?.alias).toBe("minimax");
  });

  it("handles empty aliases", () => {
    const raw = {
      aliases: {},
    };

    const { next, changes } = applyLegacyMigrations(raw);

    // No migration should happen for empty aliases
    expect(next).toBeNull();
    expect(changes).toHaveLength(0);
  });

  it("handles aliases with invalid values", () => {
    const raw = {
      aliases: {
        fast: "ollama/minimax-m2.5:cloud",
        invalid: 123, // Should be skipped
        empty: "", // Should be skipped
      },
    };

    const { next } = applyLegacyMigrations(raw);

    expect(next).not.toBeNull();
    expect(next?.agents?.defaults?.models?.["ollama/minimax-m2.5:cloud"]?.alias).toBe("fast");
    // Invalid entries should not create model entries
    expect(Object.keys(next?.agents?.defaults?.models ?? {})).toHaveLength(1);
  });

  it("preserves other config when migrating aliases", () => {
    const raw = {
      aliases: {
        opus: "anthropic/claude-opus-4-6",
      },
      agents: {
        defaults: {
          model: { primary: "anthropic/claude-sonnet-4-5" },
        },
      },
      env: {
        ANTHROPIC_API_KEY: "sk-test",
      },
    };

    const { next } = applyLegacyMigrations(raw);

    expect(next).not.toBeNull();
    expect(next?.aliases).toBeUndefined();
    expect(next?.agents?.defaults?.model?.primary).toBe("anthropic/claude-sonnet-4-5");
    expect(next?.agents?.defaults?.models?.["anthropic/claude-opus-4-6"]?.alias).toBe("opus");
    expect(next?.env?.ANTHROPIC_API_KEY).toBe("sk-test");
  });
});
