import { publishRuntimeToolInputSchema } from "@openclaw/ai/internal/tool-schema";
import { afterEach, describe, expect, it } from "vitest";
import { setPluginToolMeta } from "../plugins/tool-metadata.js";
import { buildCodeModeCatalogPrompt, runCodeModeScriptHeadless } from "./code-mode.js";
import { resetCodeModeTestState } from "./code-mode.test-support.js";
import { createAgentHarnessToolSurfaceRuntimeCore } from "./harness/tool-surface-bridge.js";
import { projectMcpCallToolResult } from "./mcp-content.js";
import { createMcpJsonSchemaValidator } from "./mcp-json-schema-validator.js";
import { normalizeMcpToolCatalog } from "./mcp-tool-metadata.js";
import { fakeTool } from "./test-helpers/fake-tool.js";
import { addClientToolsToToolCatalog } from "./tool-search-catalog.js";
import { jsonResult, type AnyAgentTool } from "./tools/common.js";

describe("catalog reuse across run lifetimes", () => {
  afterEach(resetCodeModeTestState);

  it("preserves deep MCP output validation when schema publication would truncate it", () => {
    let childSchema: Record<string, unknown> = { type: "string" };
    let childValue: unknown = 42;
    for (let depth = 0; depth < 130; depth++) {
      childSchema = {
        type: "object",
        properties: { child: childSchema },
        required: ["child"],
      };
      childValue = { child: childValue };
    }
    const { metadata } = normalizeMcpToolCatalog(
      [
        {
          name: "deep_output",
          inputSchema: { type: "object" },
          outputSchema: {
            type: "object",
            properties: { child: childSchema },
            required: ["child"],
          },
        },
      ],
      createMcpJsonSchemaValidator(),
    );
    expect(() =>
      metadata.validatorForCall("deep_output")!({
        content: [],
        structuredContent: { child: childValue },
      }),
    ).toThrow("does not match");
  });
  it.each(["openclaw", "mcp", "client"] as const)(
    "reuses equivalent %s catalogs across sessions while executing only the current run",
    async (source) => {
      const config = { tools: { codeMode: { enabled: true } } };
      let prompt: string | undefined;
      for (let turn = 0; turn < 3; turn++) {
        const surface = createAgentHarnessToolSurfaceRuntimeCore({
          config,
          modelToolsEnabled: true,
          sessionKey: `agent:main:catalog-reuse-${turn}`,
          runId: `catalog-reuse-${turn}`,
        });
        const tools = ["reuse_alpha", "reuse_beta"].map((name) => {
          const tool = fakeTool(`${source}_${name}`, "Catalog lifetime regression");
          const schema = {
            type: "object" as const,
            properties: { value: { type: "string" } },
          };
          tool.parameters = (
            source !== "mcp"
              ? turn === 0 || source === "client"
                ? schema
                : publishRuntimeToolInputSchema(schema).schema
              : normalizeMcpToolCatalog(
                  [{ name, inputSchema: schema }],
                  createMcpJsonSchemaValidator(),
                ).tools[0]!.inputSchema
          ) as AnyAgentTool["parameters"];
          if (source === "mcp") {
            setPluginToolMeta(tool, {
              pluginId: "bundle-mcp",
              optional: false,
              mcp: {
                serverName: "reuse",
                safeServerName: "reuse",
                toolName: name,
                operation: "tool",
              },
            });
          }
          tool.execute = async () =>
            source === "mcp"
              ? projectMcpCallToolResult({ content: [], structuredContent: { turn } })
              : jsonResult({ turn });
          return tool;
        });
        const orderedTools = turn % 2 ? tools.toReversed() : tools;
        const { catalog } = surface.compactTools(source === "client" ? [] : orderedTools);
        const result =
          source === "client"
            ? addClientToolsToToolCatalog({
                tools: orderedTools,
                enabled: true,
                catalogRef: surface.toolSearchCatalogRef,
              })
            : catalog;
        try {
          expect(result.catalogReused).toBe(turn > 0);
          const ctx = { config, catalogRef: surface.toolSearchCatalogRef };
          const rendered = buildCodeModeCatalogPrompt(ctx, ctx.catalogRef!.current!.entries);
          prompt ??= rendered;
          expect(rendered).toBe(prompt);
          const executed = await runCodeModeScriptHeadless({
            ctx,
            code: `const [tool] = await catalog.search("${source}_reuse_alpha", { limit: 1 }); return await tool({});`,
          });
          expect(executed.status, JSON.stringify(executed)).toBe("completed");
          expect(executed).toMatchObject({
            value: source === "mcp" ? { structuredContent: { turn } } : { turn },
          });
        } finally {
          surface.cleanup();
        }
        expect(surface.toolSearchCatalogRef?.current).toBeUndefined();
      }
    },
  );

  it("keeps interleaved schema revisions separate without a plugin generation change", () => {
    const prompts: string[] = [];
    for (const [index, type] of ["string", "number", "string"].entries()) {
      const config = { tools: { codeMode: { enabled: true } } };
      const surface = createAgentHarnessToolSurfaceRuntimeCore({ config, modelToolsEnabled: true });
      const tool = fakeTool("reuse_revision", "Schema revision contract");
      tool.parameters = publishRuntimeToolInputSchema({
        type: "object",
        properties: { value: { type } },
      }).schema as AnyAgentTool["parameters"];
      try {
        expect(surface.compactTools([tool]).catalog.catalogReused).toBe(index === 2);
        prompts.push(
          buildCodeModeCatalogPrompt(
            { config, catalogRef: surface.toolSearchCatalogRef },
            surface.toolSearchCatalogRef!.current!.entries,
          ),
        );
      } finally {
        surface.cleanup();
      }
    }
    expect(prompts[0]).not.toBe(prompts[1]);
    expect(prompts[0]).toBe(prompts[2]);
  });
});
