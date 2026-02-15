import { describe, expect, it } from "vitest";
import type { PluginRegistry } from "./registry.js";
import type { PluginHookBeforeAgentStartResult } from "./types.js";
import { createHookRunner } from "./hooks.js";

function makeRegistry(
  hooks: Array<{
    pluginId: string;
    priority?: number;
    handler: (event: unknown, ctx: unknown) => Promise<PluginHookBeforeAgentStartResult>;
  }>,
): PluginRegistry {
  return {
    plugins: [],
    tools: [],
    hooks: [],
    typedHooks: hooks.map((h) => ({
      pluginId: h.pluginId,
      hookName: "before_agent_start" as const,
      priority: h.priority ?? 0,
      handler: h.handler,
      source: "test",
    })),
    channels: [],
    providers: [],
    gatewayHandlers: {} as PluginRegistry["gatewayHandlers"],
    httpHandlers: [],
    httpRoutes: [],
    cliRegistrars: [],
    services: [],
    commands: [],
    diagnostics: [],
  };
}

describe("runBeforeAgentStart", () => {
  it("returns model from a single hook", async () => {
    const registry = makeRegistry([
      {
        pluginId: "test-plugin",
        handler: async () => ({ model: "openrouter/anthropic/claude-sonnet-4" }),
      },
    ]);
    const runner = createHookRunner(registry);
    const result = await runner.runBeforeAgentStart({ prompt: "hello" }, { agentId: "main" });
    expect(result?.model).toBe("openrouter/anthropic/claude-sonnet-4");
  });

  it("last plugin wins for model override", async () => {
    const registry = makeRegistry([
      {
        pluginId: "plugin-a",
        priority: 10,
        handler: async () => ({ model: "anthropic/claude-opus-4" }),
      },
      {
        pluginId: "plugin-b",
        priority: 5,
        handler: async () => ({ model: "openai/gpt-4.1" }),
      },
    ]);
    const runner = createHookRunner(registry);
    const result = await runner.runBeforeAgentStart({ prompt: "hello" }, { agentId: "main" });
    // plugin-a runs first (higher priority), then plugin-b overrides
    expect(result?.model).toBe("openai/gpt-4.1");
  });

  it("preserves earlier model when later hook returns no model", async () => {
    const registry = makeRegistry([
      {
        pluginId: "plugin-a",
        priority: 10,
        handler: async () => ({ model: "anthropic/claude-opus-4" }),
      },
      {
        pluginId: "plugin-b",
        priority: 5,
        handler: async () => ({ prependContext: "extra context" }),
      },
    ]);
    const runner = createHookRunner(registry);
    const result = await runner.runBeforeAgentStart({ prompt: "hello" }, { agentId: "main" });
    expect(result?.model).toBe("anthropic/claude-opus-4");
    expect(result?.prependContext).toBe("extra context");
  });

  it("merges model with systemPrompt and prependContext", async () => {
    const registry = makeRegistry([
      {
        pluginId: "plugin-a",
        handler: async () => ({
          systemPrompt: "You are helpful.",
          prependContext: "context-a",
          model: "anthropic/claude-sonnet-4",
        }),
      },
    ]);
    const runner = createHookRunner(registry);
    const result = await runner.runBeforeAgentStart({ prompt: "hello" }, { agentId: "main" });
    expect(result?.systemPrompt).toBe("You are helpful.");
    expect(result?.prependContext).toBe("context-a");
    expect(result?.model).toBe("anthropic/claude-sonnet-4");
  });

  it("returns undefined when no hooks registered", async () => {
    const registry = makeRegistry([]);
    const runner = createHookRunner(registry);
    const result = await runner.runBeforeAgentStart({ prompt: "hello" }, { agentId: "main" });
    expect(result).toBeUndefined();
  });
});
