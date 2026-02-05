import { describe, expect, it } from "vitest";
import {
  applyOpenAIConfig,
  applyOpenAIProviderConfig,
  OPENAI_DEFAULT_MODEL,
} from "./openai-model-default.js";

describe("applyOpenAIProviderConfig", () => {
  it("adds allowlist entry for default model", () => {
    const next = applyOpenAIProviderConfig({});
    expect(Object.keys(next.agents?.defaults?.models ?? {})).toContain(OPENAI_DEFAULT_MODEL);
  });

  it("preserves existing alias for default model", () => {
    const next = applyOpenAIProviderConfig({
      agents: {
        defaults: {
          models: {
            [OPENAI_DEFAULT_MODEL]: { alias: "My GPT" },
          },
        },
      },
    });
    expect(next.agents?.defaults?.models?.[OPENAI_DEFAULT_MODEL]?.alias).toBe("My GPT");
  });
});

describe("applyOpenAIConfig", () => {
  it("sets default when model is unset", () => {
    const next = applyOpenAIConfig({});
    expect(next.agents?.defaults?.model).toEqual({ primary: OPENAI_DEFAULT_MODEL });
  });

  it("overrides model.primary when model object already exists", () => {
    const next = applyOpenAIConfig({
      agents: { defaults: { model: { primary: "anthropic/claude-opus-4-6", fallback: [] } } },
    });
    expect(next.agents?.defaults?.model).toEqual({ primary: OPENAI_DEFAULT_MODEL, fallback: [] });
  });
});
