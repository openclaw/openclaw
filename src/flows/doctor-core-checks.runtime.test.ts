import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AnyAgentTool } from "../agents/tools/common.js";
import { setPluginToolMeta } from "../plugins/tools.js";

const mocks = vi.hoisted(() => ({
  createBundleMcpToolRuntime: vi.fn(),
  createOpenClawCodingTools: vi.fn(),
  disposeBundleRuntime: vi.fn(),
  loadModelCatalog: vi.fn(async () => []),
  normalizeProviderToolSchemasWithPlugin: vi.fn(),
  resolveDefaultModelForAgent: vi.fn(() => ({ provider: "openai", model: "gpt-5.5" })),
}));

vi.mock("../agents/model-catalog.js", () => ({
  findModelInCatalog: () => undefined,
  loadModelCatalog: mocks.loadModelCatalog,
}));

vi.mock("../agents/model-selection.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../agents/model-selection.js")>()),
  resolveDefaultModelForAgent: mocks.resolveDefaultModelForAgent,
}));

vi.mock("../agents/agent-bundle-mcp-tools.js", () => ({
  createBundleMcpToolRuntime: mocks.createBundleMcpToolRuntime,
}));

vi.mock("../agents/agent-tools.js", () => ({
  createOpenClawCodingTools: mocks.createOpenClawCodingTools,
}));

vi.mock("../plugins/provider-runtime.js", () => ({
  inspectProviderToolSchemasWithPlugin: () => [],
  normalizeProviderToolSchemasWithPlugin: mocks.normalizeProviderToolSchemasWithPlugin,
}));

const { collectRuntimeToolSchemaFindings } = await import("./doctor-core-checks.runtime.js");

function tool(name: string, parameters: unknown): AnyAgentTool {
  return {
    name,
    label: name,
    description: name,
    parameters,
    execute: async () => ({ text: "ok" }),
  } as unknown as AnyAgentTool;
}

function bundleMcpTool(name: string, parameters: unknown): AnyAgentTool {
  const entry = tool(name, parameters);
  setPluginToolMeta(entry, { pluginId: "bundle-mcp", optional: false });
  return entry;
}

describe("doctor runtime tool schema checks", () => {
  beforeEach(() => {
    mocks.createOpenClawCodingTools.mockReset().mockReturnValue([]);
    mocks.createBundleMcpToolRuntime.mockReset().mockResolvedValue({
      tools: [],
      dispose: mocks.disposeBundleRuntime,
    });
    mocks.disposeBundleRuntime.mockReset().mockResolvedValue(undefined);
    mocks.loadModelCatalog.mockClear();
    mocks.normalizeProviderToolSchemasWithPlugin
      .mockReset()
      .mockImplementation(({ context }) => context.tools);
    mocks.resolveDefaultModelForAgent.mockClear();
  });

  it("reports active bundle MCP tool schemas that would be quarantined before a model turn", async () => {
    mocks.createBundleMcpToolRuntime.mockResolvedValueOnce({
      tools: [
        bundleMcpTool("dofbot__healthy", { type: "object", properties: {} }),
        bundleMcpTool("dofbot__dofbot_move_angles", {
          type: "array",
          items: { type: "number" },
        }),
      ],
      dispose: mocks.disposeBundleRuntime,
    });

    await expect(
      collectRuntimeToolSchemaFindings({
        mcp: {
          servers: {
            dofbot: { command: "node", args: ["dofbot-mcp.mjs"] },
          },
        },
      }),
    ).resolves.toContainEqual({
      checkId: "core/doctor/runtime-tool-schemas",
      severity: "error",
      message:
        "Tool dofbot__dofbot_move_angles from plugin bundle-mcp has an unsupported input schema for runtime projection.",
      path: "mcp.servers",
      target: "dofbot__dofbot_move_angles",
      requirement: 'dofbot__dofbot_move_angles.parameters.type must be "object"',
      fixHint:
        "Disable or update the offending MCP server/tool so its parameters are a JSON object schema, then rerun doctor.",
    });
    expect(mocks.disposeBundleRuntime).toHaveBeenCalledTimes(1);
  });

  it("does not report bundle MCP schemas filtered out by the final runtime tool policy", async () => {
    mocks.createBundleMcpToolRuntime.mockResolvedValueOnce({
      tools: [
        bundleMcpTool("dofbot__dofbot_move_angles", {
          type: "array",
          items: { type: "number" },
        }),
      ],
      dispose: mocks.disposeBundleRuntime,
    });

    await expect(
      collectRuntimeToolSchemaFindings({
        tools: { deny: ["bundle-mcp"] },
        mcp: {
          servers: {
            dofbot: { command: "node", args: ["dofbot-mcp.mjs"] },
          },
        },
      }),
    ).resolves.toEqual([]);
  });
});
