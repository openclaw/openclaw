import { describe, expect, it, vi } from "vitest";
import type { ApplyAuthChoiceParams } from "./auth-choice.apply.js";
import { applyAuthChoiceOllama } from "./auth-choice.apply.ollama.js";

type PromptAndConfigureOllama = typeof import("./ollama-setup.js").promptAndConfigureOllama;

const promptAndConfigureOllama = vi.hoisted(() =>
  vi.fn<PromptAndConfigureOllama>(async ({ cfg }) => ({
    config: cfg,
    defaultModelId: "qwen3.5:35b",
  })),
);
const ensureOllamaModelPulled = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("./ollama-setup.js", () => ({
  promptAndConfigureOllama,
  ensureOllamaModelPulled,
}));

function buildParams(overrides: Partial<ApplyAuthChoiceParams> = {}): ApplyAuthChoiceParams {
  return {
    authChoice: "ollama",
    config: {},
    prompter: {} as ApplyAuthChoiceParams["prompter"],
    runtime: {} as ApplyAuthChoiceParams["runtime"],
    setDefaultModel: false,
    ...overrides,
  };
}

describe("applyAuthChoiceOllama", () => {
  it("returns agentModelOverride when setDefaultModel is false", async () => {
    const config = { agents: { defaults: { model: { primary: "openai/gpt-4o-mini" } } } };
    promptAndConfigureOllama.mockResolvedValueOnce({
      config,
      defaultModelId: "qwen2.5-coder:7b",
    });

    const result = await applyAuthChoiceOllama(
      buildParams({
        config,
        setDefaultModel: false,
      }),
    );

    expect(result).toEqual({
      config,
      agentModelOverride: "ollama/qwen2.5-coder:7b",
    });
    // Pull is deferred — the wizard model picker handles it.
    expect(ensureOllamaModelPulled).not.toHaveBeenCalled();
  });

  it("sets global default model and preserves fallbacks when setDefaultModel is true", async () => {
    const config = {
      agents: {
        defaults: {
          model: {
            primary: "openai/gpt-4o-mini",
            fallbacks: ["anthropic/claude-sonnet-4-5"],
          },
        },
      },
    };
    promptAndConfigureOllama.mockResolvedValueOnce({
      config,
      defaultModelId: "qwen2.5-coder:7b",
    });

    const result = await applyAuthChoiceOllama(
      buildParams({
        config,
        setDefaultModel: true,
      }),
    );

    expect(result?.agentModelOverride).toBeUndefined();
    expect(result?.config.agents?.defaults?.model).toEqual({
      primary: "ollama/qwen2.5-coder:7b",
      fallbacks: ["anthropic/claude-sonnet-4-5"],
    });
    expect(ensureOllamaModelPulled).toHaveBeenCalledOnce();
  });
});
