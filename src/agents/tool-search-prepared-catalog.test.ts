import { publishRuntimeToolInputSchema } from "@openclaw/ai/internal/tool-schema";
import { describe, expect, it } from "vitest";
import { prepareToolSearchCatalogDescriptors } from "./tool-search-prepared-catalog.js";
import type { ToolSearchCatalogEntry } from "./tool-search-types.js";

describe("prepareToolSearchCatalogDescriptors", () => {
  it("snapshots shareable MCP metadata that carries undefined optional fields", () => {
    const entry = {
      id: "mcp__server__lookup",
      source: "mcp",
      sourceName: "server",
      mcp: { serverName: "server", toolName: "lookup", mode: undefined },
      name: "lookup",
      description: "Look something up",
      parameters: publishRuntimeToolInputSchema({ type: "object", properties: {} }).schema,
      tool: {},
    } as unknown as ToolSearchCatalogEntry;

    const { prepared } = prepareToolSearchCatalogDescriptors([entry]);

    expect(prepared.descriptors[0]!.mcp).toEqual({ serverName: "server", toolName: "lookup" });
    expect(Object.isFrozen(prepared.descriptors[0]!.mcp)).toBe(true);
  });
});
