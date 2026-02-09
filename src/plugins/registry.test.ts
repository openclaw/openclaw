import { describe, expect, it, vi } from "vitest";
import { createHookRunner } from "./hooks.js";
import { createPluginRegistry, type PluginRecord } from "./registry.js";

function createRecord(): PluginRecord {
  return {
    id: "test-plugin",
    name: "Test Plugin",
    source: "/tmp/test-plugin.js",
    origin: "workspace",
    enabled: true,
    status: "loaded",
    toolNames: [],
    hookNames: [],
    channelIds: [],
    providerIds: [],
    gatewayMethods: [],
    cliCommands: [],
    services: [],
    commands: [],
    httpHandlers: 0,
    hookCount: 0,
    configSchema: false,
  };
}

describe("plugin registry lifecycle mapping", () => {
  it("maps boot.pre to gateway_pre_start", () => {
    const { registry, createApi } = createPluginRegistry({
      // Minimal shape needed by registry tests.
      runtime: {} as never,
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
      },
      coreGatewayHandlers: {},
    });

    const api = createApi(createRecord(), { config: {} as never });
    const handler = vi.fn();
    api.lifecycle.on("boot.pre", handler, {
      priority: 7,
      timeoutMs: 100,
      mode: "fail-closed",
      onTimeout: "fail-open",
      retry: { count: 2, backoffMs: 10 },
      maxConcurrency: 3,
      scope: { channels: ["slack"] },
    });

    expect(registry.typedHooks).toHaveLength(1);
    expect(registry.typedHooks[0]).toMatchObject({
      hookName: "gateway_pre_start",
      priority: 7,
      timeoutMs: 100,
      mode: "fail-closed",
      onTimeout: "fail-open",
      retry: { count: 2, backoffMs: 10 },
      maxConcurrency: 3,
      scope: { channels: ["slack"] },
    });
  });

  it("passes extended execution options through api.on", () => {
    const { registry, createApi } = createPluginRegistry({
      runtime: {} as never,
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
      },
      coreGatewayHandlers: {},
    });

    const api = createApi(createRecord(), { config: {} as never });
    api.on("before_tool_call", vi.fn(), {
      onTimeout: "fail-closed",
      retry: { count: 1, backoffMs: 25 },
      maxConcurrency: 2,
      scope: { agentIds: ["agent-1"], toolNames: ["echo"] },
    });

    expect(registry.typedHooks).toHaveLength(1);
    expect(registry.typedHooks[0]).toMatchObject({
      hookName: "before_tool_call",
      onTimeout: "fail-closed",
      retry: { count: 1, backoffMs: 25 },
      maxConcurrency: 2,
      scope: { agentIds: ["agent-1"], toolNames: ["echo"] },
    });
  });

  it("maps shutdown.pre to gateway_pre_stop", () => {
    const { registry, createApi } = createPluginRegistry({
      runtime: {} as never,
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
      },
      coreGatewayHandlers: {},
    });

    const api = createApi(createRecord(), { config: {} as never });
    api.lifecycle.on("shutdown.pre", vi.fn());

    expect(registry.typedHooks).toHaveLength(1);
    expect(registry.typedHooks[0]?.hookName).toBe("gateway_pre_stop");
  });

  it("maps preRecall alias to before_recall", () => {
    const { registry, createApi } = createPluginRegistry({
      runtime: {} as never,
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
      },
      coreGatewayHandlers: {},
    });

    const api = createApi(createRecord(), { config: {} as never });
    api.lifecycle.on("preRecall", vi.fn());

    expect(registry.typedHooks).toHaveLength(1);
    expect(registry.typedHooks[0]?.hookName).toBe("before_recall");
  });

  it("maps onError alias to agent_error", () => {
    const { registry, createApi } = createPluginRegistry({
      runtime: {} as never,
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
      },
      coreGatewayHandlers: {},
    });

    const api = createApi(createRecord(), { config: {} as never });
    api.lifecycle.on("onError", vi.fn());

    expect(registry.typedHooks).toHaveLength(1);
    expect(registry.typedHooks[0]?.hookName).toBe("agent_error");
  });

  it("maps message.pre to message_sending", () => {
    const { registry, createApi } = createPluginRegistry({
      runtime: {} as never,
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
      },
      coreGatewayHandlers: {},
    });

    const api = createApi(createRecord(), { config: {} as never });
    api.lifecycle.on("message.pre", vi.fn());

    expect(registry.typedHooks).toHaveLength(1);
    expect(registry.typedHooks[0]?.hookName).toBe("message_sending");
  });

  it("maps preResponse alias to message_sending", () => {
    const { registry, createApi } = createPluginRegistry({
      runtime: {} as never,
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
      },
      coreGatewayHandlers: {},
    });

    const api = createApi(createRecord(), { config: {} as never });
    api.lifecycle.on("preResponse", vi.fn());

    expect(registry.typedHooks).toHaveLength(1);
    expect(registry.typedHooks[0]?.hookName).toBe("message_sending");
  });

  it("maps boot/shutdown aliases to gateway lifecycle hooks", () => {
    const { registry, createApi } = createPluginRegistry({
      runtime: {} as never,
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
      },
      coreGatewayHandlers: {},
    });
    const api = createApi(createRecord(), { config: {} as never });
    api.lifecycle.on("preBoot", vi.fn());
    api.lifecycle.on("postBoot", vi.fn());
    api.lifecycle.on("preShutdown", vi.fn());
    api.lifecycle.on("postShutdown", vi.fn());

    expect(registry.typedHooks.map((h) => h.hookName)).toEqual([
      "gateway_pre_start",
      "gateway_start",
      "gateway_pre_stop",
      "gateway_stop",
    ]);
  });

  it("maps preAgent alias to before_agent_start", () => {
    const { registry, createApi } = createPluginRegistry({
      runtime: {} as never,
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
      },
      coreGatewayHandlers: {},
    });
    const api = createApi(createRecord(), { config: {} as never });
    api.lifecycle.on("preAgent", vi.fn());

    expect(registry.typedHooks).toHaveLength(1);
    expect(registry.typedHooks[0]?.hookName).toBe("before_agent_start");
  });

  it("maps request/recall/tool error aliases to dedicated runtime hooks", () => {
    const { registry, createApi } = createPluginRegistry({
      runtime: {} as never,
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
      },
      coreGatewayHandlers: {},
    });
    const api = createApi(createRecord(), { config: {} as never });
    api.lifecycle.on("preRequest", vi.fn());
    api.lifecycle.on("postRequestIngress", vi.fn());
    api.lifecycle.on("postRecall", vi.fn());
    api.lifecycle.on("onResponseError", vi.fn());
    api.lifecycle.on("onToolError", vi.fn());

    expect(registry.typedHooks.map((h) => h.hookName)).toEqual([
      "message_received",
      "request_post",
      "after_recall",
      "response_error",
      "tool_error",
    ]);
  });

  it("passes lifecycle context to lifecycle conditions", async () => {
    const { registry, createApi } = createPluginRegistry({
      runtime: {} as never,
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
      },
      coreGatewayHandlers: {},
    });

    const api = createApi(createRecord(), { config: {} as never });
    const handler = vi.fn();
    const condition = vi.fn(() => true);
    api.lifecycle.on("preResponse", handler, { condition });

    const runner = createHookRunner(registry);
    await runner.runMessageSending(
      {
        to: "user-1",
        content: "hello",
      },
      {
        channelId: "slack",
      },
    );

    expect(condition).toHaveBeenCalledTimes(1);
    const [, ctx] = condition.mock.calls[0] ?? [];
    expect(ctx).toMatchObject({
      phase: "preResponse",
      metadata: expect.objectContaining({
        hookName: "message_sending",
        pluginId: "test-plugin",
      }),
    });
    expect(handler).toHaveBeenCalledTimes(1);
  });
});
