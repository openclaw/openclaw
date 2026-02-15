import { describe, expect, it } from "vitest";
import type { PluginRegistry } from "./registry.js";
import type { PluginHookRegistration } from "./types.js";
import { createHookRunner } from "./hooks.js";

function makeRegistry(typedHooks: PluginHookRegistration[] = []): PluginRegistry {
  return {
    plugins: [],
    tools: [],
    hooks: [],
    typedHooks,
    channels: [],
    providers: [],
    gatewayHandlers: {},
    httpHandlers: [],
    httpRoutes: [],
    cliRegistrars: [],
    services: [],
    commands: [],
    diagnostics: [],
  };
}

describe("before_agent_start hook runner", () => {
  it("passes the evolving prompt and merges results with last override winning", async () => {
    const calls: Array<{ hook: string; prompt: string; originalPrompt?: string }> = [];
    const hooks: PluginHookRegistration<"before_agent_start">[] = [
      {
        pluginId: "p1",
        hookName: "before_agent_start",
        priority: 10,
        source: "test",
        handler: async (event) => {
          calls.push({
            hook: "p1",
            prompt: event.prompt,
            originalPrompt: event.originalPrompt,
          });
          return {
            promptOverride: "short-1",
            prependContext: "ctx-1",
            systemPrompt: "sys-1",
          };
        },
      },
      {
        pluginId: "p2",
        hookName: "before_agent_start",
        priority: 1,
        source: "test",
        handler: async (event) => {
          calls.push({
            hook: "p2",
            prompt: event.prompt,
            originalPrompt: event.originalPrompt,
          });
          return {
            promptOverride: "short-2",
            prependContext: "ctx-2",
            systemPrompt: "sys-2",
          };
        },
      },
    ];

    const runner = createHookRunner(makeRegistry(hooks));
    const result = await runner.runBeforeAgentStart(
      {
        prompt: "original",
      },
      {},
    );

    expect(calls).toEqual([
      { hook: "p1", prompt: "original", originalPrompt: "original" },
      { hook: "p2", prompt: "short-1", originalPrompt: "original" },
    ]);
    expect(result?.promptOverride).toBe("short-2");
    expect(result?.prependContext).toBe("ctx-1\n\nctx-2");
    expect(result?.systemPrompt).toBe("sys-2");
  });

  it("leaves promptOverride unset when no hook overrides", async () => {
    const hooks: PluginHookRegistration<"before_agent_start">[] = [
      {
        pluginId: "p1",
        hookName: "before_agent_start",
        priority: 10,
        source: "test",
        handler: async () => ({
          prependContext: "ctx-1",
        }),
      },
    ];

    const runner = createHookRunner(makeRegistry(hooks));
    const result = await runner.runBeforeAgentStart(
      {
        prompt: "original",
      },
      {},
    );

    expect(result?.prependContext).toBe("ctx-1");
    expect(result?.promptOverride).toBeUndefined();
  });
});
