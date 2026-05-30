import { describe, expect, it } from "vitest";
import {
  buildDesktopModelSetupPatch,
  createDesktopModelSetupForm,
  resolveDesktopModelSetupStatus,
  updateDesktopModelSetupForm,
} from "./desktop-model-setup.ts";

describe("desktop model setup", () => {
  it("requires setup when no primary model or configured catalog exists", () => {
    expect(resolveDesktopModelSetupStatus({ snapshot: { config: {} }, models: [] })).toEqual({
      required: true,
      configuredModelCount: 0,
      primaryModel: null,
    });
  });

  it("does not require setup when a primary model and configured catalog exist", () => {
    expect(
      resolveDesktopModelSetupStatus({
        snapshot: { config: { agents: { defaults: { model: { primary: "openai/gpt-5.4" } } } } },
        models: [{ provider: "openai", id: "gpt-5.4", name: "GPT-5.4" }],
      }),
    ).toEqual({
      required: false,
      configuredModelCount: 1,
      primaryModel: "openai/gpt-5.4",
    });
  });

  it("requires setup when the primary provider's refreshable auth is expired", () => {
    expect(
      resolveDesktopModelSetupStatus({
        snapshot: { config: { agents: { defaults: { model: { primary: "gpt-5.5" } } } } },
        models: [{ provider: "openai", id: "gpt-5.5", name: "GPT-5.5" }],
        authStatus: {
          ts: 1,
          providers: [
            {
              provider: "openai",
              displayName: "OpenAI",
              status: "expired",
              profiles: [],
            },
          ],
        },
      }),
    ).toEqual({
      required: true,
      configuredModelCount: 1,
      primaryModel: "gpt-5.5",
    });
  });

  it("builds a config patch for a hosted API provider", () => {
    const form = {
      ...createDesktopModelSetupForm("anthropic"),
      apiKey: "test-key",
    };

    expect(buildDesktopModelSetupPatch(form)).toEqual({
      modelRef: "anthropic/claude-sonnet-4-6",
      patch: {
        agents: {
          defaults: {
            model: { primary: "anthropic/claude-sonnet-4-6" },
            models: { "anthropic/claude-sonnet-4-6": {} },
          },
          list: [{ id: "main", model: { primary: "anthropic/claude-sonnet-4-6" } }],
        },
        models: {
          providers: {
            anthropic: {
              apiKey: "test-key",
              models: [{ id: "claude-sonnet-4-6", name: "claude-sonnet-4-6" }],
            },
          },
        },
      },
    });
  });

  it("preserves existing agents when updating the desktop main model", () => {
    const form = {
      ...createDesktopModelSetupForm("anthropic"),
      apiKey: "test-key",
    };

    expect(
      buildDesktopModelSetupPatch(form, {
        snapshot: {
          config: {
            agents: {
              list: [
                {
                  id: "main",
                  name: "Main",
                  model: { primary: "openai/gpt-5.5", reasoning: "low" },
                },
                { id: "research", model: { primary: "openrouter/sonnet" } },
              ],
            },
          },
        },
      }).patch,
    ).toMatchObject({
      agents: {
        list: [
          {
            id: "main",
            name: "Main",
            model: { primary: "anthropic/claude-sonnet-4-6", reasoning: "low" },
          },
          { id: "research", model: { primary: "openrouter/sonnet" } },
        ],
      },
    });
  });

  it("builds a config patch for a local OpenAI-compatible provider", () => {
    const form = updateDesktopModelSetupForm(createDesktopModelSetupForm(), {
      preset: "custom",
      providerId: "local-lmstudio",
      modelId: "qwen3-local",
      baseUrl: "http://127.0.0.1:1234/v1",
    });

    expect(buildDesktopModelSetupPatch(form).patch).toMatchObject({
      agents: {
        defaults: {
          model: { primary: "local-lmstudio/qwen3-local" },
          models: { "local-lmstudio/qwen3-local": {} },
        },
      },
      models: {
        providers: {
          "local-lmstudio": {
            api: "openai-completions",
            baseUrl: "http://127.0.0.1:1234/v1",
            models: [{ id: "qwen3-local", name: "qwen3-local" }],
          },
        },
      },
    });
  });

  it("removes stale empty desktop model allowlist entries", () => {
    const form = updateDesktopModelSetupForm(createDesktopModelSetupForm(), {
      preset: "custom",
      providerId: "local-openai",
      modelId: "openai/gpt-5-5",
      baseUrl: "https://models.example.com/v1",
      apiKey: "test-key",
    });

    expect(
      buildDesktopModelSetupPatch(form, {
        snapshot: {
          config: {
            agents: {
              defaults: {
                models: {
                  "xinflor/openai/gpt-5-5": {},
                  "local-openai/openai/gpt-5-5": {},
                },
              },
            },
          },
        },
      }).patch,
    ).toMatchObject({
      agents: {
        defaults: {
          models: {
            "xinflor/openai/gpt-5-5": null,
            "local-openai/openai/gpt-5-5": {},
          },
        },
      },
    });
  });

  it("preserves non-empty model allowlist entries", () => {
    const form = updateDesktopModelSetupForm(createDesktopModelSetupForm(), {
      preset: "custom",
      providerId: "local-openai",
      modelId: "openai/gpt-5-5",
      baseUrl: "https://models.example.com/v1",
      apiKey: "test-key",
    });
    const setup = buildDesktopModelSetupPatch(form, {
      snapshot: {
        config: {
          agents: {
            defaults: {
              models: {
                "fireworks/accounts/fireworks/models/kimi-k2p6": {
                  agentRuntime: { id: "codex" },
                },
              },
            },
          },
        },
      },
    });

    expect(setup.patch).toMatchObject({
      agents: {
        defaults: {
          models: {
            "local-openai/openai/gpt-5-5": {},
          },
        },
      },
    });
    const modelsPatch = (setup.patch.agents as { defaults: { models: Record<string, unknown> } })
      .defaults.models;
    expect(modelsPatch).not.toHaveProperty("fireworks/accounts/fireworks/models/kimi-k2p6");
  });
});
