/**
 * Tests for the MCP Apps gateway WS method handlers.
 *
 * Uses the same pattern as tools-catalog.test.ts: lightweight handler invocation
 * with mocked dependencies (config, session resolution, tool cache).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerBuiltinResource, unregisterResource } from "../mcp-app-resources.js";
import { mcpHandlers } from "./mcp.js";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock("../../config/config.js", () => ({
  loadConfig: vi.fn(() => ({ session: { mainKey: "main" } })),
}));

vi.mock("../../config/sessions.js", () => ({
  resolveMainSessionKey: vi.fn(() => "agent:main:main"),
}));

const mockToolSchema = [
  { name: "ping", description: "ping the server", inputSchema: { type: "object", properties: {} } },
  {
    name: "show_chart",
    description: "render a chart",
    inputSchema: { type: "object", properties: {} },
    _meta: { ui: { resourceUri: "ui://openclaw-charts/chart.html" } },
  },
];

const mockExecutePing = vi.fn(async () => ({
  content: [{ type: "text", text: "pong" }],
}));

const mockTools = [
  {
    name: "ping",
    description: "ping the server",
    parameters: { type: "object", properties: {} },
    execute: mockExecutePing,
  },
  {
    name: "show_chart",
    description: "render a chart",
    parameters: { type: "object", properties: {} },
    mcpAppUi: { resourceUri: "ui://openclaw-charts/chart.html" },
    execute: vi.fn(async () => ({ content: [{ type: "text", text: "chart data" }] })),
  },
];

vi.mock("../mcp-http.runtime.js", () => {
  const cache = {
    resolve: vi.fn(() => ({ tools: mockTools, toolSchema: mockToolSchema })),
  };
  return {
    McpLoopbackToolCache: class {
      resolve = cache.resolve;
    },
  };
});

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

type RespondCall = [boolean, unknown?, { code: number; message: string }?];

function invokeHandler(method: string, params: Record<string, unknown>) {
  const respond = vi.fn();
  const promise = mcpHandlers[method]?.({
    params,
    respond: respond as never,
    context: {} as never,
    client: null,
    req: { type: "req", id: "req-1", method },
    isWebchatConnect: () => false,
  });
  return { respond, promise: promise ?? Promise.resolve() };
}

const TEST_RESOURCE_URI = "ui://test/mcp-handler-test.html";

beforeEach(() => {
  registerBuiltinResource({
    uri: TEST_RESOURCE_URI,
    name: "Handler Test",
    html: "<!DOCTYPE html><html><body>test</body></html>",
  });
});

afterEach(() => {
  unregisterResource(TEST_RESOURCE_URI);
  mockExecutePing.mockClear();
});

// ---------------------------------------------------------------------------
// mcp.tools.list
// ---------------------------------------------------------------------------

describe("mcp.tools.list", () => {
  it("returns the list of tools including _meta.ui on app-enabled tools", async () => {
    const { respond, promise } = invokeHandler("mcp.tools.list", {});
    await promise;

    expect(respond).toHaveBeenCalledOnce();
    const [ok, payload] = respond.mock.calls[0] as RespondCall;
    expect(ok).toBe(true);
    const tools = (payload as { tools: unknown[] }).tools;
    expect(Array.isArray(tools)).toBe(true);

    const chartTool = tools.find((t) => (t as { name: string }).name === "show_chart");
    expect(chartTool).toBeDefined();
    expect((chartTool as { _meta?: { ui?: { resourceUri: string } } })._meta?.ui?.resourceUri).toBe(
      "ui://openclaw-charts/chart.html",
    );
  });

  it("accepts optional sessionKey parameter", async () => {
    const { respond, promise } = invokeHandler("mcp.tools.list", {
      sessionKey: "board:abc123",
    });
    await promise;
    const [ok] = respond.mock.calls[0] as RespondCall;
    expect(ok).toBe(true);
  });

  it("rejects invalid params", async () => {
    const { respond, promise } = invokeHandler("mcp.tools.list", {
      extraUnexpected: true, // additionalProperties: false
    });
    await promise;
    const [ok] = respond.mock.calls[0] as RespondCall;
    expect(ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// mcp.tools.call
// ---------------------------------------------------------------------------

describe("mcp.tools.call", () => {
  it("executes a tool and returns the result", async () => {
    const { respond, promise } = invokeHandler("mcp.tools.call", {
      name: "ping",
      arguments: {},
    });
    await promise;

    expect(respond).toHaveBeenCalledOnce();
    const [ok, payload] = respond.mock.calls[0] as RespondCall;
    expect(ok).toBe(true);
    const result = payload as { content: Array<{ type: string; text: string }>; isError: boolean };
    expect(result.isError).toBe(false);
    expect(result.content[0]?.text).toBe("pong");
  });

  it("includes _meta.ui in result for MCP App tools", async () => {
    const { respond, promise } = invokeHandler("mcp.tools.call", {
      name: "show_chart",
      arguments: {},
    });
    await promise;

    const [ok, payload] = respond.mock.calls[0] as RespondCall;
    expect(ok).toBe(true);
    const result = payload as { _meta?: { ui?: { resourceUri: string } } };
    expect(result._meta?.ui?.resourceUri).toBe("ui://openclaw-charts/chart.html");
  });

  it("returns isError:true for unknown tool names", async () => {
    const { respond, promise } = invokeHandler("mcp.tools.call", {
      name: "nonexistent_tool",
      arguments: {},
    });
    await promise;

    const [ok, payload] = respond.mock.calls[0] as RespondCall;
    expect(ok).toBe(true);
    expect((payload as { isError: boolean }).isError).toBe(true);
  });

  it("rejects missing name param", async () => {
    const { respond, promise } = invokeHandler("mcp.tools.call", { arguments: {} });
    await promise;
    const [ok] = respond.mock.calls[0] as RespondCall;
    expect(ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// mcp.resources.list
// ---------------------------------------------------------------------------

describe("mcp.resources.list", () => {
  it("returns the list of registered resources", async () => {
    const { respond, promise } = invokeHandler("mcp.resources.list", {});
    await promise;

    const [ok, payload] = respond.mock.calls[0] as RespondCall;
    expect(ok).toBe(true);
    const resources = (payload as { resources: Array<{ uri: string }> }).resources;
    expect(Array.isArray(resources)).toBe(true);
    expect(resources.some((r) => r.uri === TEST_RESOURCE_URI)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// mcp.resources.read
// ---------------------------------------------------------------------------

describe("mcp.resources.read", () => {
  it("returns HTML content for a registered resource", async () => {
    const { respond, promise } = invokeHandler("mcp.resources.read", {
      uri: TEST_RESOURCE_URI,
    });
    await promise;

    const [ok, payload] = respond.mock.calls[0] as RespondCall;
    expect(ok).toBe(true);
    const contents = (payload as { contents: Array<{ text: string; uri: string }> }).contents;
    expect(Array.isArray(contents)).toBe(true);
    expect(contents[0]?.text).toContain("<html>");
    expect(contents[0]?.uri).toBe(TEST_RESOURCE_URI);
  });

  it("returns error for unknown uri", async () => {
    const { respond, promise } = invokeHandler("mcp.resources.read", {
      uri: "ui://does-not-exist/page.html",
    });
    await promise;

    const [ok] = respond.mock.calls[0] as RespondCall;
    expect(ok).toBe(false);
  });

  it("rejects missing uri param", async () => {
    const { respond, promise } = invokeHandler("mcp.resources.read", {});
    await promise;

    const [ok] = respond.mock.calls[0] as RespondCall;
    expect(ok).toBe(false);
  });
});
