import { describe, expect, it, vi } from "vitest";
import { withTempHomeConfig } from "../config/test-helpers.js";
import { collectFallbackProviderWarnings } from "./doctor-config-flow.js";

const { noteSpy } = vi.hoisted(() => ({
  noteSpy: vi.fn(),
}));

vi.mock("../terminal/note.js", () => ({
  note: noteSpy,
}));

import { loadAndMaybeMigrateDoctorConfig } from "./doctor-config-flow.js";

describe("collectFallbackProviderWarnings", () => {
  it("returns no warnings when fallbacks use built-in providers", () => {
    const warnings = collectFallbackProviderWarnings({
      agents: {
        defaults: {
          model: {
            primary: "anthropic/claude-opus-4-6",
            fallbacks: ["google/gemini-2.5-pro", "openai/gpt-4.5"],
          },
        },
      },
    });

    expect(warnings).toEqual([]);
  });

  it("returns no warnings when fallbacks use explicitly defined providers", () => {
    const warnings = collectFallbackProviderWarnings({
      models: {
        providers: {
          "my-custom-provider": {
            baseUrl: "https://example.com/v1",
            models: [],
          },
        },
      },
      agents: {
        defaults: {
          model: {
            primary: "anthropic/claude-opus-4-6",
            fallbacks: ["my-custom-provider/my-model"],
          },
        },
      },
    });

    expect(warnings).toEqual([]);
  });

  it("warns when a fallback references an undefined provider", () => {
    const warnings = collectFallbackProviderWarnings({
      models: {
        providers: {
          anthropic: {
            baseUrl: "https://api.anthropic.com",
            models: [],
          },
        },
      },
      agents: {
        defaults: {
          model: {
            primary: "anthropic/claude-opus-4-6",
            fallbacks: ["unknown-provider/some-model"],
          },
        },
      },
    });

    expect(warnings).toHaveLength(1);
    expect(warnings[0].path).toBe("agents.defaults.model.fallbacks[0]");
    expect(warnings[0].entry).toBe("unknown-provider/some-model");
    expect(warnings[0].provider).toBe("unknown-provider");
  });

  it("warns for undefined providers in imageModel fallbacks", () => {
    const warnings = collectFallbackProviderWarnings({
      agents: {
        defaults: {
          imageModel: {
            primary: "anthropic/claude-opus-4-6",
            fallbacks: ["nonexistent/image-model"],
          },
        },
      },
    });

    expect(warnings).toHaveLength(1);
    expect(warnings[0].path).toBe("agents.defaults.imageModel.fallbacks[0]");
    expect(warnings[0].provider).toBe("nonexistent");
  });

  it("warns for undefined providers in per-agent fallbacks", () => {
    const warnings = collectFallbackProviderWarnings({
      agents: {
        list: [
          {
            id: "my-agent",
            model: {
              primary: "anthropic/claude-opus-4-6",
              fallbacks: ["fake-provider/model-x"],
            },
          },
        ],
      },
    });

    expect(warnings).toHaveLength(1);
    expect(warnings[0].path).toBe("agents.list[my-agent].model.fallbacks[0]");
    expect(warnings[0].provider).toBe("fake-provider");
  });

  it("warns for undefined providers in subagent model fallbacks", () => {
    const warnings = collectFallbackProviderWarnings({
      agents: {
        defaults: {
          subagents: {
            model: {
              primary: "anthropic/claude-opus-4-6",
              fallbacks: ["missing-provider/sub-model"],
            },
          },
        },
      },
    });

    expect(warnings).toHaveLength(1);
    expect(warnings[0].path).toBe("agents.defaults.subagents.model.fallbacks[0]");
    expect(warnings[0].provider).toBe("missing-provider");
  });

  it("does not warn for CLI backend providers", () => {
    const warnings = collectFallbackProviderWarnings({
      agents: {
        defaults: {
          cliBackends: {
            "my-cli": {
              command: "/usr/bin/my-cli",
            },
          },
          model: {
            primary: "anthropic/claude-opus-4-6",
            fallbacks: ["my-cli/default"],
          },
        },
      },
    });

    expect(warnings).toEqual([]);
  });

  it("handles provider id normalization (z.ai -> zai)", () => {
    const warnings = collectFallbackProviderWarnings({
      agents: {
        defaults: {
          model: {
            primary: "anthropic/claude-opus-4-6",
            fallbacks: ["z.ai/grok-3"],
          },
        },
      },
    });

    // z.ai normalizes to zai which is a built-in provider
    expect(warnings).toEqual([]);
  });

  it("does not warn for implicit providers (resolved via env/credentials at runtime)", () => {
    // These providers are discovered by resolveImplicitProviders and should
    // not trigger false "undefined provider" warnings.
    const implicitProviderRefs = [
      "moonshot/moonshot-v1-128k",
      "qwen-portal/qwen-max",
      "volcengine/doubao-pro-32k",
      "byteplus/doubao-pro-32k",
      "venice/llama-3.3-70b",
      "ollama/llama3",
      "vllm/my-model",
      "together/meta-llama/Llama-3-70b",
      "nvidia/meta/llama-3.1-70b-instruct",
      "kilocode/my-model",
      "qianfan/ernie-4.0-8k",
      "synthetic/synth-1",
      "xiaomi/miai-model",
      "minimax-portal/abab6-chat",
      "cloudflare-ai-gateway/my-model",
      "volcengine-plan/doubao-pro-32k",
      "byteplus-plan/doubao-pro-32k",
    ];
    const warnings = collectFallbackProviderWarnings({
      agents: {
        defaults: {
          model: {
            primary: "anthropic/claude-opus-4-6",
            fallbacks: implicitProviderRefs,
          },
        },
      },
    });

    expect(warnings).toEqual([]);
  });

  it("handles empty or missing fallback arrays gracefully", () => {
    const warnings = collectFallbackProviderWarnings({
      agents: {
        defaults: {
          model: "anthropic/claude-opus-4-6",
        },
        list: [{ id: "agent-no-fallbacks" }],
      },
    });

    expect(warnings).toEqual([]);
  });

  it("reports multiple warnings across different scopes", () => {
    const warnings = collectFallbackProviderWarnings({
      agents: {
        defaults: {
          model: {
            primary: "anthropic/claude-opus-4-6",
            fallbacks: ["bad-provider-1/model-a"],
          },
          imageModel: {
            primary: "openai/gpt-4.5",
            fallbacks: ["bad-provider-2/model-b"],
          },
        },
        list: [
          {
            id: "agent-x",
            model: {
              primary: "anthropic/claude-opus-4-6",
              fallbacks: ["bad-provider-3/model-c"],
            },
          },
        ],
      },
    });

    expect(warnings).toHaveLength(3);
    expect(warnings.map((w) => w.provider)).toEqual([
      "bad-provider-1",
      "bad-provider-2",
      "bad-provider-3",
    ]);
  });

  it("derives default provider from primary model for providerless fallbacks", () => {
    // When the primary model is "openai/gpt-4.5", providerless fallback entries
    // like "gpt-4o" should be treated as "openai/gpt-4o" (not "anthropic/gpt-4o").
    const warnings = collectFallbackProviderWarnings({
      agents: {
        defaults: {
          model: {
            primary: "openai/gpt-4.5",
            fallbacks: ["gpt-4o"],
          },
        },
      },
    });

    // "openai" is a built-in provider, so no warnings expected.
    expect(warnings).toEqual([]);
  });

  it("warns for providerless fallback when primary uses a custom provider", () => {
    // When the primary model uses a custom provider not in the known set,
    // providerless fallbacks inherit that provider and should trigger a warning.
    const warnings = collectFallbackProviderWarnings({
      agents: {
        defaults: {
          model: {
            primary: "my-custom/my-model",
            fallbacks: ["fallback-model"],
          },
        },
      },
    });

    expect(warnings).toHaveLength(1);
    expect(warnings[0].provider).toBe("my-custom");
    expect(warnings[0].entry).toBe("fallback-model");
  });

  it("derives per-agent default provider from the agent model primary", () => {
    // Per-agent fallbacks should use the agent's own primary model provider
    // as the default, not the global default provider.
    const warnings = collectFallbackProviderWarnings({
      agents: {
        defaults: {
          model: {
            primary: "anthropic/claude-opus-4-6",
          },
        },
        list: [
          {
            id: "openai-agent",
            model: {
              primary: "openai/gpt-4.5",
              fallbacks: ["gpt-4o"],
            },
          },
        ],
      },
    });

    // "gpt-4o" should be resolved as "openai/gpt-4o" (from agent primary),
    // not "anthropic/gpt-4o" (from global default).
    expect(warnings).toEqual([]);
  });
});

describe("doctor config flow fallback provider integration", () => {
  it("surfaces fallback provider warnings during doctor scan", async () => {
    noteSpy.mockReset();

    await withTempHomeConfig(
      {
        agents: {
          defaults: {
            model: {
              primary: "anthropic/claude-opus-4-6",
              fallbacks: ["undefined-provider/some-model"],
            },
          },
        },
      },
      async () => {
        await loadAndMaybeMigrateDoctorConfig({
          options: { nonInteractive: true },
          confirm: async () => false,
        });
      },
    );

    const fallbackWarnings = noteSpy.mock.calls.filter(
      (call: unknown[]) => call[1] === "Fallback provider warnings",
    );
    expect(fallbackWarnings.length).toBeGreaterThan(0);
    expect(String(fallbackWarnings[0][0])).toContain("undefined-provider");
    expect(String(fallbackWarnings[0][0])).toContain("models.providers");
  });

  it("does not surface fallback warnings when all providers are known", async () => {
    noteSpy.mockReset();

    await withTempHomeConfig(
      {
        agents: {
          defaults: {
            model: {
              primary: "anthropic/claude-opus-4-6",
              fallbacks: ["google/gemini-2.5-pro"],
            },
          },
        },
      },
      async () => {
        await loadAndMaybeMigrateDoctorConfig({
          options: { nonInteractive: true },
          confirm: async () => false,
        });
      },
    );

    const fallbackWarnings = noteSpy.mock.calls.filter(
      (call: unknown[]) => call[1] === "Fallback provider warnings",
    );
    expect(fallbackWarnings).toHaveLength(0);
  });
});
