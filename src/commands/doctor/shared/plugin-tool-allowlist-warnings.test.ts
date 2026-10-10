// Plugin tool allowlist warning tests cover doctor warnings for stale tool allowlists.
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import type { PluginManifestRegistry } from "../../../plugins/manifest-registry.js";
import { collectPluginToolAllowlistWarnings } from "./plugin-tool-allowlist-warnings.js";

const manifestRegistry: PluginManifestRegistry = {
  diagnostics: [],
  plugins: [
    {
      id: "firecrawl",
      channels: [],
      cliBackends: [],
      hooks: [],
      manifestPath: "/virtual/firecrawl/openclaw.plugin.json",
      origin: "bundled",
      providers: [],
      rootDir: "/virtual/firecrawl",
      skills: [],
      source: "/virtual/firecrawl/index.ts",
      contracts: {
        tools: ["firecrawl_search", "firecrawl_scrape"],
      },
    },
    {
      id: "lobster",
      channels: [],
      cliBackends: [],
      hooks: [],
      manifestPath: "/virtual/lobster/openclaw.plugin.json",
      origin: "bundled",
      providers: [],
      rootDir: "/virtual/lobster",
      skills: [],
      source: "/virtual/lobster/index.ts",
    },
  ],
};

function mcpWarnings(cfg: OpenClawConfig) {
  return collectPluginToolAllowlistWarnings({
    cfg: {
      agents: { defaults: { sandbox: { mode: "all" } } },
      mcp: { servers: { outlook: { command: "node", args: ["outlook-server.js"] } } },
      ...cfg,
    },
    manifestRegistry,
  });
}

describe("collectPluginToolAllowlistWarnings", () => {
  it("warns when tools.allow wildcard is paired with restrictive plugins.allow", () => {
    const warnings = collectPluginToolAllowlistWarnings({
      cfg: {
        plugins: { allow: ["telegram"] },
        tools: { allow: ["*"] },
      },
      manifestRegistry,
    });

    expect(warnings).toEqual([
      '- plugins.allow is an exclusive plugin allowlist. tools.allow contains "*", but that wildcard only matches tools from plugins that are loaded; plugin tools outside plugins.allow stay unavailable. Add the required plugin ids to plugins.allow or remove plugins.allow.',
    ]);
  });

  it("warns when an allowlisted tool is owned by a plugin outside plugins.allow", () => {
    const warnings = collectPluginToolAllowlistWarnings({
      cfg: {
        plugins: { allow: ["telegram"] },
        tools: { allow: ["firecrawl_search"] },
      },
      manifestRegistry,
    });

    expect(warnings).toEqual([
      '- tools.allow references tool "firecrawl_search", owned by plugin "firecrawl", but plugins.allow does not include the owning plugin. Add "firecrawl" to plugins.allow or remove plugins.allow.',
    ]);
  });

  it("warns when a tool policy references a known plugin outside plugins.allow", () => {
    const warnings = collectPluginToolAllowlistWarnings({
      cfg: {
        plugins: { allow: ["telegram"] },
        agents: {
          entries: {
            "agent-a": {
              tools: { alsoAllow: ["lobster"] },
            },
          },
        },
      },
      manifestRegistry,
    });

    expect(warnings).toEqual([
      '- agents.entries.agent-a.tools.alsoAllow references plugin "lobster", but plugins.allow does not include it. Add "lobster" to plugins.allow or remove plugins.allow.',
    ]);
  });

  it("warns when sandbox allowlist covers only one configured MCP server", () => {
    const warnings = mcpWarnings({
      mcp: {
        servers: {
          gmail: { command: "node", args: ["gmail-server.js"] },
          outlook: { command: "node", args: ["outlook-server.js"] },
        },
      },
      tools: {
        sandbox: {
          tools: {
            alsoAllow: ["outlook__*"],
          },
        },
      },
    });

    expect(warnings).toEqual([
      '- mcp.servers defines 2 MCP servers ("gmail", "outlook"), but tools.sandbox.tools.alsoAllow does not include "bundle-mcp", "group:plugins", or a matching server-prefixed MCP tool name/glob such as "<server>__*". Sandboxed agents will filter bundled MCP tools before provider requests. Add "bundle-mcp" to tools.sandbox.tools.alsoAllow (or use "group:plugins" / server globs) if those MCP tools should be visible; use tools.sandbox.tools.allow: [] only when you intentionally want no sandbox allow gate.',
    ]);
  });

  it("does not warn when all configured MCP servers are disabled", () => {
    const warnings = mcpWarnings({
      mcp: {
        servers: {
          supabase: {
            url: "http://localhost:54321/mcp",
            enabled: false,
          },
        },
      },
      tools: { sandbox: { tools: { alsoAllow: ["web_search"] } } },
    });

    expect(warnings).toStrictEqual([]);
  });

  it("uses a config-path source label when sandbox allowlist is unset", () => {
    const warnings = mcpWarnings({
      mcp: { servers: { outlook: { command: "node", args: ["outlook-server.js"] } } },
    });

    expect(warnings).toEqual([
      '- mcp.servers defines 1 MCP server ("outlook"), but tools.sandbox.tools.alsoAllow (unset) does not include "bundle-mcp", "group:plugins", or a matching server-prefixed MCP tool name/glob such as "<server>__*". Sandboxed agents will filter bundled MCP tools before provider requests. Add "bundle-mcp" to tools.sandbox.tools.alsoAllow (or use "group:plugins" / server globs) if those MCP tools should be visible; use tools.sandbox.tools.allow: [] only when you intentionally want no sandbox allow gate.',
    ]);
  });

  it("does not warn when the agent profile blocks MCP tools before sandbox policy", () => {
    const warnings = mcpWarnings({
      agents: {
        entries: {
          worker: {
            sandbox: { mode: "all" },
            tools: {
              profile: "minimal",
              sandbox: { tools: { alsoAllow: ["web_fetch"] } },
            },
          },
        },
      },
      mcp: { servers: { outlook: { command: "node", args: ["outlook-server.js"] } } },
    });

    expect(warnings).toStrictEqual([]);
  });

  it("still warns when the active provider allowlist allows MCP tools but sandbox policy hides them", () => {
    const warnings = mcpWarnings({
      tools: {
        byProvider: {
          openai: { allow: ["bundle-mcp"] },
        },
        sandbox: { tools: { alsoAllow: ["web_fetch"] } },
      },
    });

    expect(warnings).toEqual([
      '- mcp.servers defines 1 MCP server ("outlook"), but tools.sandbox.tools.alsoAllow does not include "bundle-mcp", "group:plugins", or a matching server-prefixed MCP tool name/glob such as "<server>__*". Sandboxed agents will filter bundled MCP tools before provider requests. Add "bundle-mcp" to tools.sandbox.tools.alsoAllow (or use "group:plugins" / server globs) if those MCP tools should be visible; use tools.sandbox.tools.allow: [] only when you intentionally want no sandbox allow gate.',
    ]);
  });

  it("uses plural grammar when multiple sandbox allow sources hide MCP servers", () => {
    const warnings = mcpWarnings({
      agents: {
        defaults: { sandbox: { mode: "all" } },
        entries: {
          worker: {
            tools: { sandbox: { tools: { alsoAllow: ["web_fetch"] } } },
          },
        },
      },
      tools: { sandbox: { tools: { alsoAllow: ["web_search"] } } },
    });

    expect(warnings).toEqual([
      '- mcp.servers defines 1 MCP server ("outlook"), but agents.entries.worker.tools.sandbox.tools.alsoAllow, tools.sandbox.tools.alsoAllow do not include "bundle-mcp", "group:plugins", or a matching server-prefixed MCP tool name/glob such as "<server>__*". Sandboxed agents will filter bundled MCP tools before provider requests. Add "bundle-mcp" to tools.sandbox.tools.alsoAllow (or use "group:plugins" / server globs) if those MCP tools should be visible; use tools.sandbox.tools.allow: [] only when you intentionally want no sandbox allow gate.',
    ]);
  });
});
