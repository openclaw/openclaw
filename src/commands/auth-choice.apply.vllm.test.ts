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
    const unchangedConfig = {
      agents: {
        defaults: {
          model: { primary: "anthropic/claude-opus-4-6" },
        },
      },
      models: {
        providers: {},
      },
    } satisfies OpenClawConfig;
    promptAndConfigureVllm.mockResolvedValue({
      config: unchangedConfig,
    });

    const result = await applyAuthChoiceVllm({
      authChoice: "vllm",
      config: unchangedConfig,
      prompter: makePrompter(),
      runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() } as never,
      setDefaultModel: false,
    });

    expect(result).toEqual({
      config: unchangedConfig,
    });
  });

  it("clears runtime override when config-only exit removed a stale vLLM provider", async () => {
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
      config: {
        agents: {
          list: [{ id: "work", model: "vllm/model-a" }],
        },
        models: { providers: { vllm: { baseUrl: "http://gpu-box:8000/v1", models: [] } } },
      } as OpenClawConfig,
      prompter: makePrompter(),
      runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() } as never,
      agentId: "work",
      setDefaultModel: false,
    });

    expect(result).toEqual({
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

  it("preserves a non-vLLM override on config-only vLLM exit", async () => {
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
      config: {
        agents: {
          list: [{ id: "work", model: "openai/gpt-5.3-codex" }],
        },
        models: { providers: { vllm: { baseUrl: "http://gpu-box:8000/v1", models: [] } } },
      } as OpenClawConfig,
      prompter: makePrompter(),
      runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() } as never,
      agentId: "work",
      setDefaultModel: false,
    });

    expect(result).toEqual({
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

  it("prunes stale managed fallbacks from an agent override without clearing the primary", async () => {
    promptAndConfigureVllm.mockResolvedValue({
      config: {
        agents: {
          defaults: {
            model: { primary: "anthropic/claude-opus-4-6" },
          },
          list: [
            {
              id: "work",
              model: {
                primary: "openai/gpt-5.3-codex",
                fallbacks: ["vllm/model-a", "vllm-2/model-b", "anthropic/claude-sonnet-4-5"],
              },
            },
          ],
        },
        models: {
          providers: {},
        },
      } satisfies OpenClawConfig,
    });

    const result = await applyAuthChoiceVllm({
      authChoice: "vllm",
      config: {
        agents: {
          list: [
            {
              id: "work",
              model: {
                primary: "openai/gpt-5.3-codex",
                fallbacks: ["vllm/model-a", "vllm-2/model-b", "anthropic/claude-sonnet-4-5"],
              },
            },
          ],
        },
        models: { providers: { vllm: { baseUrl: "http://gpu-box:8000/v1", models: [] } } },
      } as OpenClawConfig,
      prompter: makePrompter(),
      runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() } as never,
      agentId: "work",
      setDefaultModel: false,
    });

    expect(result).toEqual({
      config: {
        agents: {
          defaults: {
            model: { primary: "anthropic/claude-opus-4-6" },
          },
          list: [
            {
              id: "work",
              model: {
                primary: "openai/gpt-5.3-codex",
                fallbacks: ["anthropic/claude-sonnet-4-5"],
              },
            },
          ],
        },
        models: {
          providers: {},
        },
      },
    });
  });

  it("keeps an agent override when pruning promotes a valid fallback", async () => {
    promptAndConfigureVllm.mockResolvedValue({
      config: {
        agents: {
          defaults: {
            model: { primary: "anthropic/claude-opus-4-6" },
          },
          list: [
            {
              id: "work",
              model: {
                primary: "vllm/model-a",
                fallbacks: ["anthropic/claude-sonnet-4-5"],
              },
            },
          ],
        },
        models: {
          providers: {},
        },
      } satisfies OpenClawConfig,
    });

    const result = await applyAuthChoiceVllm({
      authChoice: "vllm",
      config: {
        agents: {
          list: [
            {
              id: "work",
              model: {
                primary: "vllm/model-a",
                fallbacks: ["anthropic/claude-sonnet-4-5"],
              },
            },
          ],
        },
        models: { providers: { vllm: { baseUrl: "http://gpu-box:8000/v1", models: [] } } },
      } as OpenClawConfig,
      prompter: makePrompter(),
      runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() } as never,
      agentId: "work",
      setDefaultModel: false,
    });

    expect(result).toEqual({
      config: {
        agents: {
          defaults: {
            model: { primary: "anthropic/claude-opus-4-6" },
          },
          list: [
            {
              id: "work",
              model: {
                primary: "anthropic/claude-sonnet-4-5",
              },
            },
          ],
        },
        models: {
          providers: {},
        },
      },
    });
  });

  it("prunes stale managed vLLM overrides for all agents when no agent id is provided", async () => {
    promptAndConfigureVllm.mockResolvedValue({
      config: {
        agents: {
          defaults: {
            model: { primary: "anthropic/claude-opus-4-6" },
          },
          list: [
            { id: "kept", model: "openai/gpt-5.3-codex" },
            { id: "removed", model: "vllm/model-a" },
            {
              id: "pruned",
              model: {
                primary: "anthropic/claude-sonnet-4-5",
                fallbacks: ["vllm/model-a", "openai/gpt-5.3-codex"],
              },
            },
          ],
        },
        models: {
          providers: {},
        },
      } satisfies OpenClawConfig,
    });

    const result = await applyAuthChoiceVllm({
      authChoice: "vllm",
      config: {
        agents: {
          list: [
            { id: "kept", model: "openai/gpt-5.3-codex" },
            { id: "removed", model: "vllm/model-a" },
            {
              id: "pruned",
              model: {
                primary: "anthropic/claude-sonnet-4-5",
                fallbacks: ["vllm/model-a", "openai/gpt-5.3-codex"],
              },
            },
          ],
        },
        models: { providers: { vllm: { baseUrl: "http://gpu-box:8000/v1", models: [] } } },
      } as OpenClawConfig,
      prompter: makePrompter(),
      runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() } as never,
      setDefaultModel: false,
    });

    expect(result).toEqual({
      config: {
        agents: {
          defaults: {
            model: { primary: "anthropic/claude-opus-4-6" },
          },
          list: [
            { id: "kept", model: "openai/gpt-5.3-codex" },
            { id: "removed" },
            {
              id: "pruned",
              model: {
                primary: "anthropic/claude-sonnet-4-5",
                fallbacks: ["openai/gpt-5.3-codex"],
              },
            },
          ],
        },
        models: {
          providers: {},
        },
      },
    });
  });
});
