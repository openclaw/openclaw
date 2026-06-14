import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { collectPromptCacheConfigWarnings } from "./prompt-cache-config-warnings.js";

function baseCacheTtlConfig(model: string): OpenClawConfig {
  return {
    agents: {
      defaults: {
        model: { primary: model },
        contextPruning: { mode: "cache-ttl", ttl: "1h" },
        heartbeat: { every: "1h" },
      },
    },
  };
}

function openAiCompatibleModel(id: string) {
  return {
    id,
    name: id,
    api: "openai-completions" as const,
    reasoning: true,
    input: ["text" as const],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1_048_576,
    maxTokens: 65_536,
  };
}

function anthropicConfiguredModel(id: string) {
  return {
    id,
    name: id,
    reasoning: true,
    input: ["text" as const],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200_000,
    maxTokens: 8_192,
  };
}

describe("collectPromptCacheConfigWarnings", () => {
  it("warns when Anthropic short cache retention cannot satisfy a longer cache-ttl window", () => {
    const cfg: OpenClawConfig = {
      ...baseCacheTtlConfig("anthropic/claude-sonnet-4-6"),
      agents: {
        defaults: {
          ...baseCacheTtlConfig("anthropic/claude-sonnet-4-6").agents?.defaults,
          models: {
            "anthropic/claude-sonnet-4-6": { params: { cacheRetention: "short" } },
          },
        },
      },
    };

    expect(collectPromptCacheConfigWarnings(cfg)).toEqual([
      expect.stringContaining(
        'agents.defaults.contextPruning.ttl="1h" is longer than anthropic/claude-sonnet-4-6\'s effective short prompt-cache retention',
      ),
    ]);
    expect(collectPromptCacheConfigWarnings(cfg)[0]).toContain(
      'agents.defaults.heartbeat.every="1h" cannot refresh it before that cache usually expires',
    );
  });

  it("does not warn when long cache retention has a shorter heartbeat", () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          model: { primary: "anthropic/claude-opus-4-6" },
          contextPruning: { mode: "cache-ttl", ttl: "1h" },
          heartbeat: { every: "55m" },
          models: {
            "anthropic/claude-opus-4-6": { params: { cacheRetention: "long" } },
          },
        },
      },
    };

    expect(collectPromptCacheConfigWarnings(cfg)).toEqual([]);
  });

  it("strips auth-profile suffixes before resolving model cache params", () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          model: { primary: "anthropic/claude-opus-4-6@work" },
          contextPruning: { mode: "cache-ttl", ttl: "1h" },
          heartbeat: { every: "55m" },
          models: {
            "anthropic/claude-opus-4-6": { params: { cacheRetention: "long" } },
          },
        },
      },
    };

    expect(collectPromptCacheConfigWarnings(cfg)).toEqual([]);
  });

  it("resolves configured aliases before checking cache params", () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          model: { primary: "opus" },
          contextPruning: { mode: "cache-ttl", ttl: "1h" },
          heartbeat: { every: "55m" },
          models: {
            "anthropic/claude-opus-4-6": {
              alias: "opus",
              params: { cacheRetention: "long" },
            },
          },
        },
      },
    };

    expect(collectPromptCacheConfigWarnings(cfg)).toEqual([]);
  });

  it("warns when long cache retention has a heartbeat at the cache boundary", () => {
    const cfg: OpenClawConfig = {
      ...baseCacheTtlConfig("anthropic/claude-opus-4-6"),
      agents: {
        defaults: {
          ...baseCacheTtlConfig("anthropic/claude-opus-4-6").agents?.defaults,
          models: {
            "anthropic/claude-opus-4-6": { params: { cacheRetention: "long" } },
          },
        },
      },
    };

    expect(collectPromptCacheConfigWarnings(cfg)).toEqual([
      expect.stringContaining(
        'agents.defaults.heartbeat.every="1h" is not shorter than anthropic/claude-opus-4-6\'s effective long prompt-cache retention',
      ),
    ]);
  });

  it("warns when cache-ttl pruning is configured for OpenAI-family models", () => {
    const cfg = baseCacheTtlConfig("openai/gpt-5.1-codex");

    expect(collectPromptCacheConfigWarnings(cfg)).toEqual([
      expect.stringContaining(
        'agents.defaults.model.primary uses openai/gpt-5.1-codex, but agents.defaults.contextPruning.mode="cache-ttl" does not currently run for OpenAI-family models',
      ),
    ]);
  });

  it("warns for the runtime default model when no default model is configured", () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          contextPruning: { mode: "cache-ttl" },
        },
      },
    };

    expect(collectPromptCacheConfigWarnings(cfg)).toEqual([
      expect.stringContaining(
        'agents.defaults.model (resolved default) uses openai/gpt-5.5, but agents.defaults.contextPruning.mode="cache-ttl" does not currently run for OpenAI-family models',
      ),
    ]);
  });

  it("resolves bare primary refs before checking qualified fallbacks", () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          model: {
            primary: "gpt-5.5",
            fallbacks: ["anthropic/claude-sonnet-4-6"],
          },
          contextPruning: { mode: "cache-ttl", ttl: "5m" },
          heartbeat: { every: "4m" },
        },
      },
    };

    expect(collectPromptCacheConfigWarnings(cfg)).toEqual(
      expect.arrayContaining([
        expect.stringContaining(
          'agents.defaults.model.primary (resolved) uses openai/gpt-5.5, but agents.defaults.contextPruning.mode="cache-ttl" does not currently run for OpenAI-family models',
        ),
      ]),
    );
  });

  it("resolves bare fallback refs against the selected provider", () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          model: {
            primary: "anthropic/claude-opus-4-6",
            fallbacks: ["claude-sonnet-4-6"],
          },
          contextPruning: { mode: "cache-ttl", ttl: "1h" },
          heartbeat: { every: "55m" },
          models: {
            "anthropic/claude-opus-4-6": { params: { cacheRetention: "long" } },
          },
        },
      },
    };

    expect(collectPromptCacheConfigWarnings(cfg)).toEqual([
      expect.stringContaining(
        "anthropic/claude-sonnet-4-6's effective short prompt-cache retention (about 5m) for agents.defaults.model.fallbacks.0 (resolved)",
      ),
    ]);
  });

  it("warns for configured provider fallback models when no default model is configured", () => {
    const cfg: OpenClawConfig = {
      models: {
        providers: {
          anthropic: {
            baseUrl: "https://api.anthropic.com",
            models: [anthropicConfiguredModel("claude-sonnet-4-6")],
          },
        },
      },
      agents: {
        defaults: {
          contextPruning: { mode: "cache-ttl" },
        },
      },
    };

    expect(collectPromptCacheConfigWarnings(cfg)).toEqual([
      expect.stringContaining(
        'agents.defaults.heartbeat.every="30m" is not shorter than anthropic/claude-sonnet-4-6\'s effective short prompt-cache retention',
      ),
    ]);
  });

  it("warns when a configured provider route uses an OpenAI-compatible API", () => {
    const cfg: OpenClawConfig = {
      ...baseCacheTtlConfig("google/gemini-3.1-pro-preview"),
      models: {
        providers: {
          google: {
            baseUrl: "https://proxy.example/v1",
            api: "openai-completions",
            models: [openAiCompatibleModel("gemini-3.1-pro-preview")],
          },
        },
      },
    };

    expect(collectPromptCacheConfigWarnings(cfg)).toEqual([
      expect.stringContaining(
        'agents.defaults.model.primary uses google/gemini-3.1-pro-preview, but agents.defaults.contextPruning.mode="cache-ttl" does not currently run for OpenAI-family models',
      ),
    ]);
  });

  it("warns for Moonshot models because runtime cache-ttl pruning is not enabled there", () => {
    const cfg = baseCacheTtlConfig("moonshot/kimi-k2.5");

    expect(collectPromptCacheConfigWarnings(cfg)).toEqual([
      expect.stringContaining(
        'agents.defaults.model.primary uses moonshot/kimi-k2.5, but agents.defaults.contextPruning.mode="cache-ttl" does not currently run for OpenAI-family models',
      ),
    ]);
  });

  it("warns for channel model overrides that bypass a cacheable default model", () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          model: { primary: "anthropic/claude-opus-4-6" },
          contextPruning: { mode: "cache-ttl", ttl: "1h" },
          heartbeat: { every: "55m" },
          models: {
            "anthropic/claude-opus-4-6": { params: { cacheRetention: "long" } },
          },
        },
      },
      channels: {
        modelByChannel: {
          telegram: { "*": "openai/gpt-5.1-codex" },
        },
      },
    };

    expect(collectPromptCacheConfigWarnings(cfg)).toEqual([
      expect.stringContaining(
        'channels.modelByChannel.telegram.* uses openai/gpt-5.1-codex, but agents.defaults.contextPruning.mode="cache-ttl" does not currently run for OpenAI-family models',
      ),
    ]);
  });

  it("uses runtime cache-ttl eligibility for provider-owned proxy models", () => {
    const cfg = baseCacheTtlConfig("deepinfra/anthropic/claude-sonnet-4-6");

    expect(collectPromptCacheConfigWarnings(cfg)).toEqual([
      expect.stringContaining(
        'agents.defaults.contextPruning.ttl="1h" is longer than deepinfra/anthropic/claude-sonnet-4-6\'s effective short prompt-cache retention',
      ),
    ]);
  });

  it("does not warn for unrelated tool and media model refs", () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          model: { primary: "anthropic/claude-opus-4-6" },
          imageModel: { primary: "openai/gpt-5.1" },
          imageGenerationModel: { primary: "openai/gpt-image-2" },
          pdfModel: { primary: "openai/gpt-5.1" },
          contextPruning: { mode: "cache-ttl", ttl: "1h" },
          heartbeat: { every: "55m" },
          models: {
            "anthropic/claude-opus-4-6": { params: { cacheRetention: "long" } },
          },
        },
      },
    };

    expect(collectPromptCacheConfigWarnings(cfg)).toEqual([]);
  });

  it("honors legacy cacheControlTtl settings that runtime maps to long retention", () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          model: { primary: "anthropic/claude-opus-4-6" },
          contextPruning: { mode: "cache-ttl", ttl: "1h" },
          heartbeat: { every: "55m" },
          models: {
            "anthropic/claude-opus-4-6": { params: { cacheControlTtl: "1h" } },
          },
        },
      },
    };

    expect(collectPromptCacheConfigWarnings(cfg)).toEqual([]);
  });

  it("checks agents that inherit the default model and override cache retention", () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          model: { primary: "anthropic/claude-opus-4-6" },
          contextPruning: { mode: "cache-ttl", ttl: "1h" },
          heartbeat: { every: "55m" },
          models: {
            "anthropic/claude-opus-4-6": { params: { cacheRetention: "long" } },
          },
        },
        list: [{ id: "no-cache", params: { cacheRetention: "none" } }],
      },
    };

    expect(collectPromptCacheConfigWarnings(cfg)).toEqual([
      expect.stringContaining(
        'agents.list.0.model (inherits agents.defaults.model).primary uses anthropic/claude-opus-4-6, but effective cacheRetention is "none"',
      ),
    ]);
  });

  it("checks agents that inherit the default model and override heartbeat cadence", () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          model: { primary: "anthropic/claude-sonnet-4-6" },
          contextPruning: { mode: "cache-ttl", ttl: "5m" },
          heartbeat: { every: "4m" },
        },
        list: [{ id: "slow-heartbeat", heartbeat: { every: "1h" } }],
      },
    };

    expect(collectPromptCacheConfigWarnings(cfg)).toEqual([
      expect.stringContaining(
        'agents.list.0.heartbeat.every="1h" is not shorter than anthropic/claude-sonnet-4-6\'s effective short prompt-cache retention',
      ),
    ]);
  });

  it("does not inherit default fallbacks when an agent owns its primary model", () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          model: {
            primary: "anthropic/claude-opus-4-6",
            fallbacks: ["anthropic/claude-sonnet-4-6"],
          },
          contextPruning: { mode: "cache-ttl", ttl: "5m" },
          heartbeat: { every: "4m" },
          models: {
            "anthropic/claude-opus-4-6": { params: { cacheRetention: "long" } },
          },
        },
        list: [
          {
            id: "strict-agent",
            model: { primary: "anthropic/claude-opus-4-6" },
            heartbeat: { every: "55m" },
          },
        ],
      },
    };

    expect(collectPromptCacheConfigWarnings(cfg)).toEqual([]);
  });

  it("warns when Google cache-ttl models omit explicit cache retention", () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          model: { primary: "google/gemini-3.1-pro-preview" },
          contextPruning: { mode: "cache-ttl", ttl: "5m" },
          heartbeat: { every: "4m" },
        },
      },
    };

    expect(collectPromptCacheConfigWarnings(cfg)).toEqual([
      expect.stringContaining(
        "google/gemini-3.1-pro-preview, but this provider/model needs explicit cacheRetention or cacheControlTtl",
      ),
    ]);
  });

  it("warns when custom Anthropic-compatible cache-ttl models omit explicit cache retention", () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          model: { primary: "litellm/claude-sonnet-4-6" },
          contextPruning: { mode: "cache-ttl", ttl: "5m" },
          heartbeat: { every: "4m" },
        },
      },
      models: {
        providers: {
          litellm: {
            baseUrl: "https://litellm.example.test",
            api: "anthropic-messages",
            models: [anthropicConfiguredModel("claude-sonnet-4-6")],
          },
        },
      },
    };

    expect(collectPromptCacheConfigWarnings(cfg)).toEqual([
      expect.stringContaining(
        "litellm/claude-sonnet-4-6, but this provider/model needs explicit cacheRetention or cacheControlTtl",
      ),
    ]);
  });

  it("uses normalized provider keys when reading configured provider APIs", () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          model: { primary: "myproxy/claude-sonnet-4-6" },
          contextPruning: { mode: "cache-ttl", ttl: "5m" },
          heartbeat: { every: "4m" },
        },
      },
      models: {
        providers: {
          MyProxy: {
            baseUrl: "https://myproxy.example.test",
            models: [
              {
                ...anthropicConfiguredModel("MyProxy/claude-sonnet-4-6"),
                api: "anthropic-messages",
              },
            ],
          },
        },
      },
    };

    expect(collectPromptCacheConfigWarnings(cfg)).toEqual([
      expect.stringContaining(
        "myproxy/claude-sonnet-4-6, but this provider/model needs explicit cacheRetention or cacheControlTtl",
      ),
    ]);
  });

  it("warns when Bedrock Claude cache-ttl models omit explicit cache retention", () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          model: { primary: "amazon-bedrock/us.anthropic.claude-sonnet-4-20250514-v1:0" },
          contextPruning: { mode: "cache-ttl", ttl: "5m" },
          heartbeat: { every: "4m" },
        },
      },
    };

    expect(collectPromptCacheConfigWarnings(cfg)).toEqual([
      expect.stringContaining(
        "amazon-bedrock/us.anthropic.claude-sonnet-4-20250514-v1:0, but this provider/model needs explicit cacheRetention or cacheControlTtl",
      ),
    ]);
  });

  it("defaults direct Anthropic cache-ttl models to short retention", () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          model: { primary: "anthropic/claude-sonnet-4-6" },
          contextPruning: { mode: "cache-ttl", ttl: "5m" },
          heartbeat: { every: "4m" },
        },
      },
    };

    expect(collectPromptCacheConfigWarnings(cfg)).toEqual([]);
  });

  it("ignores model catalog metadata entries that are not active model refs", () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          model: { primary: "anthropic/claude-opus-4-6" },
          contextPruning: { mode: "cache-ttl", ttl: "1h" },
          heartbeat: { every: "55m" },
          models: {
            "anthropic/claude-opus-4-6": { params: { cacheRetention: "long" } },
            "anthropic/claude-sonnet-4-6": { params: { cacheRetention: "short" } },
          },
        },
      },
    };

    expect(collectPromptCacheConfigWarnings(cfg)).toEqual([]);
  });

  it("uses the runtime default context-pruning ttl when ttl is omitted", () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          model: { primary: "anthropic/claude-sonnet-4-6" },
          contextPruning: { mode: "cache-ttl" },
          heartbeat: { every: "1h" },
        },
      },
    };

    expect(collectPromptCacheConfigWarnings(cfg)).toEqual([
      expect.stringContaining(
        'agents.defaults.heartbeat.every="1h" is not shorter than anthropic/claude-sonnet-4-6\'s effective short prompt-cache retention',
      ),
    ]);
  });

  it("uses the runtime default heartbeat cadence when heartbeat is omitted", () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          model: { primary: "anthropic/claude-sonnet-4-6" },
          contextPruning: { mode: "cache-ttl" },
        },
      },
    };

    expect(collectPromptCacheConfigWarnings(cfg)).toEqual([
      expect.stringContaining(
        'agents.defaults.heartbeat.every="30m" is not shorter than anthropic/claude-sonnet-4-6\'s effective short prompt-cache retention',
      ),
    ]);
  });

  it("warns when heartbeat model overrides cannot refresh the active model cache", () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          model: { primary: "anthropic/claude-sonnet-4-6" },
          contextPruning: { mode: "cache-ttl", ttl: "5m" },
          heartbeat: { every: "4m", model: "openai/gpt-5.5" },
        },
      },
    };

    expect(collectPromptCacheConfigWarnings(cfg)).toEqual([
      expect.stringContaining(
        'agents.defaults.heartbeat.model="openai/gpt-5.5" does not match anthropic/claude-sonnet-4-6 used by agents.defaults.model.primary',
      ),
    ]);
  });

  it("resolves bare heartbeat model refs against the runtime default provider", () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          model: {
            primary: "openai/gpt-5.5",
            fallbacks: ["anthropic/claude-sonnet-4-6"],
          },
          contextPruning: { mode: "cache-ttl", ttl: "5m" },
          heartbeat: { every: "4m", model: "claude-sonnet-4-6" },
        },
      },
    };

    expect(collectPromptCacheConfigWarnings(cfg)).toEqual(
      expect.arrayContaining([
        expect.stringContaining(
          'agents.defaults.heartbeat.model="claude-sonnet-4-6" does not match anthropic/claude-sonnet-4-6 used by agents.defaults.model.fallbacks.0',
        ),
      ]),
    );
  });

  it("does not resolve heartbeat model refs through config-only compat aliases", () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          model: { primary: "openrouter/moonshotai/kimi-k2.5:free" },
          contextPruning: { mode: "cache-ttl", ttl: "5m" },
          heartbeat: { every: "4m", model: "openrouter:free" },
        },
      },
      models: {
        providers: {
          openrouter: {
            baseUrl: "https://openrouter.example.test",
            models: [anthropicConfiguredModel("moonshotai/kimi-k2.5:free")],
          },
        },
      },
    };

    expect(collectPromptCacheConfigWarnings(cfg)).toEqual([
      expect.stringContaining(
        'agents.defaults.heartbeat.model="openrouter:free" does not match openrouter/moonshotai/kimi-k2.5:free used by agents.defaults.model.primary',
      ),
    ]);
  });

  it("resolves heartbeat model aliases before comparing active model cache keys", () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          model: { primary: "anthropic/claude-sonnet-4-6" },
          contextPruning: { mode: "cache-ttl", ttl: "5m" },
          heartbeat: { every: "4m", model: "sonnet" },
          models: {
            "anthropic/claude-sonnet-4-6": { alias: "sonnet" },
          },
        },
      },
    };

    expect(collectPromptCacheConfigWarnings(cfg)).toEqual([]);
  });

  it("warns for subagent model routes that bypass a cacheable default model", () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          model: { primary: "anthropic/claude-opus-4-6" },
          contextPruning: { mode: "cache-ttl", ttl: "1h" },
          heartbeat: { every: "55m" },
          models: {
            "anthropic/claude-opus-4-6": { params: { cacheRetention: "long" } },
          },
          subagents: {
            model: { primary: "openai/gpt-5.1-codex" },
          },
        },
      },
    };

    expect(collectPromptCacheConfigWarnings(cfg)).toEqual([
      expect.stringContaining(
        'agents.defaults.subagents.model.primary uses openai/gpt-5.1-codex, but agents.defaults.contextPruning.mode="cache-ttl" does not currently run for OpenAI-family models',
      ),
    ]);
  });

  it("checks inherited agents that only override the heartbeat model", () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          model: { primary: "anthropic/claude-sonnet-4-6" },
          contextPruning: { mode: "cache-ttl", ttl: "5m" },
          heartbeat: { every: "4m" },
        },
        list: [{ id: "wrong-heartbeat-model", heartbeat: { model: "openai/gpt-5.5" } }],
      },
    };

    expect(collectPromptCacheConfigWarnings(cfg)).toEqual([
      expect.stringContaining(
        'agents.list.0.heartbeat.model="openai/gpt-5.5" does not match anthropic/claude-sonnet-4-6 used by agents.list.0.model (inherits agents.defaults.model).primary',
      ),
    ]);
  });

  it("does not warn when cache-ttl pruning is disabled", () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          model: { primary: "anthropic/claude-sonnet-4-6" },
          contextPruning: { mode: "off", ttl: "1h" },
          heartbeat: { every: "1h" },
        },
      },
    };

    expect(collectPromptCacheConfigWarnings(cfg)).toEqual([]);
  });
});
