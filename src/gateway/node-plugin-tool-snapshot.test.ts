import { describe, expect, it } from "vitest";
import type { NodePluginToolDescriptor } from "../../packages/gateway-protocol/src/index.js";
import {
  createRegisteredNodePluginToolDescriptorMap,
  listConnectedNodePluginTools,
  normalizeNodePluginToolDescriptors,
  removeConnectedNodePluginTools,
  replaceConnectedNodePluginTools,
} from "./node-plugin-tool-snapshot.js";

function descriptor(name: string, command = "demo.echo"): NodePluginToolDescriptor {
  return {
    pluginId: "demo",
    name,
    description: `Description for ${name}`,
    command,
  };
}

function normalize(
  tools: NodePluginToolDescriptor[],
  overrides: Partial<Parameters<typeof normalizeNodePluginToolDescriptors>[0]> = {},
) {
  return normalizeNodePluginToolDescriptors({
    nodeId: "node-1",
    tools,
    allowedCommands: ["demo.echo"],
    registeredDescriptors: new Map(),
    ...overrides,
  });
}

function registered(agentTool: { name: string; description: string; parameters?: unknown }) {
  return createRegisteredNodePluginToolDescriptorMap([
    { pluginId: "demo", command: { command: "demo.echo", agentTool } },
  ]);
}

describe("normalizeNodePluginToolDescriptors", () => {
  it("returns independently ordered lists without changing published node tools", () => {
    const tools = Object.freeze([
      { descriptor: descriptor("z_tool"), registered: false },
      { descriptor: descriptor("a_tool"), registered: true },
    ]);
    replaceConnectedNodePluginTools({ nodeId: "snapshot-test", tools });
    try {
      const listed = listConnectedNodePluginTools();
      expect(listed.map((tool) => tool.descriptor.name)).toEqual(["a_tool", "z_tool"]);
      listed.pop();
      expect(listConnectedNodePluginTools()).toHaveLength(2);
      expect(tools.map((tool) => tool.descriptor.name)).toEqual(["z_tool", "a_tool"]);
    } finally {
      removeConnectedNodePluginTools("snapshot-test");
    }
  });

  it("trusts unregistered descriptors inside the approved command surface", () => {
    const tools = normalize([descriptor("demo_echo"), descriptor("demo_blocked", "demo.blocked")]);
    expect(tools.map((tool) => tool.descriptor.name)).toEqual(["demo_echo"]);
  });

  it("drops descriptors that claim the reserved node-mcp id without the MCP shape", () => {
    const tools = normalize(
      [
        { ...descriptor("spoofed_tool"), pluginId: "node-mcp" },
        {
          ...descriptor("srv_echo", "mcp.tools.call.v1"),
          pluginId: "node-mcp",
          mcp: { server: "srv", tool: "echo" },
        },
      ],
      { allowedCommands: ["demo.echo", "mcp.tools.call.v1"] },
    );

    expect(tools.map((tool) => tool.descriptor.name)).toEqual(["srv_echo"]);
  });

  it("distinguishes registered metadata from node-supplied metadata and caps its description", () => {
    const tools = normalize([descriptor("demo_echo"), descriptor("demo_status", "demo.status")], {
      allowedCommands: ["demo.echo", "demo.status"],
      registeredDescriptors: registered({
        name: "demo_echo",
        description: `  ${"r".repeat(1200)}  `,
        parameters: { type: "object", properties: { text: { type: "string" } } },
      }),
    });

    expect(tools[0]?.descriptor.description).toHaveLength(1024);
    expect(tools[0]?.descriptor.parameters).toEqual({
      type: "object",
      properties: { text: { type: "string" } },
    });
    expect(
      tools.map((tool) => ({ name: tool.descriptor.name, registered: tool.registered })),
    ).toEqual([
      { name: "demo_echo", registered: true },
      { name: "demo_status", registered: false },
    ]);
  });

  it("sorts before keeping at most 128 descriptors", () => {
    const tools = Array.from({ length: 130 }, (_, index) =>
      descriptor(`tool_${String(index).padStart(3, "0")}`),
    ).toReversed();

    const normalized = normalize(tools);

    expect(normalized).toHaveLength(128);
    expect(normalized[0]?.descriptor.name).toBe("tool_000");
    expect(normalized[127]?.descriptor.name).toBe("tool_127");
  });

  it("returns no descriptors when gateway publication is disabled", () => {
    expect(normalize([descriptor("demo_echo")], { enabled: false })).toEqual([]);
  });
});
