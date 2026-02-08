import { describe, expect, it, vi } from "vitest";
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
    api.lifecycle.on("boot.pre", handler, { priority: 7, timeoutMs: 100, mode: "fail-closed" });

    expect(registry.typedHooks).toHaveLength(1);
    expect(registry.typedHooks[0]).toMatchObject({
      hookName: "gateway_pre_start",
      priority: 7,
      timeoutMs: 100,
      mode: "fail-closed",
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
});
