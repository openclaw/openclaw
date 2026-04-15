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
});

