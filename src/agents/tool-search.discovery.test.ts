import { expectDefined } from "@openclaw/normalization-core";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { mcpTool, pluginTool } from "./code-mode.test-support.js";
import {
  applyToolSearchCatalog,
  createToolSearchCatalogRef,
  createToolSearchTools,
  TOOL_DESCRIBE_RAW_TOOL_NAME,
  TOOL_SEARCH_RAW_TOOL_NAME,
} from "./tool-search.js";

describe("Tool Search schema discovery", () => {
  it("includes bounded input signatures in compact search hits", async () => {
    const target = pluginTool("fake_update", "Update a fake record");
    const openTarget = pluginTool("fake_open", "Accept constrained open input");
    const mcpTarget = mcpTool({
      name: "remote_echo",
      description: "Echo through remote MCP",
      serverName: "remote-demo",
      toolName: "echo",
    });
    target.parameters = {
      type: "object",
      required: ["id"],
      properties: {
        id: { type: "string" },
        mode: { type: "string", enum: ["drip", "flood"] },
        policy: { enum: ["auto", { mode: "custom" }] },
        nested: Type.Array(Type.Array(Type.Array(Type.Array(Type.Array(Type.String()))))),
        zones: { type: "array", items: { type: "string", enum: ["north", "south"] } },
      },
    };
    openTarget.parameters = {
      type: "object",
      required: ["token"],
      additionalProperties: true,
    };
    const config = { tools: { toolSearch: { mode: "tools" } } } as never;
    const catalogRef = createToolSearchCatalogRef();
    applyToolSearchCatalog({
      tools: [...createToolSearchTools({ config, catalogRef }), target, openTarget, mcpTarget],
      config,
      catalogRef,
    });
    const runtimeTools = createToolSearchTools({ config, catalogRef });
    const search = expectDefined(
      runtimeTools.find((tool) => tool.name === TOOL_SEARCH_RAW_TOOL_NAME),
      "search tool",
    );
    const result = (await search.execute("call-search", { query: "update record" })).details;

    expect(result).toEqual([
      expect.objectContaining({
        name: "fake_update",
        input:
          '{ id: string; mode?: "drip" | "flood"; nested?: Array<Array<Array<Array<unknown>>>>; policy?: unknown; zones?: Array<"north" | "south"> }',
      }),
    ]);
    expect(JSON.stringify(result)).not.toContain("parameters");

    const describeTool = expectDefined(
      runtimeTools.find((tool) => tool.name === TOOL_DESCRIBE_RAW_TOOL_NAME),
      "describe tool",
    );
    const described = (await describeTool.execute("call-describe", { id: "fake_update" })).details;
    expect(described).toMatchObject({
      description: "Update a fake record",
      parameters: {
        properties: {
          nested: {
            items: { items: { items: { items: { items: { type: "string" } } } } },
          },
        },
      },
    });
    expect(target.execute).not.toHaveBeenCalled();

    const openResult = (
      await search.execute("call-search-open", { query: "constrained open input" })
    ).details;
    expect(openResult).toContainEqual(
      expect.objectContaining({ name: "fake_open", input: "{ ... }" }),
    );

    const mcpResult = (await search.execute("call-search-mcp", { query: "remote echo" })).details;
    expect(mcpResult).toContainEqual(
      expect.objectContaining({ name: "remote_echo", input: "unknown" }),
    );
  });
});
