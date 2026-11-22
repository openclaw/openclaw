import { afterEach, describe, expect, it } from "vitest";
import type { NodePluginToolDescriptor } from "../../packages/gateway-protocol/src/index.js";
import {
  listConnectedNodePluginTools,
  publishNodeSessionPluginTools,
  removeConnectedNodePluginTools,
  type RegisteredNodePluginToolCommand,
} from "./node-plugin-tool-snapshot.js";
import { makeNodeSession } from "./node-registry.test-helpers.js";

function descriptor(name: string, command = "demo.echo"): NodePluginToolDescriptor {
  return {
    pluginId: "demo",
    name,
    description: `Description for ${name}`,
    command,
  };
}

function publish(
  tools: readonly NodePluginToolDescriptor[],
  {
    allowedCommands = ["demo.echo"],
    registrations = [],
    enabled,
  }: {
    allowedCommands?: string[];
    registrations?: RegisteredNodePluginToolCommand[];
    enabled?: boolean;
  } = {},
) {
  const node = makeNodeSession("snapshot-test", {
    commands: allowedCommands,
    declaredNodePluginTools: [...tools],
  });
  publishNodeSessionPluginTools(node, enabled, registrations);
  return node.nodePluginTools;
}

afterEach(() => removeConnectedNodePluginTools("snapshot-test"));

describe("publishNodeSessionPluginTools", () => {
  it("returns independently ordered lists without changing published node tools", () => {
    const tools = Object.freeze([descriptor("z_tool"), descriptor("a_tool")]);
    expect(publish(tools).map((tool) => tool.name)).toEqual(["a_tool", "z_tool"]);
    const listed = listConnectedNodePluginTools();
    expect(listed.map((tool) => tool.descriptor.name)).toEqual(["a_tool", "z_tool"]);
    listed.pop();
    expect(listConnectedNodePluginTools()).toHaveLength(2);
    expect(tools.map((tool) => tool.name)).toEqual(["z_tool", "a_tool"]);
  });

  it("trusts unregistered descriptors inside the approved command surface", () => {
    const tools = publish([descriptor("demo_echo"), descriptor("demo_blocked", "demo.blocked")]);
    expect(tools.map((tool) => tool.name)).toEqual(["demo_echo"]);
  });

  it("drops descriptors that claim the reserved node-mcp id without the MCP shape", () => {
    const tools = publish(
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

    expect(tools.map((tool) => tool.name)).toEqual(["srv_echo"]);
  });

  it("distinguishes registered metadata from node-supplied metadata and caps its description", () => {
    const tools = publish([descriptor("demo_echo"), descriptor("demo_status", "demo.status")], {
      allowedCommands: ["demo.echo", "demo.status"],
      registrations: [
        {
          pluginId: "demo",
          command: {
            command: "demo.echo",
            agentTool: {
              name: "demo_echo",
              description: `  ${"r".repeat(1200)}  `,
              parameters: { type: "object", properties: { text: { type: "string" } } },
            },
          },
        },
      ],
    });

    expect(tools[0]?.description).toHaveLength(1024);
    expect(tools[0]?.parameters).toEqual({
      type: "object",
      properties: { text: { type: "string" } },
    });
    expect(
      listConnectedNodePluginTools().map((tool) => ({
        name: tool.descriptor.name,
        registered: tool.registered,
      })),
    ).toEqual([
      { name: "demo_echo", registered: true },
      { name: "demo_status", registered: false },
    ]);
  });

  it("sorts before keeping at most 128 descriptors", () => {
    const tools = Array.from({ length: 130 }, (_, index) =>
      descriptor(`tool_${String(index).padStart(3, "0")}`),
    ).toReversed();

    const normalized = publish(tools);

    expect(normalized).toHaveLength(128);
    expect(normalized[0]?.name).toBe("tool_000");
    expect(normalized[127]?.name).toBe("tool_127");
  });

  it("returns no descriptors when gateway publication is disabled", () => {
    expect(publish([descriptor("demo_echo")], { enabled: false })).toEqual([]);
  });
});
