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
    httpRoutes: 0,
    hookCount: 0,
    configSchema: false,
  };
}

function createRegistryContext() {
  return createPluginRegistry({
    runtime: {} as never,
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
    coreGatewayHandlers: {},
  });
}

describe("plugin registry phase mapping", () => {
  it("maps canonical phases to existing runtime hooks", () => {
    const { registry, createApi } = createRegistryContext();
    const api = createApi(createRecord(), { config: {} as never });

    api.phases.on("model.pre", vi.fn());
    api.phases.on("prompt.pre", vi.fn());
    api.phases.on("agent.pre", vi.fn());
    api.phases.on("request.pre", vi.fn());
    api.phases.on("message.pre", vi.fn());
    api.phases.on("tool.pre", vi.fn());
    api.phases.on("tool.post", vi.fn());

    expect(registry.typedHooks.map((hook) => hook.hookName)).toEqual([
      "before_model_resolve",
      "before_prompt_build",
      "before_agent_start",
      "message_received",
      "message_sending",
      "before_tool_call",
      "after_tool_call",
    ]);
  });

  it("passes priority through phase registration", () => {
    const { registry, createApi } = createRegistryContext();
    const api = createApi(createRecord(), { config: {} as never });

    api.phases.on("message.pre", vi.fn(), { priority: 7 });

    expect(registry.typedHooks).toHaveLength(1);
    expect(registry.typedHooks[0]).toMatchObject({
      hookName: "message_sending",
      priority: 7,
    });
  });

  it("passes runtime context through with phase metadata", async () => {
    const { registry, createApi } = createRegistryContext();
    const api = createApi(createRecord(), { config: {} as never });
    const handler = vi.fn();

    api.phases.on("message.pre", handler);

    const runner = createHookRunner(registry, {
      logger: { warn: vi.fn(), error: vi.fn() },
    });

    await runner.runMessageSending({ to: "user-1", content: "hello" }, { channelId: "telegram" });

    expect(handler).toHaveBeenCalledWith(
      { to: "user-1", content: "hello" },
      expect.objectContaining({
        channelId: "telegram",
        phase: "message.pre",
        hookName: "message_sending",
      }),
    );
  });
});
