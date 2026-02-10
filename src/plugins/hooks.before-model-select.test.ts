import { describe, expect, it, vi, beforeEach } from "vitest";
import type { PluginRegistry } from "./registry.js";
import type {
  PluginHookBeforeModelSelectEvent,
  PluginHookAgentContext,
  PluginHookRegistration,
} from "./types.js";
import { createHookRunner } from "./hooks.js";

function makeEvent(
  overrides: Partial<PluginHookBeforeModelSelectEvent> = {},
): PluginHookBeforeModelSelectEvent {
  return {
    provider: "openai",
    model: "gpt-4o",
    sessionKey: "test-session",
    allowedModelKeys: new Set(["openai/gpt-4o", "anthropic/claude-sonnet-4-20250514"]),
    prompt: "Hello world",
    ...overrides,
  };
}

function makeContext(overrides: Partial<PluginHookAgentContext> = {}): PluginHookAgentContext {
  return {
    sessionKey: "test-session",
    ...overrides,
  };
}

function makeRegistry(hooks: PluginHookRegistration<"before_model_select">[] = []): PluginRegistry {
  return {
    plugins: [],
    hooks: [],
    typedHooks: hooks,
    tools: [],
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

describe("runBeforeModelSelect", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns undefined when no handlers registered", async () => {
    const runner = createHookRunner(makeRegistry());
    const event = makeEvent();
    const ctx = makeContext();

    const result = await runner.runBeforeModelSelect(event, ctx);

    expect(result).toBeUndefined();
  });

  it("calls handler with correct event and context", async () => {
    const handler = vi
      .fn()
      .mockResolvedValue({ provider: "anthropic", model: "claude-sonnet-4-20250514" });
    const registry = makeRegistry([
      {
        pluginId: "test-plugin",
        hookName: "before_model_select",
        handler,
        priority: 0,
        source: "test",
      },
    ]);
    const runner = createHookRunner(registry);
    const event = makeEvent();
    const ctx = makeContext();

    await runner.runBeforeModelSelect(event, ctx);

    expect(handler).toHaveBeenCalledWith(event, ctx);
  });

  it("returns handler result when handler returns value", async () => {
    const handler = vi
      .fn()
      .mockResolvedValue({ provider: "anthropic", model: "claude-sonnet-4-20250514" });
    const registry = makeRegistry([
      {
        pluginId: "test-plugin",
        hookName: "before_model_select",
        handler,
        priority: 0,
        source: "test",
      },
    ]);
    const runner = createHookRunner(registry);

    const result = await runner.runBeforeModelSelect(makeEvent(), makeContext());

    expect(result).toEqual({ provider: "anthropic", model: "claude-sonnet-4-20250514" });
  });

  it("executes handlers in priority order (higher priority first)", async () => {
    const callOrder: string[] = [];
    const lowPriorityHandler = vi.fn().mockImplementation(async () => {
      callOrder.push("low");
      return { model: "low-model" };
    });
    const highPriorityHandler = vi.fn().mockImplementation(async () => {
      callOrder.push("high");
      return { model: "high-model" };
    });

    const registry = makeRegistry([
      {
        pluginId: "low-priority",
        hookName: "before_model_select",
        handler: lowPriorityHandler,
        priority: 0,
        source: "test",
      },
      {
        pluginId: "high-priority",
        hookName: "before_model_select",
        handler: highPriorityHandler,
        priority: 100,
        source: "test",
      },
    ]);
    const runner = createHookRunner(registry);

    await runner.runBeforeModelSelect(makeEvent(), makeContext());

    expect(callOrder).toEqual(["high", "low"]);
  });

  it("merges results from multiple handlers (last non-undefined wins)", async () => {
    const handler1 = vi.fn().mockResolvedValue({ provider: "first-provider" });
    const handler2 = vi.fn().mockResolvedValue({ model: "second-model" });
    const handler3 = vi
      .fn()
      .mockResolvedValue({ provider: "third-provider", model: "third-model" });

    const registry = makeRegistry([
      {
        pluginId: "plugin-1",
        hookName: "before_model_select",
        handler: handler1,
        priority: 30,
        source: "test",
      },
      {
        pluginId: "plugin-2",
        hookName: "before_model_select",
        handler: handler2,
        priority: 20,
        source: "test",
      },
      {
        pluginId: "plugin-3",
        hookName: "before_model_select",
        handler: handler3,
        priority: 10,
        source: "test",
      },
    ]);
    const runner = createHookRunner(registry);

    const result = await runner.runBeforeModelSelect(makeEvent(), makeContext());

    expect(result).toEqual({ provider: "third-provider", model: "third-model" });
  });

  it("returns undefined when handler returns void", async () => {
    const handler = vi.fn().mockResolvedValue(undefined);
    const registry = makeRegistry([
      {
        pluginId: "test-plugin",
        hookName: "before_model_select",
        handler,
        priority: 0,
        source: "test",
      },
    ]);
    const runner = createHookRunner(registry);

    const result = await runner.runBeforeModelSelect(makeEvent(), makeContext());

    expect(result).toBeUndefined();
  });

  it("catches handler errors and continues (does not throw)", async () => {
    const errorHandler = vi.fn().mockRejectedValue(new Error("Handler error"));
    const successHandler = vi.fn().mockResolvedValue({ model: "success-model" });

    const registry = makeRegistry([
      {
        pluginId: "error-plugin",
        hookName: "before_model_select",
        handler: errorHandler,
        priority: 100,
        source: "test",
      },
      {
        pluginId: "success-plugin",
        hookName: "before_model_select",
        handler: successHandler,
        priority: 0,
        source: "test",
      },
    ]);
    const runner = createHookRunner(registry);

    const result = await runner.runBeforeModelSelect(makeEvent(), makeContext());

    expect(result).toEqual({ model: "success-model" });
    expect(errorHandler).toHaveBeenCalled();
    expect(successHandler).toHaveBeenCalled();
  });

  it("handles synchronous handlers", async () => {
    const handler = vi.fn().mockReturnValue({ provider: "sync-provider" });
    const registry = makeRegistry([
      {
        pluginId: "sync-plugin",
        hookName: "before_model_select",
        handler,
        priority: 0,
        source: "test",
      },
    ]);
    const runner = createHookRunner(registry);

    const result = await runner.runBeforeModelSelect(makeEvent(), makeContext());

    expect(result).toEqual({ provider: "sync-provider" });
  });
});
