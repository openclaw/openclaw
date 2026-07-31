// Nodes tool schema and ownership tests stay separate from media execution coverage.
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const gatewayMocks = vi.hoisted(() => ({
  callGatewayTool: vi.fn(),
  readGatewayCallOptions: vi.fn(() => ({})),
}));

const nodeUtilsMocks = vi.hoisted(() => ({
  resolveNodeId: vi.fn(async () => "node-1"),
  resolveNode: vi.fn(async () => ({ nodeId: "node-1" })),
}));

vi.mock("./gateway.js", () => ({
  callGatewayTool: gatewayMocks.callGatewayTool,
  readGatewayCallOptions: gatewayMocks.readGatewayCallOptions,
}));

vi.mock("./nodes-utils.js", () => ({
  resolveNodeId: nodeUtilsMocks.resolveNodeId,
  resolveNode: nodeUtilsMocks.resolveNode,
}));

let createNodesTool: typeof import("./nodes-tool.js").createNodesTool;

describe("createNodesTool schema and owner selection", () => {
  beforeAll(async () => {
    vi.resetModules();
    ({ createNodesTool } = await import("./nodes-tool.js"));
  });

  beforeEach(() => {
    gatewayMocks.callGatewayTool.mockReset();
    gatewayMocks.readGatewayCallOptions.mockReset().mockReturnValue({});
    nodeUtilsMocks.resolveNodeId.mockClear();
  });

  it("bounds durationMs schema to positive values capped at 300000", () => {
    const schema = createNodesTool().parameters as {
      properties?: { durationMs?: { minimum?: number; maximum?: number; type?: string } };
    };
    expect(schema.properties?.durationMs).toMatchObject({
      type: "integer",
      minimum: 1,
      maximum: 300_000,
    });
  });

  it("bounds photos_latest limit schema to positive values capped at 20", () => {
    const schema = createNodesTool().parameters as {
      properties?: { limit?: { minimum?: number; maximum?: number; type?: string } };
    };
    expect(schema.properties?.limit).toMatchObject({ type: "integer", minimum: 1, maximum: 20 });
  });

  it("advertises node media numeric constraints in the tool schema", () => {
    const schema = createNodesTool().parameters as {
      properties?: {
        maxWidth?: { minimum?: number; type?: string };
        quality?: { minimum?: number; maximum?: number; type?: string };
        delayMs?: { minimum?: number; type?: string };
        fps?: { exclusiveMinimum?: number; type?: string };
        screenIndex?: { minimum?: number; type?: string };
      };
    };
    expect(schema.properties?.maxWidth).toMatchObject({ type: "integer", minimum: 1 });
    expect(schema.properties?.quality).toMatchObject({ type: "number", minimum: 0, maximum: 1 });
    expect(schema.properties?.delayMs).toMatchObject({ type: "integer", minimum: 0 });
    expect(schema.properties?.fps).toMatchObject({ type: "number", exclusiveMinimum: 0 });
    expect(schema.properties?.screenIndex).toMatchObject({ type: "integer", minimum: 0 });
  });

  it("advertises node command timeout constraints in the tool schema", () => {
    const schema = createNodesTool().parameters as {
      properties?: {
        timeoutMs?: { minimum?: number; type?: string };
        maxAgeMs?: { minimum?: number; type?: string };
        locationTimeoutMs?: { minimum?: number; type?: string };
        invokeTimeoutMs?: { minimum?: number; type?: string };
      };
    };
    expect(schema.properties?.timeoutMs).toMatchObject({ type: "integer", minimum: 1 });
    expect(schema.properties?.maxAgeMs).toMatchObject({ type: "integer", minimum: 0 });
    expect(schema.properties?.locationTimeoutMs).toMatchObject({ type: "integer", minimum: 1 });
    expect(schema.properties?.invokeTimeoutMs).toMatchObject({ type: "integer", minimum: 1 });
  });

  it("guides node discovery before describe", () => {
    const tool = createNodesTool();
    const schema = tool.parameters as { properties?: { node?: { description?: string } } };

    expect(tool.description).toContain("Paired nodes: status/list");
    expect(tool.description).toContain("pass node to describe/control");
    expect(schema.properties?.node?.description).toBe(
      "Node ID, name, or IP. Required for describe and node-targeted actions; use status to discover nodes.",
    );
  });

  it("advertises typed executable lookup instead of requiring raw invoke JSON", () => {
    const tool = createNodesTool();
    const schema = tool.parameters as {
      properties?: {
        action?: { enum?: string[] };
        bins?: {
          type?: string;
          minItems?: number;
          maxItems?: number;
          items?: { type?: string; minLength?: number };
          description?: string;
        };
      };
    };

    expect(tool.description).toContain("executable lookup (which + bins)");
    expect(schema.properties?.action?.enum).toContain("which");
    expect(schema.properties?.bins).toMatchObject({
      type: "array",
      minItems: 1,
      maxItems: 64,
      items: { type: "string", minLength: 1 },
      description: "which: executable names to resolve on the selected node.",
    });
  });

  it("accepts an explicit owner without a session key on a multi-agent fleet", () => {
    expect(() =>
      createNodesTool({
        agentId: "ops",
        config: {
          agents: { ownership: "explicit", entries: { ops: {}, research: {} } },
        },
      }),
    ).not.toThrow();
  });

  it("requires an explicit node for describe and points to status", async () => {
    const tool = createNodesTool();
    await expect(tool.execute("call-describe", { action: "describe" })).rejects.toThrow(
      'node required for describe; call nodes with action="status" to list nodes, then retry with node',
    );
    expect(nodeUtilsMocks.resolveNodeId).not.toHaveBeenCalled();
    expect(gatewayMocks.callGatewayTool).not.toHaveBeenCalled();
  });

  it("resolves and describes the explicit node", async () => {
    gatewayMocks.callGatewayTool.mockResolvedValue({ nodeId: "node-1" });
    await createNodesTool().execute("call-describe", {
      action: "describe",
      node: "Office Mac",
    });

    expect(nodeUtilsMocks.resolveNodeId).toHaveBeenCalledWith({}, "Office Mac");
    expect(gatewayMocks.callGatewayTool).toHaveBeenCalledWith(
      "node.describe",
      {},
      {
        nodeId: "node-1",
      },
    );
  });
});
