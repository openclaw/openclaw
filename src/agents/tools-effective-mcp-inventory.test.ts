import { Type } from "typebox";
import { afterEach, expect, it, vi } from "vitest";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { setPluginToolMeta } from "../plugins/tool-metadata.js";
import { createStubTool } from "./test-helpers/agent-tool-stubs.js";
import { buildRuntimeCompatibleMcpToolInventory } from "./tools-effective-mcp-inventory.js";
import type { AnyAgentTool } from "./tools/common.js";

const normalizeToolsMock = vi.hoisted(() =>
  vi.fn((options: { tools: AnyAgentTool[] }) => options.tools),
);

vi.mock("./embedded-agent-runner/tool-schema-runtime.js", () => ({
  normalizeProviderToolSchemas: normalizeToolsMock,
  logProviderToolSchemaDiagnostics: vi.fn(),
}));

afterEach(() => {
  setActivePluginRegistry(createEmptyPluginRegistry());
});

it("preserves MCP inventory ownership and fallback without loading registry metadata", () => {
  const registry = createEmptyPluginRegistry();
  const readMetadata = vi.fn(() => []);
  Object.defineProperty(registry, "toolMetadata", { get: readMetadata });
  setActivePluginRegistry(registry);
  readMetadata.mockClear();
  const tool = {
    ...createStubTool("fixture_lookup"),
    label: "Lookup",
    displaySummary: "Search the fixture.",
  };
  setPluginToolMeta(tool, {
    pluginId: "fixture-plugin",
    optional: false,
    mcp: {
      serverName: "fixture",
      safeServerName: "fixture",
      toolName: "lookup",
      operation: "tool",
      deniedBySession: true,
    },
  });
  const inventory = buildRuntimeCompatibleMcpToolInventory({
    cfg: {},
    tools: [
      tool,
      { ...createStubTool("other_lookup"), label: "Lookup", description: "Another lookup." },
      {
        ...createStubTool("invalid"),
        label: "Invalid",
        description: "Invalid schema",
        parameters: Type.Array(Type.String()),
      },
    ],
  });

  expect(inventory.entries[0]).toEqual({
    id: "fixture_lookup",
    label: "Lookup (bundle-mcp)",
    description: "Search the fixture.",
    rawDescription: "Search the fixture.",
    source: "mcp",
    pluginId: "bundle-mcp",
    mcpServer: "fixture",
    mcpToolName: "lookup",
    deniedBySession: true,
  });
  expect(inventory.entries[1]?.label).toBe("Lookup (bundle-mcp)");
  expect(inventory.notices[0]?.message).toContain('Tool "invalid" from plugin "bundle-mcp"');
  expect(normalizeToolsMock).toHaveBeenCalledWith(
    expect.objectContaining({ allowRuntimePluginLoad: false }),
  );
  expect(readMetadata).not.toHaveBeenCalled();
});
