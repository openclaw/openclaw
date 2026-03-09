import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { UNKNOWN_MCP_SERVER, isMcpToolNameDeclared, resolveToolServer } from "./config.js";

function buildCfg(mcpServers?: Record<string, { tools: string[] }>): OpenClawConfig {
  return { mcpServers } as OpenClawConfig;
}

describe("MCP tool declaration matching", () => {
  it("matches exact tool names for MCP membership", () => {
    const cfg = buildCfg({
      serverA: { tools: ["web_search", "repo.read"] },
    });
    expect(isMcpToolNameDeclared(cfg, "web_search")).toBe(true);
    expect(isMcpToolNameDeclared(cfg, "unrelated_tool")).toBe(false);
  });

  it("matches prefix declarations as membership (mirrors resolveToolServer)", () => {
    const cfg = buildCfg({
      serverA: { tools: ["mcp."] },
    });
    expect(isMcpToolNameDeclared(cfg, "mcp.search")).toBe(true);
  });

  it("keeps prefix-based server resolution for routing", () => {
    const cfg = buildCfg({
      serverA: { tools: ["mcp."] },
      serverB: { tools: ["mcp.search."] },
    });
    expect(resolveToolServer(cfg, "mcp.search.query")).toBe("serverB");
    expect(resolveToolServer(cfg, "mcp.other")).toBe("serverA");
  });

  it("returns unknown when no server matches", () => {
    const cfg = buildCfg({
      serverA: { tools: ["web_search"] },
    });
    expect(resolveToolServer(cfg, "repo.read")).toBe(UNKNOWN_MCP_SERVER);
  });
});
