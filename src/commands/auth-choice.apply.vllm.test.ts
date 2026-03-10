import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { applyAuthChoiceVllm } from "./auth-choice.apply.vllm.js";
import { makePrompter } from "./onboarding/__tests__/test-utils.js";

const promptAndConfigureVllm = vi.hoisted(() => vi.fn());

vi.mock("./vllm-setup.js", () => ({
  promptAndConfigureVllm,
}));

describe("applyAuthChoiceVllm", () => {
  it("clears a stale default vLLM model when setup exits with config-only changes", async () => {
    promptAndConfigureVllm.mockResolvedValue({
      config: {
        agents: {
          defaults: {
            model: {
              primary: "vllm/model-a",
              fallbacks: ["anthropic/claude-sonnet-4-5"],
            },
          },
        },
        models: {
          providers: {},
        },
      } satisfies OpenClawConfig,
    });

    const result = await applyAuthChoiceVllm({
      authChoice: "vllm",
      config: {} as OpenClawConfig,
      prompter: makePrompter(),
      runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() } as never,
      setDefaultModel: true,
    });

    expect(result).toEqual({
      clearAgentModelOverride: true,
      config: {
        agents: {
          defaults: {
            model: {
              primary: "anthropic/claude-sonnet-4-5",
            },
          },
        },
        models: {
          providers: {},
        },
      },
    });
  });

  it("clears runtime override when setup exits without a selected model", async () => {
    promptAndConfigureVllm.mockResolvedValue({
      config: {
        agents: {
          defaults: {
            model: { primary: "anthropic/claude-opus-4-6" },
          },
        },
        models: {
          providers: {},
        },
      } satisfies OpenClawConfig,
    });

    const result = await applyAuthChoiceVllm({
      authChoice: "vllm",
      config: {} as OpenClawConfig,
      prompter: makePrompter(),
      runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() } as never,
      setDefaultModel: false,
    });

    expect(result).toEqual({
      clearAgentModelOverride: true,
      config: {
        agents: {
          defaults: {
            model: { primary: "anthropic/claude-opus-4-6" },
          },
        },
        models: {
          providers: {},
        },
      },
    });
  });
});
