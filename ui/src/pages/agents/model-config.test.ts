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
  it("keeps an explicitly cleared fallback chain with an inherited primary", async () => {
    const defaults = {
      model: { primary: "openai/gpt-5.4", fallbacks: ["google/gemini-3-pro"] },
    };
    const otherAgent = { model: "google/gemini-3-pro" };
    const runtimeConfig = createRuntimeConfig({
      agents: {
        defaults,
        entries: {
          main: { name: "Main", model: { fallbacks: ["anthropic/claude-sonnet-4-6"] } },
          other: otherAgent,
        },
      },
    });
    await runtimeConfig.ensureLoaded();

    modelActionsFor(runtimeConfig).onModelFallbacksChange("main", []);

    expect(runtimeConfig.state.configForm).toEqual({
      agents: {
        defaults,
        entries: {
          main: { name: "Main", model: { fallbacks: [] } },
          other: otherAgent,
        },
      },
    });
    runtimeConfig.dispose();
  });

  it("keeps explicitly empty fallbacks when the primary model is cleared", async () => {
    const fallbacks: string[] = [];
    const runtimeConfig = createRuntimeConfig({
      agents: {
        defaults: { model: { primary: "openai/gpt-5.4" } },
        entries: {
          main: {
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
          main: { model: { fallbacks } },
        },
      },
    });
    runtimeConfig.dispose();
  });

  it("still removes the model node when clearing a primary with no fallbacks", async () => {
    const runtimeConfig = createRuntimeConfig({
      agents: {
        entries: { main: { model: "anthropic/claude-sonnet-4-6" } },
      },
    });
    await runtimeConfig.ensureLoaded();

    modelActionsFor(runtimeConfig).onModelChange("main", null);

    expect(runtimeConfig.state.configForm).toEqual({
      agents: { entries: { main: {} } },
    });
    runtimeConfig.dispose();
  });
});
