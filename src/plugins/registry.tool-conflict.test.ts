import { describe, expect, it } from "vitest";
import type { AnyAgentTool } from "../agents/tools/common.js";
import { createPluginRegistry, type PluginRecord } from "./registry.js";
import { createPluginRuntime } from "./runtime/index.js";

function makeRecord(id: string): PluginRecord {
  return {
    id,
    name: id,
    source: `/tmp/${id}.js`,
    origin: "global",
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

function makeTool(name: string): AnyAgentTool {
  return {
    name,
    label: name,
    description: `${name} tool`,
    parameters: { type: "object" as const, properties: {} },
    async execute() {
      return { content: [{ type: "text" as const, text: "ok" }], details: {} };
    },
  } as AnyAgentTool;
}

const noopLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

describe("registry registerTool cross-plugin conflicts", () => {
  it("allows the same plugin to register multiple tools", () => {
    const runtime = createPluginRuntime();
    const { registry, registerTool } = createPluginRegistry({
      logger: noopLogger,
      runtime,
    });
    const record = makeRecord("plugin-a");
    registerTool(record, makeTool("foo"));
    registerTool(record, makeTool("bar"));

    expect(registry.tools).toHaveLength(2);
    expect(registry.diagnostics).toHaveLength(0);
  });

  it("rejects a tool whose name conflicts with another plugin", () => {
    const runtime = createPluginRuntime();
    const { registry, registerTool } = createPluginRegistry({
      logger: noopLogger,
      runtime,
    });
    const recordA = makeRecord("plugin-a");
    const recordB = makeRecord("plugin-b");

    registerTool(recordA, makeTool("shared_name"));
    registerTool(recordB, makeTool("shared_name"));

    // Only one tool entry should exist
    expect(registry.tools).toHaveLength(1);
    expect(registry.tools[0]?.pluginId).toBe("plugin-a");

    // Diagnostic error should be recorded
    expect(registry.diagnostics).toHaveLength(1);
    expect(registry.diagnostics[0]?.level).toBe("error");
    expect(registry.diagnostics[0]?.pluginId).toBe("plugin-b");
    expect(registry.diagnostics[0]?.message).toContain("tool name conflict");
    expect(registry.diagnostics[0]?.message).toContain("shared_name");
    expect(registry.diagnostics[0]?.message).toContain("plugin-a");
  });

  it("rejects factory tool with declared name conflict", () => {
    const runtime = createPluginRuntime();
    const { registry, registerTool } = createPluginRegistry({
      logger: noopLogger,
      runtime,
    });
    const recordA = makeRecord("plugin-a");
    const recordB = makeRecord("plugin-b");

    registerTool(recordA, makeTool("my_tool"));
    registerTool(recordB, () => makeTool("anything"), { name: "my_tool" });

    expect(registry.tools).toHaveLength(1);
    expect(registry.diagnostics).toHaveLength(1);
    expect(registry.diagnostics[0]?.message).toContain("my_tool");
  });

  it("does not block same-plugin duplicate names at registration time", () => {
    // Intra-plugin duplicates are caught later during resolvePluginTools
    const runtime = createPluginRuntime();
    const { registry, registerTool } = createPluginRegistry({
      logger: noopLogger,
      runtime,
    });
    const record = makeRecord("plugin-a");

    registerTool(record, makeTool("dup"));
    registerTool(record, makeTool("dup"));

    // Both registered; resolvePluginTools handles intra-plugin dedup
    expect(registry.tools).toHaveLength(2);
    expect(registry.diagnostics).toHaveLength(0);
  });

  it("does not add conflicting tool names to the plugin record", () => {
    const runtime = createPluginRuntime();
    const { registerTool } = createPluginRegistry({
      logger: noopLogger,
      runtime,
    });
    const recordA = makeRecord("plugin-a");
    const recordB = makeRecord("plugin-b");

    registerTool(recordA, makeTool("conflict_tool"));
    registerTool(recordB, makeTool("conflict_tool"));

    expect(recordA.toolNames).toEqual(["conflict_tool"]);
    expect(recordB.toolNames).toEqual([]);
  });
});
