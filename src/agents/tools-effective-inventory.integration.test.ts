import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";
import { Type, type TSchema } from "@sinclair/typebox";
import { afterEach, describe, expect, it, vi } from "vitest";

function createWrappedTestTool(params: {
  name: string;
  label: string;
  description: string;
}): AgentTool<TSchema, unknown> {
  return {
    name: params.name,
    label: params.label,
    description: params.description,
    parameters: Type.Object({}, { additionalProperties: false }),
    execute: async (): Promise<AgentToolResult<unknown>> => ({
      content: [{ type: "text", text: "ok" }],
      details: {},
    }),
  } as AgentTool<TSchema, unknown>;
}

describe("resolveEffectiveToolInventory integration", () => {
  afterEach(() => {
    vi.resetModules();
  });

  it("preserves plugin and channel classification through the real tool wrapper pipeline", async () => {
    vi.resetModules();
    vi.doUnmock("./tools-effective-inventory.js");
    vi.doUnmock("./pi-tools.js");
    vi.doUnmock("./agent-scope.js");
    vi.doUnmock("./channel-tools.js");
    vi.doUnmock("../plugins/registry-empty.js");
    vi.doUnmock("../plugins/runtime.js");
    vi.doUnmock("../plugins/tools.js");
    vi.doUnmock("../test-utils/channel-plugins.js");

    const { createEmptyPluginRegistry } = await import("../plugins/registry-empty.js");
    const { resetPluginRuntimeStateForTest, setActivePluginRegistry } =
      await import("../plugins/runtime.js");
    const { createChannelTestPluginBase } = await import("../test-utils/channel-plugins.js");
    const { resolveEffectiveToolInventory } = await import("./tools-effective-inventory.js");

    const pluginTool = createWrappedTestTool({
      name: "docs_lookup",
      label: "Docs Lookup",
      description: "Search docs",
    });
    const channelTool = createWrappedTestTool({
      name: "channel_action",
      label: "Channel Action",
      description: "Act in channel",
    });

    const channelPlugin = {
      ...createChannelTestPluginBase({
        id: "telegram",
        label: "Telegram",
        capabilities: { chatTypes: ["direct"] },
      }),
      agentTools: [channelTool],
    };

    const registry = createEmptyPluginRegistry();
    registry.tools.push({
      pluginId: "docs",
      pluginName: "Docs",
      factory: () => pluginTool,
      names: ["docs_lookup"],
      optional: false,
      source: "test",
    });
    registry.channels.push({
      pluginId: "telegram",
      pluginName: "Telegram",
      plugin: channelPlugin,
      source: "test",
    });
    registry.channelSetups.push({
      pluginId: "telegram",
      pluginName: "Telegram",
      plugin: channelPlugin,
      source: "test",
      enabled: true,
    });
    setActivePluginRegistry(registry, "tools-effective-integration");

    const result = resolveEffectiveToolInventory({ cfg: { plugins: { enabled: true } } });

    const pluginGroup = result.groups.find((group) => group.source === "plugin");
    const channelGroup = result.groups.find((group) => group.source === "channel");
    const coreGroup = result.groups.find((group) => group.source === "core");

    expect(pluginGroup?.tools).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "docs_lookup",
          source: "plugin",
          pluginId: "docs",
        }),
      ]),
    );
    expect(channelGroup?.tools).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "channel_action",
          source: "channel",
          channelId: "telegram",
        }),
      ]),
    );
    expect(coreGroup?.tools.some((tool) => tool.id === "docs_lookup")).toBe(false);
    expect(coreGroup?.tools.some((tool) => tool.id === "channel_action")).toBe(false);
    resetPluginRuntimeStateForTest();
  });
});
