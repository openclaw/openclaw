import { describe, expect, it, vi } from "vitest";

const lspRuntimeMock = vi.hoisted(() => ({
  createBundleLspToolRuntime: vi.fn(),
}));

vi.mock("../pi-bundle-lsp-runtime.js", () => ({
  createBundleLspToolRuntime: lspRuntimeMock.createBundleLspToolRuntime,
}));

describe("createLspTool", () => {
  it("dispatches hover action to bundle LSP dynamic tool", async () => {
    const execute = vi.fn(async () => ({
      content: [{ type: "text", text: "hover-ok" }],
      details: { lspServer: "ts", lspMethod: "hover" },
    }));
    lspRuntimeMock.createBundleLspToolRuntime.mockResolvedValueOnce({
      tools: [
        {
          name: "lsp_hover_ts",
          label: "hover",
          description: "hover",
          parameters: { type: "object", properties: {} },
          execute,
        },
      ],
      sessions: [{ serverName: "ts", capabilities: {} }],
      dispose: vi.fn(async () => {}),
    });

    const { createLspTool } = await import("./lsp-tool.js");
    const tool = createLspTool({ workspaceDir: "/tmp/workspace" });
    const result = await tool.execute("tool-1", {
      action: "hover",
      uri: "file:///tmp/a.ts",
      line: 1,
      character: 2,
    });

    expect(execute).toHaveBeenCalledWith("lsp-dispatch", {
      uri: "file:///tmp/a.ts",
      line: 1,
      character: 2,
    });
    expect(result).toMatchObject({
      details: { lspServer: "ts", lspMethod: "hover" },
    });
  });

  it("returns failed status for unsupported action", async () => {
    lspRuntimeMock.createBundleLspToolRuntime.mockResolvedValueOnce({
      tools: [],
      sessions: [],
      dispose: vi.fn(async () => {}),
    });

    const { createLspTool } = await import("./lsp-tool.js");
    const tool = createLspTool({ workspaceDir: "/tmp/workspace" });
    const result = await tool.execute("tool-2", {
      action: "diagnostics",
    });

    expect(result).toMatchObject({
      details: {
        status: "failed",
        action: "diagnostics",
      },
    });
  });

  it("converts path input into file:// uri for dispatch", async () => {
    const execute = vi.fn(async () => ({
      content: [{ type: "text", text: "hover-ok" }],
      details: { lspServer: "ts", lspMethod: "hover" },
    }));
    lspRuntimeMock.createBundleLspToolRuntime.mockResolvedValueOnce({
      tools: [
        {
          name: "lsp_hover_ts",
          label: "hover",
          description: "hover",
          parameters: { type: "object", properties: {} },
          execute,
        },
      ],
      sessions: [{ serverName: "ts", capabilities: {} }],
      dispose: vi.fn(async () => {}),
    });

    const { createLspTool } = await import("./lsp-tool.js");
    const tool = createLspTool({ workspaceDir: "/tmp/workspace" });
    await tool.execute("tool-3", {
      action: "hover",
      path: "src/a.ts",
      line: 1,
      character: 2,
    });

    expect(execute).toHaveBeenCalledWith(
      "lsp-dispatch",
      expect.objectContaining({
        uri: expect.stringMatching(/^file:\/\//),
      }),
    );
  });

  it("dispatches symbols action with query payload", async () => {
    const execute = vi.fn(async () => ({
      content: [{ type: "text", text: "symbols-ok" }],
      details: { lspServer: "ts", lspMethod: "symbols" },
    }));
    lspRuntimeMock.createBundleLspToolRuntime.mockResolvedValueOnce({
      tools: [
        {
          name: "lsp_symbols_ts",
          label: "symbols",
          description: "symbols",
          parameters: { type: "object", properties: {} },
          execute,
        },
      ],
      sessions: [{ serverName: "ts", capabilities: {} }],
      dispose: vi.fn(async () => {}),
    });

    const { createLspTool } = await import("./lsp-tool.js");
    const tool = createLspTool({ workspaceDir: "/tmp/workspace" });
    const result = await tool.execute("tool-4", {
      action: "symbols",
      query: "mySymbol",
    });

    expect(execute).toHaveBeenCalledWith("lsp-dispatch", { query: "mySymbol" });
    expect(result).toMatchObject({
      details: { lspServer: "ts", lspMethod: "symbols" },
    });
  });

  it("dispatches diagnostics action with path-derived uri", async () => {
    const execute = vi.fn(async () => ({
      content: [{ type: "text", text: "diagnostics-ok" }],
      details: { lspServer: "ts", lspMethod: "diagnostics" },
    }));
    lspRuntimeMock.createBundleLspToolRuntime.mockResolvedValueOnce({
      tools: [
        {
          name: "lsp_diagnostics_ts",
          label: "diagnostics",
          description: "diagnostics",
          parameters: { type: "object", properties: {} },
          execute,
        },
      ],
      sessions: [{ serverName: "ts", capabilities: {} }],
      dispose: vi.fn(async () => {}),
    });

    const { createLspTool } = await import("./lsp-tool.js");
    const tool = createLspTool({ workspaceDir: "/tmp/workspace" });
    const result = await tool.execute("tool-5", {
      action: "diagnostics",
      path: "src/a.ts",
    });

    expect(execute).toHaveBeenCalledWith(
      "lsp-dispatch",
      expect.objectContaining({
        uri: expect.stringMatching(/^file:\/\//),
      }),
    );
    expect(result).toMatchObject({
      details: { lspServer: "ts", lspMethod: "diagnostics" },
    });
  });

  it("dispatches completion action with position", async () => {
    const execute = vi.fn(async () => ({
      content: [{ type: "text", text: "completion-ok" }],
      details: { lspServer: "ts", lspMethod: "completion" },
    }));
    lspRuntimeMock.createBundleLspToolRuntime.mockResolvedValueOnce({
      tools: [
        {
          name: "lsp_completion_ts",
          label: "completion",
          description: "completion",
          parameters: { type: "object", properties: {} },
          execute,
        },
      ],
      sessions: [{ serverName: "ts", capabilities: {} }],
      dispose: vi.fn(async () => {}),
    });

    const { createLspTool } = await import("./lsp-tool.js");
    const tool = createLspTool({ workspaceDir: "/tmp/workspace" });
    const result = await tool.execute("tool-6", {
      action: "completion",
      uri: "file:///tmp/a.ts",
      line: 3,
      character: 7,
    });

    expect(execute).toHaveBeenCalledWith("lsp-dispatch", {
      uri: "file:///tmp/a.ts",
      line: 3,
      character: 7,
    });
    expect(result).toMatchObject({
      details: { lspServer: "ts", lspMethod: "completion" },
    });
  });

  it("dispatches format action with uri only", async () => {
    const execute = vi.fn(async () => ({
      content: [{ type: "text", text: "format-ok" }],
      details: { lspServer: "ts", lspMethod: "format" },
    }));
    lspRuntimeMock.createBundleLspToolRuntime.mockResolvedValueOnce({
      tools: [
        {
          name: "lsp_format_ts",
          label: "format",
          description: "format",
          parameters: { type: "object", properties: {} },
          execute,
        },
      ],
      sessions: [{ serverName: "ts", capabilities: {} }],
      dispose: vi.fn(async () => {}),
    });

    const { createLspTool } = await import("./lsp-tool.js");
    const tool = createLspTool({ workspaceDir: "/tmp/workspace" });
    const result = await tool.execute("tool-7", {
      action: "format",
      path: "src/a.ts",
    });

    expect(execute).toHaveBeenCalledWith(
      "lsp-dispatch",
      expect.objectContaining({
        uri: expect.stringMatching(/^file:\/\//),
      }),
    );
    expect(result).toMatchObject({
      details: { lspServer: "ts", lspMethod: "format" },
    });
  });
});
