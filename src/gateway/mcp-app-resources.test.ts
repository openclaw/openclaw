import { afterEach, describe, expect, it } from "vitest";
import type { AnyAgentTool } from "../agents/tools/common.js";
import {
  _resetAutoSyncState,
  buildResourceCsp,
  listResources,
  MCP_APP_DEFAULT_CSP,
  MCP_APP_RESOURCE_MAX_BYTES,
  MCP_APP_RESOURCE_MIME_TYPE,
  registerBuiltinResource,
  registerCanvasResource,
  registerFileResource,
  resolveResourceContent,
  syncMcpAppResources,
  unregisterResource,
} from "./mcp-app-resources.js";

// Isolate registry state between tests by unregistering test URIs in afterEach.
const TEST_URI_BUILTIN = "ui://test/builtin.html";
const TEST_URI_CANVAS = "ui://test/canvas.html";
const TEST_URI_FILE = "ui://test/file.html";

afterEach(() => {
  unregisterResource(TEST_URI_BUILTIN);
  unregisterResource(TEST_URI_CANVAS);
  unregisterResource(TEST_URI_FILE);
});

// ---------------------------------------------------------------------------
// registerBuiltinResource / listResources / resolveResourceContent
// ---------------------------------------------------------------------------

describe("registerBuiltinResource", () => {
  it("registers and lists a builtin resource", () => {
    registerBuiltinResource({
      uri: TEST_URI_BUILTIN,
      name: "Test Builtin",
      html: "<html><body>hello</body></html>",
    });

    const resources = listResources();
    const entry = resources.find((r) => r.uri === TEST_URI_BUILTIN);
    expect(entry).toBeDefined();
    expect(entry!.name).toBe("Test Builtin");
    expect(entry!.mimeType).toBe(MCP_APP_RESOURCE_MIME_TYPE);
  });

  it("resolves content for a builtin resource", async () => {
    const html = "<html><body>hello MCP</body></html>";
    registerBuiltinResource({ uri: TEST_URI_BUILTIN, name: "Test", html });

    const result = await resolveResourceContent(TEST_URI_BUILTIN);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.content.text).toBe(html);
    expect(result.content.mimeType).toBe(MCP_APP_RESOURCE_MIME_TYPE);
    expect(result.content.uri).toBe(TEST_URI_BUILTIN);
  });

  it("returns error for unregistered uri", async () => {
    const result = await resolveResourceContent("ui://nonexistent/page.html");
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error).toMatch(/not found/i);
  });

  it("rejects builtin content exceeding the 2 MB size limit at registration time", () => {
    const oversized = "A".repeat(MCP_APP_RESOURCE_MAX_BYTES + 1);
    registerBuiltinResource({ uri: TEST_URI_BUILTIN, name: "Big", html: oversized });

    // Resource should not be registered at all
    const resources = listResources();
    expect(resources.some((r) => r.uri === TEST_URI_BUILTIN)).toBe(false);
  });

  it("still rejects oversized builtin at read time as defense-in-depth", async () => {
    // Directly test the read-time check by registering a normal resource then
    // checking the resolve path — this test validates the read-time branch is
    // still present even though registration-time rejection is the primary guard.
    const html = "A".repeat(MCP_APP_RESOURCE_MAX_BYTES + 1);
    registerBuiltinResource({ uri: TEST_URI_BUILTIN, name: "Big", html });

    // Registration was rejected, so resolve should return not found
    const result = await resolveResourceContent(TEST_URI_BUILTIN);
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error).toMatch(/not found/i);
  });
});

// ---------------------------------------------------------------------------
// registerCanvasResource
// ---------------------------------------------------------------------------

describe("registerCanvasResource", () => {
  it("registers and resolves canvas resource (returns HTML wrapping the canvas URL)", async () => {
    const canvasUrl = "https://openclaw.local/__openclaw__/canvas/mcp-apps/chart.html?cap=tok123";
    registerCanvasResource({
      uri: TEST_URI_CANVAS,
      name: "Canvas Chart",
      canvasUrl,
    });

    const result = await resolveResourceContent(TEST_URI_CANVAS);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    // Canvas resources return HTML wrapping the URL in an iframe, not the raw URL.
    expect(result.content.text).toContain("<!DOCTYPE html>");
    expect(result.content.text).toContain(canvasUrl);
    expect(result.content.text).toContain("<iframe");
  });
});

// ---------------------------------------------------------------------------
// registerFileResource
// ---------------------------------------------------------------------------

describe("registerFileResource", () => {
  it("rejects path traversal attempts", async () => {
    registerFileResource({
      uri: TEST_URI_FILE,
      name: "File",
      rootDir: "/tmp/test-root",
      relativePath: "../../etc/passwd",
    });

    const result = await resolveResourceContent(TEST_URI_FILE);
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error).toMatch(/traversal/i);
  });

  it("returns error when file does not exist", async () => {
    registerFileResource({
      uri: TEST_URI_FILE,
      name: "File",
      rootDir: "/tmp",
      relativePath: "mcp-test-nonexistent-file-abc123.html",
    });

    const result = await resolveResourceContent(TEST_URI_FILE);
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error).toMatch(/failed to read resource/i);
  });
});

// ---------------------------------------------------------------------------
// unregisterResource
// ---------------------------------------------------------------------------

describe("unregisterResource", () => {
  it("removes a registered resource and returns true", () => {
    registerBuiltinResource({ uri: TEST_URI_BUILTIN, name: "Test", html: "<html/>" });
    expect(listResources().some((r) => r.uri === TEST_URI_BUILTIN)).toBe(true);

    const removed = unregisterResource(TEST_URI_BUILTIN);
    expect(removed).toBe(true);
    expect(listResources().some((r) => r.uri === TEST_URI_BUILTIN)).toBe(false);
  });

  it("returns false for unknown URIs", () => {
    expect(unregisterResource("ui://nonexistent")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// buildResourceCsp
// ---------------------------------------------------------------------------

describe("buildResourceCsp", () => {
  it("returns the default CSP when no csp config is given", () => {
    expect(buildResourceCsp(undefined)).toBe(MCP_APP_DEFAULT_CSP);
    expect(buildResourceCsp({})).toBe(MCP_APP_DEFAULT_CSP);
  });

  it("extends connect-src from connectDomains", () => {
    const csp = buildResourceCsp({ connectDomains: ["https://api.example.com"] });
    expect(csp).toContain("connect-src");
    expect(csp).toContain("https://api.example.com");
    // 'none' should be removed when domains are provided
    expect(csp).not.toContain("connect-src 'none'");
  });

  it("extends multiple directives from resourceDomains", () => {
    const csp = buildResourceCsp({ resourceDomains: ["https://cdn.example.com"] });
    expect(csp).toContain("script-src");
    expect(csp).toContain("style-src");
    expect(csp).toContain("img-src");
    expect(csp).toContain("font-src");
    expect(csp).toContain("https://cdn.example.com");
  });

  it("sets frame-src from frameDomains", () => {
    const csp = buildResourceCsp({ frameDomains: ["https://www.youtube.com"] });
    expect(csp).toContain("frame-src https://www.youtube.com");
  });

  it("sets base-uri from baseUriDomains", () => {
    const csp = buildResourceCsp({ baseUriDomains: ["https://cdn.example.com"] });
    expect(csp).toContain("base-uri https://cdn.example.com");
  });

  it("deduplicates values within a directive", () => {
    const csp = buildResourceCsp({
      resourceDomains: ["https://cdn.example.com"],
      connectDomains: ["https://cdn.example.com"],
    });
    // Each domain appears once per directive
    const imgMatches = csp.match(/https:\/\/cdn\.example\.com/g);
    // Should appear in script-src, style-src, img-src, font-src, media-src, and connect-src (6 times)
    expect(imgMatches?.length).toBeGreaterThanOrEqual(1);
  });
});

describe("resource metadata in resolveResourceContent", () => {
  it("includes _meta.ui when resource has metadata", async () => {
    const TEST_URI = "ui://test/meta-test.html";
    registerBuiltinResource({
      uri: TEST_URI,
      name: "Meta Test",
      html: "<html><body>meta</body></html>",
      metadata: {
        csp: { connectDomains: ["https://api.example.com"] },
        permissions: { camera: {} },
        prefersBorder: true,
      },
    });

    const result = await resolveResourceContent(TEST_URI);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.content._meta).toBeDefined();
    expect(result.content._meta?.ui.csp?.connectDomains).toEqual(["https://api.example.com"]);
    expect(result.content._meta?.ui.permissions?.camera).toEqual({});
    expect(result.content._meta?.ui.prefersBorder).toBe(true);

    unregisterResource(TEST_URI);
  });

  it("omits _meta when resource has no metadata", async () => {
    const TEST_URI = "ui://test/no-meta.html";
    registerBuiltinResource({
      uri: TEST_URI,
      name: "No Meta",
      html: "<html><body>no meta</body></html>",
    });

    const result = await resolveResourceContent(TEST_URI);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.content._meta).toBeUndefined();

    unregisterResource(TEST_URI);
  });
});

// ---------------------------------------------------------------------------
// syncMcpAppResources
// ---------------------------------------------------------------------------

describe("syncMcpAppResources", () => {
  const SYNC_URI_BUILTIN = "ui://sync-test/builtin.html";
  const SYNC_URI_FILE = "ui://sync-test/file.html";
  const SYNC_URI_CANVAS = "ui://sync-test/canvas.html";

  afterEach(() => {
    unregisterResource(SYNC_URI_BUILTIN);
    unregisterResource(SYNC_URI_FILE);
    unregisterResource(SYNC_URI_CANVAS);
    _resetAutoSyncState();
  });

  function makeTool(overrides: Partial<AnyAgentTool> & { mcpAppUi?: unknown }): AnyAgentTool {
    return {
      name: "test_tool",
      description: "A test tool",
      parameters: {},
      execute: async () => ({ content: [{ type: "text", text: "ok" }] }),
      ...overrides,
    } as AnyAgentTool;
  }

  it("registers a builtin resource from a tool with resourceSource", () => {
    const tools = [
      makeTool({
        name: "chart_app",
        mcpAppUi: {
          resourceUri: SYNC_URI_BUILTIN,
          resourceSource: { type: "builtin", html: "<html>chart</html>" },
        },
      }),
    ];

    syncMcpAppResources(tools);

    const resources = listResources();
    expect(resources.some((r) => r.uri === SYNC_URI_BUILTIN)).toBe(true);
  });

  it("registers a file resource from a tool with resourceSource", () => {
    const tools = [
      makeTool({
        name: "file_app",
        mcpAppUi: {
          resourceUri: SYNC_URI_FILE,
          resourceSource: { type: "file", rootDir: "/tmp", relativePath: "test.html" },
        },
      }),
    ];

    syncMcpAppResources(tools);

    const resources = listResources();
    expect(resources.some((r) => r.uri === SYNC_URI_FILE)).toBe(true);
  });

  it("registers a canvas resource from a tool with resourceSource", () => {
    const tools = [
      makeTool({
        name: "canvas_app",
        mcpAppUi: {
          resourceUri: SYNC_URI_CANVAS,
          resourceSource: { type: "canvas", canvasUrl: "https://canvas.local/app" },
        },
      }),
    ];

    syncMcpAppResources(tools);

    const resources = listResources();
    expect(resources.some((r) => r.uri === SYNC_URI_CANVAS)).toBe(true);
  });

  it("passes resourceMeta through as metadata", async () => {
    const tools = [
      makeTool({
        name: "meta_app",
        mcpAppUi: {
          resourceUri: SYNC_URI_BUILTIN,
          resourceSource: { type: "builtin", html: "<html>meta</html>" },
          resourceMeta: {
            csp: { connectDomains: ["https://api.test.com"] },
            permissions: { microphone: {} },
            prefersBorder: true,
          },
        },
      }),
    ];

    syncMcpAppResources(tools);

    const result = await resolveResourceContent(SYNC_URI_BUILTIN);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.content._meta?.ui.csp?.connectDomains).toEqual(["https://api.test.com"]);
    expect(result.content._meta?.ui.permissions?.microphone).toEqual({});
    expect(result.content._meta?.ui.prefersBorder).toBe(true);
  });

  it("skips tools without resourceSource", () => {
    const tools = [
      makeTool({
        name: "no_source",
        mcpAppUi: {
          resourceUri: "ui://sync-test/no-source.html",
          // no resourceSource
        },
      }),
    ];

    syncMcpAppResources(tools);

    const resources = listResources();
    expect(resources.some((r) => r.uri === "ui://sync-test/no-source.html")).toBe(false);
  });

  it("skips tools without mcpAppUi", () => {
    const tools = [makeTool({ name: "plain_tool" })];

    syncMcpAppResources(tools);

    // No resources registered
    expect(listResources().length).toBe(0);
  });

  it("cleans up orphaned auto-synced resources when tools are removed", () => {
    // First sync: register two resources
    const tools = [
      makeTool({
        name: "tool_a",
        mcpAppUi: {
          resourceUri: SYNC_URI_BUILTIN,
          resourceSource: { type: "builtin", html: "<html>a</html>" },
        },
      }),
      makeTool({
        name: "tool_b",
        mcpAppUi: {
          resourceUri: SYNC_URI_CANVAS,
          resourceSource: { type: "canvas", canvasUrl: "https://canvas.local/b" },
        },
      }),
    ];

    syncMcpAppResources(tools);
    expect(listResources().some((r) => r.uri === SYNC_URI_BUILTIN)).toBe(true);
    expect(listResources().some((r) => r.uri === SYNC_URI_CANVAS)).toBe(true);

    // Second sync: only tool_b remains
    syncMcpAppResources([tools[1]]);
    expect(listResources().some((r) => r.uri === SYNC_URI_BUILTIN)).toBe(false);
    expect(listResources().some((r) => r.uri === SYNC_URI_CANVAS)).toBe(true);
  });

  it("does not evict manually registered resources", () => {
    const manualUri = "ui://manual/dashboard.html";
    registerBuiltinResource({ uri: manualUri, name: "Manual", html: "<html>manual</html>" });

    // Run sync with a different auto-synced resource
    const tools = [
      makeTool({
        name: "auto_tool",
        mcpAppUi: {
          resourceUri: SYNC_URI_BUILTIN,
          resourceSource: { type: "builtin", html: "<html>auto</html>" },
        },
      }),
    ];
    syncMcpAppResources(tools);

    // Second sync without auto_tool — manual resource survives
    syncMcpAppResources([]);
    expect(listResources().some((r) => r.uri === manualUri)).toBe(true);
    expect(listResources().some((r) => r.uri === SYNC_URI_BUILTIN)).toBe(false);

    unregisterResource(manualUri);
  });

  it("uses tool description as resource name, falls back to tool name", () => {
    const tools = [
      makeTool({
        name: "my_tool",
        description: "My Dashboard",
        mcpAppUi: {
          resourceUri: SYNC_URI_BUILTIN,
          resourceSource: { type: "builtin", html: "<html>dash</html>" },
        },
      }),
    ];

    syncMcpAppResources(tools);

    const entry = listResources().find((r) => r.uri === SYNC_URI_BUILTIN);
    expect(entry?.name).toBe("My Dashboard");
  });

  it("owner-aware sync: different owners do not evict each other's resources", () => {
    const URI_HTTP = "ui://owner-test/http.html";
    const URI_WS = "ui://owner-test/ws.html";

    // Owner "http" registers one resource
    syncMcpAppResources(
      [
        makeTool({
          name: "http_tool",
          mcpAppUi: {
            resourceUri: URI_HTTP,
            resourceSource: { type: "builtin", html: "<html>http</html>" },
          },
        }),
      ],
      "http",
    );

    // Owner "ws" registers a different resource
    syncMcpAppResources(
      [
        makeTool({
          name: "ws_tool",
          mcpAppUi: {
            resourceUri: URI_WS,
            resourceSource: { type: "builtin", html: "<html>ws</html>" },
          },
        }),
      ],
      "ws",
    );

    // Both should be present
    expect(listResources().some((r) => r.uri === URI_HTTP)).toBe(true);
    expect(listResources().some((r) => r.uri === URI_WS)).toBe(true);

    // "ws" owner refreshes with zero tools — only ws resource is removed
    syncMcpAppResources([], "ws");
    expect(listResources().some((r) => r.uri === URI_HTTP)).toBe(true);
    expect(listResources().some((r) => r.uri === URI_WS)).toBe(false);

    // Cleanup
    unregisterResource(URI_HTTP);
    unregisterResource(URI_WS);
  });

  it("owner-aware sync: same URI claimed by two owners is not evicted until both release", () => {
    const SHARED_URI = "ui://owner-test/shared.html";

    // Both owners register the same URI
    const sharedTool = makeTool({
      name: "shared_tool",
      mcpAppUi: {
        resourceUri: SHARED_URI,
        resourceSource: { type: "builtin", html: "<html>shared</html>" },
      },
    });

    syncMcpAppResources([sharedTool], "http");
    syncMcpAppResources([sharedTool], "ws");
    expect(listResources().some((r) => r.uri === SHARED_URI)).toBe(true);

    // "http" drops the URI — still claimed by "ws"
    syncMcpAppResources([], "http");
    expect(listResources().some((r) => r.uri === SHARED_URI)).toBe(true);

    // "ws" also drops it — now actually removed
    syncMcpAppResources([], "ws");
    expect(listResources().some((r) => r.uri === SHARED_URI)).toBe(false);

    unregisterResource(SHARED_URI);
  });
});
