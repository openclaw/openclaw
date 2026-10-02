// @vitest-environment node
// Control UI tests cover canonical per-agent model config writes.
import { describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ApplicationGatewayPhase } from "../../app/gateway.ts";
import { createRuntimeConfigCapability } from "../../lib/config/runtime-config-capability.ts";
import { createAgentModelActions } from "./model-config.ts";

function createRuntimeConfig(sourceConfig: Record<string, unknown>) {
  const client = {
    request: vi.fn(async (method: string) =>
      method === "config.get"
        ? {
            sourceConfig,
            hash: "hash-1",
            valid: true,
            issues: [],
          }
        : { hash: "hash-2" },
    ),
  } as unknown as GatewayBrowserClient;
  const snapshot = {
    client,
    phase: "connected" as ApplicationGatewayPhase,
    sessionKey: "main",
  };
  return createRuntimeConfigCapability({
    snapshot,
    subscribe: () => () => undefined,
  });
}

function modelActionsFor(runtimeConfig: ReturnType<typeof createRuntimeConfig>) {
  return createAgentModelActions({
    getRuntimeConfig: () => runtimeConfig,
    canUpdate: () => true,
    onPrimaryChanged: () => undefined,
  });
}

describe("agent model config", () => {
  it("rechecks the current agent and permissions before editing the current config", async () => {
    const original = createRuntimeConfig({ agents: { entries: { main: {} } } });
    const replacement = createRuntimeConfig({ agents: { entries: { scout: {} } } });
    await Promise.all([original.ensureLoaded(), replacement.ensureLoaded()]);
    let current = original;
    let selected = "main";
    let allowed = true;
    const onPrimaryChanged = vi.fn();
    const actions = createAgentModelActions({
      getRuntimeConfig: () => current,
      canUpdate: (agentId) => allowed && agentId === selected,
      onPrimaryChanged,
    });
    current = replacement;
    selected = "scout";
    actions.onModelChange("main", "fixture/chat");
    actions.onDecisionModelChange("main", "typesafe/jev-latest");
    actions.onModelFallbacksChange("main", ["fixture/fallback"]);
    allowed = false;
    actions.onModelChange("scout", "fixture/chat");
    actions.onDecisionModelChange("scout", "typesafe/jev-latest");
    actions.onModelFallbacksChange("scout", ["fixture/fallback"]);
    expect(original.state.configFormDirty).toBe(false);
    expect(replacement.state.configFormDirty).toBe(false);
    expect(onPrimaryChanged).not.toHaveBeenCalled();
    allowed = true;
    actions.onModelChange("scout", "fixture/chat");
    actions.onDecisionModelChange("scout", "");
    actions.onModelFallbacksChange("scout", ["fixture/fallback"]);
    expect(replacement.state.configForm).toEqual({
      agents: {
        entries: {
          scout: {
            model: { primary: "fixture/chat", fallbacks: ["fixture/fallback"] },
            decisionModel: "",
          },
        },
      },
    });
    expect(original.state.configFormDirty).toBe(false);
    expect(onPrimaryChanged).toHaveBeenCalledOnce();
    original.dispose();
    replacement.dispose();
  });
  it("distinguishes an explicit decision disable from inheritance without changing other settings", async () => {
    const defaults = { decisionModel: "typesafe/jev-latest", model: "openai/gpt-5.4" };
    const runtimeConfig = createRuntimeConfig({ agents: { defaults } });
    await runtimeConfig.ensureLoaded();
    modelActionsFor(runtimeConfig).onDecisionModelChange("main", null);
    expect(runtimeConfig.state.configFormDirty).toBe(false);
    modelActionsFor(runtimeConfig).onDecisionModelChange("main", "");
    expect(runtimeConfig.state.configForm).toEqual({
      agents: { defaults, entries: { main: { decisionModel: "" } } },
    });
    modelActionsFor(runtimeConfig).onDecisionModelChange("main", "typesafe/jev-preview");
    expect(runtimeConfig.state.configForm).toEqual({
      agents: { defaults, entries: { main: { decisionModel: "typesafe/jev-preview" } } },
    });
    modelActionsFor(runtimeConfig).onDecisionModelChange("main", null);
    expect(runtimeConfig.state.configForm).toEqual({ agents: { defaults, entries: { main: {} } } });
    runtimeConfig.dispose();
  });
  it("writes primary and fallback changes through keyed agent entries", async () => {
    const runtimeConfig = createRuntimeConfig({
      agents: {
        defaults: { model: { primary: "openai/gpt-5.4" } },
        entries: { main: { default: true } },
      },
    });
    await runtimeConfig.ensureLoaded();

    modelActionsFor(runtimeConfig).onModelChange("main", "anthropic/claude-sonnet-4-6");
    modelActionsFor(runtimeConfig).onModelFallbacksChange("main", ["openai/gpt-5.4"]);

    expect(runtimeConfig.state.configForm).toEqual({
      agents: {
        defaults: { model: { primary: "openai/gpt-5.4" } },
        entries: {
          main: {
            default: true,
            model: {
              primary: "anthropic/claude-sonnet-4-6",
              fallbacks: ["openai/gpt-5.4"],
            },
          },
        },
      },
    });
    expect(runtimeConfig.state.configForm?.agents).not.toHaveProperty("list");
    runtimeConfig.dispose();
  });

  it("preserves inherited primary and shared defaults when editing fallbacks", async () => {
    const defaults = { model: { primary: "openai/gpt-5.4", fallbacks: ["google/gemini-3-pro"] } };
    const runtimeConfig = createRuntimeConfig({
      agents: { defaults, entries: { main: { default: true } } },
    });
    await runtimeConfig.ensureLoaded();

    modelActionsFor(runtimeConfig).onModelFallbacksChange("main", [
      "google/gemini-3-pro",
      "anthropic/claude-sonnet-4-6",
    ]);

    expect(runtimeConfig.state.configForm).toEqual({
      agents: {
        defaults,
        entries: {
          main: {
            default: true,
            model: { fallbacks: ["google/gemini-3-pro", "anthropic/claude-sonnet-4-6"] },
          },
        },
      },
    });
    runtimeConfig.dispose();
  });

  it.each([
    {
      name: "an inherited primary",
      defaultModel: { primary: "openai/gpt-5.4", fallbacks: ["google/gemini-3-pro"] },
      model: { fallbacks: ["anthropic/claude-sonnet-4-6"] },
      expectedModel: { fallbacks: [] },
    },
    {
      name: "an authored primary",
      defaultModel: { primary: "google/gemini-3-pro" },
      model: { primary: "openai/gpt-5.4", fallbacks: ["anthropic/claude-sonnet-4-6"] },
      expectedModel: { primary: "openai/gpt-5.4", fallbacks: [] },
    },
  ])(
    "keeps an explicitly cleared fallback chain with $name",
    async ({ defaultModel, model, expectedModel }) => {
      const defaults = { model: defaultModel };
      const otherAgent = { model: "google/gemini-3-pro" };
      const runtimeConfig = createRuntimeConfig({
        agents: {
          defaults,
          entries: { main: { default: true, name: "Main", model }, other: otherAgent },
        },
      });
      await runtimeConfig.ensureLoaded();

      modelActionsFor(runtimeConfig).onModelFallbacksChange("main", []);

      expect(runtimeConfig.state.configForm).toEqual({
        agents: {
          defaults,
          entries: {
            main: { default: true, name: "Main", model: expectedModel },
            other: otherAgent,
          },
        },
      });
      runtimeConfig.dispose();
    },
  );

  it("creates an empty override for an implicit agent only after an explicit clear", async () => {
    const defaults = { model: { fallbacks: ["google/gemini-3-pro"] } };
    const runtimeConfig = createRuntimeConfig({ agents: { defaults } });
    await runtimeConfig.ensureLoaded();
    expect(runtimeConfig.state.configForm).toEqual({ agents: { defaults } });
    expect(runtimeConfig.state.configFormDirty).toBe(false);

    modelActionsFor(runtimeConfig).onModelFallbacksChange("main", []);

    expect(runtimeConfig.state.configForm).toEqual({
      agents: { defaults, entries: { main: { model: { fallbacks: [] } } } },
    });
    runtimeConfig.dispose();
  });

  it.each([{ fallbacks: ["openai/gpt-5.4"] }, { fallbacks: [] }])(
    "keeps authored fallbacks $fallbacks when the primary model is cleared",
    async ({ fallbacks }) => {
      const runtimeConfig = createRuntimeConfig({
        agents: {
          defaults: { model: { primary: "openai/gpt-5.4" } },
          entries: {
            main: {
              default: true,
              model: { primary: "anthropic/claude-sonnet-4-6", fallbacks },
            },
          },
        },
      });
      await runtimeConfig.ensureLoaded();

      modelActionsFor(runtimeConfig).onModelChange("main", null);

      expect(runtimeConfig.state.configForm).toEqual({
        agents: {
          defaults: { model: { primary: "openai/gpt-5.4" } },
          entries: {
            main: { default: true, model: { fallbacks } },
          },
        },
      });
      runtimeConfig.dispose();
    },
  );

  it("still removes the model node when clearing a primary with no fallbacks", async () => {
    const runtimeConfig = createRuntimeConfig({
      agents: {
        entries: { main: { default: true, model: "anthropic/claude-sonnet-4-6" } },
      },
    });
    await runtimeConfig.ensureLoaded();

    modelActionsFor(runtimeConfig).onModelChange("main", null);

    expect(runtimeConfig.state.configForm).toEqual({
      agents: { entries: { main: { default: true } } },
    });
    runtimeConfig.dispose();
  });
});
