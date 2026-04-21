import { describe, expect, it } from "vitest";
import {
  buildMcpToolSchema,
  filterToolSchemaByVisibility,
  isToolVisibleTo,
  type McpToolSchemaEntry,
} from "./mcp-http.schema.js";

// ---------------------------------------------------------------------------
// filterToolSchemaByVisibility
// ---------------------------------------------------------------------------

describe("filterToolSchemaByVisibility", () => {
  const modelOnlyTool: McpToolSchemaEntry = {
    name: "model_only",
    description: "model-only tool",
    inputSchema: { type: "object", properties: {} },
    _meta: { ui: { resourceUri: "ui://test/model.html", visibility: ["model"] } },
  };

  const appOnlyTool: McpToolSchemaEntry = {
    name: "app_only",
    description: "app-only tool",
    inputSchema: { type: "object", properties: {} },
    _meta: { ui: { resourceUri: "ui://test/app.html", visibility: ["app"] } },
  };

  const bothTool: McpToolSchemaEntry = {
    name: "both",
    description: "visible to model and app",
    inputSchema: { type: "object", properties: {} },
    _meta: { ui: { resourceUri: "ui://test/both.html", visibility: ["model", "app"] } },
  };

  const noVisibilityTool: McpToolSchemaEntry = {
    name: "no_vis",
    description: "no visibility field",
    inputSchema: { type: "object", properties: {} },
    _meta: { ui: { resourceUri: "ui://test/novis.html" } },
  };

  const plainTool: McpToolSchemaEntry = {
    name: "plain",
    description: "no _meta at all",
    inputSchema: { type: "object", properties: {} },
  };

  const allTools = [modelOnlyTool, appOnlyTool, bothTool, noVisibilityTool, plainTool];

  it("returns all tools when callerRole is undefined", () => {
    const filtered = filterToolSchemaByVisibility(allTools, undefined);
    expect(filtered).toHaveLength(allTools.length);
  });

  it("filters out app-only tools when callerRole is model", () => {
    const filtered = filterToolSchemaByVisibility(allTools, "model");
    const names = filtered.map((t) => t.name);
    expect(names).toContain("model_only");
    expect(names).toContain("both");
    expect(names).toContain("no_vis");
    expect(names).toContain("plain");
    expect(names).not.toContain("app_only");
  });

  it("filters out model-only tools when callerRole is app", () => {
    const filtered = filterToolSchemaByVisibility(allTools, "app");
    const names = filtered.map((t) => t.name);
    expect(names).toContain("app_only");
    expect(names).toContain("both");
    expect(names).toContain("no_vis");
    expect(names).toContain("plain");
    expect(names).not.toContain("model_only");
  });
});

// ---------------------------------------------------------------------------
// isToolVisibleTo
// ---------------------------------------------------------------------------

describe("isToolVisibleTo", () => {
  it("returns true for any callerRole when tool has no _meta", () => {
    const tool: McpToolSchemaEntry = {
      name: "plain",
      description: undefined,
      inputSchema: { type: "object" },
    };
    expect(isToolVisibleTo(tool, "model")).toBe(true);
    expect(isToolVisibleTo(tool, "app")).toBe(true);
    expect(isToolVisibleTo(tool, undefined)).toBe(true);
  });

  it("returns false for app caller on model-only tool", () => {
    const tool: McpToolSchemaEntry = {
      name: "t",
      description: undefined,
      inputSchema: { type: "object" },
      _meta: { ui: { resourceUri: "ui://x/y.html", visibility: ["model"] } },
    };
    expect(isToolVisibleTo(tool, "app")).toBe(false);
    expect(isToolVisibleTo(tool, "model")).toBe(true);
  });

  it("returns false for model caller on app-only tool", () => {
    const tool: McpToolSchemaEntry = {
      name: "t",
      description: undefined,
      inputSchema: { type: "object" },
      _meta: { ui: { resourceUri: "ui://x/y.html", visibility: ["app"] } },
    };
    expect(isToolVisibleTo(tool, "model")).toBe(false);
    expect(isToolVisibleTo(tool, "app")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// buildMcpToolSchema — mcpAppUi propagation
// ---------------------------------------------------------------------------

describe("buildMcpToolSchema", () => {
  it("includes _meta.ui with visibility when tool has mcpAppUi", () => {
    const tools = [
      {
        name: "chart",
        description: "Show chart",
        parameters: { type: "object", properties: {} },
        mcpAppUi: {
          resourceUri: "ui://test/chart.html",
          visibility: ["model", "app"] as Array<"model" | "app">,
        },
        execute: async () => ({ content: [{ type: "text", text: "ok" }] }),
      },
    ];
    const schema = buildMcpToolSchema(tools as never);
    expect(schema[0]?._meta?.ui?.resourceUri).toBe("ui://test/chart.html");
    expect(schema[0]?._meta?.ui?.visibility).toEqual(["model", "app"]);
  });

  it("omits _meta when tool has no mcpAppUi", () => {
    const tools = [
      {
        name: "ping",
        description: "Ping",
        parameters: { type: "object", properties: {} },
        execute: async () => ({ content: [{ type: "text", text: "pong" }] }),
      },
    ];
    const schema = buildMcpToolSchema(tools as never);
    expect(schema[0]?._meta).toBeUndefined();
  });
});
