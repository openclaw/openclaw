import { describe, expect, it } from "vitest";
import { applyModelDefaults } from "./defaults.js";
import type { ClawdbotConfig } from "./types.js";

describe("applyModelDefaults", () => {
  it("adds default aliases when models are present", () => {
    const cfg = {
      agents: {
        defaults: {
          models: {
            "anthropic/claude-opus-4-5": {},
            "openai/gpt-5.2": {},
          },
        },
      },
    } satisfies ClawdbotConfig;
    const next = applyModelDefaults(cfg);

    expect(next.agents?.defaults?.models?.["anthropic/claude-opus-4-5"]?.alias).toBe("opus");
    expect(next.agents?.defaults?.models?.["openai/gpt-5.2"]?.alias).toBe("gpt");
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
    } satisfies ClawdbotConfig;

    const next = applyModelDefaults(cfg);

    expect(next.agents?.defaults?.models?.["anthropic/claude-opus-4-5"]?.alias).toBe("Opus");
  });

  it("respects explicit empty alias disables", () => {
    const cfg = {
      agents: {
        defaults: {
          models: {
            "google/gemini-3-pro-preview": { alias: "" },
            "google/gemini-3-flash-preview": {},
          },
        },
      },
    } satisfies ClawdbotConfig;

    const next = applyModelDefaults(cfg);

    expect(next.agents?.defaults?.models?.["google/gemini-3-pro-preview"]?.alias).toBe("");
    expect(next.agents?.defaults?.models?.["google/gemini-3-flash-preview"]?.alias).toBe(
      "gemini-flash",
    );
  });
});
