import { describe, expect, it, vi } from "vitest";
import type { AnyAgentTool } from "../agents/tools/common.js";
import { createEmptyPluginRegistry } from "../plugins/registry.js";
import { addExtensionHostToolRegistration } from "./runtime-registry.js";
import { getExtensionHostPluginToolMeta, resolveExtensionHostPluginTools } from "./tool-runtime.js";

function makeTool(name: string): AnyAgentTool {
  return {
    name,
    description: `${name} tool`,
    parameters: { type: "object", properties: {} },
    async execute() {
      return { content: [{ type: "text", text: "ok" }] };
    },
  };
}

function createContext() {
  return {
    config: {
      plugins: {
        enabled: true,
      },
    },
    workspaceDir: "/tmp",
  };
}

describe("resolveExtensionHostPluginTools", () => {
  it("allows optional tools through tool, plugin, and plugin-group allowlists", () => {
    const registry = createEmptyPluginRegistry();
    addExtensionHostToolRegistration(registry, {
      pluginId: "optional-demo",
      optional: true,
      source: "/tmp/optional-demo.js",
      factory: () => makeTool("optional_tool"),
      names: ["optional_tool"],
    });

    expect(
      resolveExtensionHostPluginTools({
        registry,
        context: createContext() as never,
      }),
    ).toEqual([]);
    expect(
      resolveExtensionHostPluginTools({
        registry,
        context: createContext() as never,
        toolAllowlist: ["optional_tool"],
      }).map((tool) => tool.name),
    ).toEqual(["optional_tool"]);
    expect(
      resolveExtensionHostPluginTools({
        registry,
        context: createContext() as never,
        toolAllowlist: ["optional-demo"],
      }).map((tool) => tool.name),
    ).toEqual(["optional_tool"]);
    expect(
      resolveExtensionHostPluginTools({
        registry,
        context: createContext() as never,
        toolAllowlist: ["group:plugins"],
      }).map((tool) => tool.name),
    ).toEqual(["optional_tool"]);
  });

  it("records conflict diagnostics and preserves tool metadata", () => {
    const registry = createEmptyPluginRegistry();
    const extraTool = makeTool("other_tool");
    addExtensionHostToolRegistration(registry, {
      pluginId: "message",
      optional: false,
      source: "/tmp/message.js",
      factory: () => makeTool("optional_tool"),
      names: ["optional_tool"],
    });
    addExtensionHostToolRegistration(registry, {
      pluginId: "multi",
      optional: false,
      source: "/tmp/multi.js",
      factory: () => [makeTool("message"), extraTool],
      names: ["message", "other_tool"],
    });

    const tools = resolveExtensionHostPluginTools({
      registry,
      context: createContext() as never,
      existingToolNames: new Set(["message"]),
    });

    expect(tools.map((tool) => tool.name)).toEqual(["other_tool"]);
    expect(registry.diagnostics).toHaveLength(2);
    expect(registry.diagnostics[0]?.message).toContain("plugin id conflicts with core tool name");
    expect(registry.diagnostics[1]?.message).toContain("plugin tool name conflict");
    expect(getExtensionHostPluginToolMeta(extraTool)).toEqual({
      pluginId: "multi",
      optional: false,
    });
  });

  it("skips tool factories that throw", () => {
    const registry = createEmptyPluginRegistry();
    const factory = vi.fn(() => {
      throw new Error("boom");
    });
    addExtensionHostToolRegistration(registry, {
      pluginId: "broken",
      optional: false,
      source: "/tmp/broken.js",
      factory,
      names: ["broken_tool"],
    });

    expect(
      resolveExtensionHostPluginTools({
        registry,
        context: createContext() as never,
      }),
    ).toEqual([]);
    expect(factory).toHaveBeenCalledOnce();
  });
});
