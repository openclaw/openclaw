import { describe, expect, it } from "vitest";
import type { PluginRegistry } from "./registry.js";
import type { PluginHookRegistration } from "./types.js";
import { createHookRunner } from "./hooks.js";

/** Create a minimal registry with only typedHooks populated. */
function makeRegistry(hooks: PluginHookRegistration[]): PluginRegistry {
  return {
    plugins: [],
    tools: [],
    hooks: [],
    typedHooks: hooks,
    channels: [],
    providers: [],
    gatewayHandlers: {},
    httpHandlers: [],
    httpRoutes: [],
    cliRegistrars: [],
    services: [],
    commands: [],
    diagnostics: [],
  } as unknown as PluginRegistry;
}

describe("runBeforeLlmRequest", () => {
  it("returns undefined when no hooks are registered", async () => {
    const runner = createHookRunner(makeRegistry([]));
    const result = await runner.runBeforeLlmRequest(
      { provider: "openai", modelId: "gpt-4", headers: {} },
      { senderId: "user-1" },
    );
    expect(result).toBeUndefined();
  });

  it("returns headers from a single handler", async () => {
    const registry = makeRegistry([
      {
        pluginId: "test-plugin",
        hookName: "before_llm_request",
        handler: (_event, ctx) => ({
          headers: { "X-Sender-Id": ctx.senderId ?? "" },
        }),
        source: "test",
      },
    ]);
    const runner = createHookRunner(registry);

    const result = await runner.runBeforeLlmRequest(
      { provider: "anthropic", modelId: "claude-sonnet-4-20250514", headers: {} },
      { senderId: "user-42", channel: "telegram" },
    );

    expect(result?.headers).toEqual({ "X-Sender-Id": "user-42" });
  });

  it("merges headers from multiple handlers in priority order", async () => {
    const registry = makeRegistry([
      {
        pluginId: "plugin-a",
        hookName: "before_llm_request",
        handler: () => ({
          headers: { "X-Plugin-A": "a", "X-Shared": "from-a" },
        }),
        priority: 10,
        source: "test",
      },
      {
        pluginId: "plugin-b",
        hookName: "before_llm_request",
        handler: () => ({
          headers: { "X-Plugin-B": "b", "X-Shared": "from-b" },
        }),
        priority: 5,
        source: "test",
      },
    ]);
    const runner = createHookRunner(registry);

    const result = await runner.runBeforeLlmRequest(
      { provider: "openai", modelId: "gpt-4", headers: {} },
      {},
    );

    // plugin-a runs first (higher priority), plugin-b overrides X-Shared
    expect(result?.headers).toEqual({
      "X-Plugin-A": "a",
      "X-Plugin-B": "b",
      "X-Shared": "from-b",
    });
  });

  it("catches errors from handlers and continues", async () => {
    const registry = makeRegistry([
      {
        pluginId: "failing-plugin",
        hookName: "before_llm_request",
        handler: () => {
          throw new Error("boom");
        },
        priority: 10,
        source: "test",
      },
      {
        pluginId: "ok-plugin",
        hookName: "before_llm_request",
        handler: () => ({
          headers: { "X-Ok": "yes" },
        }),
        priority: 5,
        source: "test",
      },
    ]);
    const runner = createHookRunner(registry, { catchErrors: true });

    const result = await runner.runBeforeLlmRequest(
      { provider: "openai", modelId: "gpt-4", headers: {} },
      {},
    );

    expect(result?.headers).toEqual({ "X-Ok": "yes" });
  });

  it("passes provider and modelId in the event", async () => {
    let capturedEvent: { provider: string; modelId: string } | undefined;
    const registry = makeRegistry([
      {
        pluginId: "spy-plugin",
        hookName: "before_llm_request",
        handler: (event) => {
          capturedEvent = { provider: event.provider, modelId: event.modelId };
          return { headers: {} };
        },
        source: "test",
      },
    ]);
    const runner = createHookRunner(registry);

    await runner.runBeforeLlmRequest(
      { provider: "anthropic", modelId: "claude-sonnet-4-20250514", headers: {} },
      { senderId: "user-1" },
    );

    expect(capturedEvent).toEqual({
      provider: "anthropic",
      modelId: "claude-sonnet-4-20250514",
    });
  });

  it("handles handlers returning {} or { headers: undefined } without crashing", async () => {
    const registry = makeRegistry([
      {
        pluginId: "empty-plugin",
        hookName: "before_llm_request",
        handler: () => ({ headers: { "X-First": "1" } }),
        priority: 10,
        source: "test",
      },
      {
        pluginId: "undef-headers",
        hookName: "before_llm_request",
        handler: () => ({}) as { headers?: Record<string, string> },
        priority: 5,
        source: "test",
      },
    ]);
    const runner = createHookRunner(registry);

    const result = await runner.runBeforeLlmRequest(
      { provider: "openai", modelId: "gpt-4", headers: {} },
      {},
    );

    expect(result?.headers).toEqual({ "X-First": "1" });
  });
});
