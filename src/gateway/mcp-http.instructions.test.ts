import { describe, expect, it, vi } from "vitest";
import type { AnyAgentTool } from "../agents/tools/common.js";
import { setPluginToolMeta } from "../plugins/tool-metadata.js";
import { resolveMcpLoopbackInstructions } from "./mcp-http.instructions.js";

const peekSessionMcpRuntime = vi.hoisted(() => vi.fn());
vi.mock("../agents/agent-bundle-mcp-manager-api.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../agents/agent-bundle-mcp-manager-api.js")>()),
  peekSessionMcpRuntime,
}));

function toolWithServer(serverName: string): AnyAgentTool {
  const tool = {
    name: `openclaw__${serverName}__probe`,
    label: serverName,
    description: "probe",
    parameters: { type: "object", properties: {} } as never,
    execute: vi.fn(),
  } as unknown as AnyAgentTool;
  setPluginToolMeta(tool, {
    pluginId: "mcp",
    optional: false,
    mcp: { serverName, safeServerName: serverName, toolName: "probe", operation: "tool" },
  });
  return tool;
}

function runtimeWithCatalog(servers: Record<string, { instructions?: string }>) {
  return {
    peekCatalog: () => ({
      version: 1,
      generatedAt: 0,
      servers: Object.fromEntries(
        Object.entries(servers).map(([serverName, entry]) => [
          serverName,
          { serverName, launchSummary: "", toolCount: 1, ...entry },
        ]),
      ),
      tools: [],
    }),
  };
}

describe("resolveMcpLoopbackInstructions", () => {
  it("aggregates instructions from servers that still serve tools", () => {
    peekSessionMcpRuntime.mockReturnValue(
      runtimeWithCatalog({
        legal: { instructions: "Cite authority levels." },
        search: { instructions: "Prefer recent sources." },
      }),
    );
    const result = resolveMcpLoopbackInstructions({
      sessionKey: "agent:main:main",
      tools: [toolWithServer("legal"), toolWithServer("search")],
    });
    expect(result).toBe("[legal]\nCite authority levels.\n\n[search]\nPrefer recent sources.");
  });

  it("omits servers whose tools are fully filtered out of the served list", () => {
    peekSessionMcpRuntime.mockReturnValue(
      runtimeWithCatalog({
        legal: { instructions: "Cite authority levels." },
        denied: { instructions: "Must not leak." },
      }),
    );
    const result = resolveMcpLoopbackInstructions({
      sessionKey: "agent:main:main",
      tools: [toolWithServer("legal")],
    });
    expect(result).toBe("[legal]\nCite authority levels.");
  });

  it("returns undefined without a warm catalog or any instructions", () => {
    peekSessionMcpRuntime.mockReturnValue(undefined);
    expect(
      resolveMcpLoopbackInstructions({ sessionKey: "agent:main:main", tools: [] }),
    ).toBeUndefined();
    peekSessionMcpRuntime.mockReturnValue(runtimeWithCatalog({ legal: {} }));
    expect(
      resolveMcpLoopbackInstructions({
        sessionKey: "agent:main:main",
        tools: [toolWithServer("legal")],
      }),
    ).toBeUndefined();
  });
});
