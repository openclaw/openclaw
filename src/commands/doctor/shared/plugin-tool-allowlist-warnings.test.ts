import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import * as fixture from "../../../plugins/plugin-metadata.test-support.js";
import { collectPluginToolAllowlistWarnings } from "./plugin-tool-allowlist-warnings.js";

vi.mock("../../../plugins/manifest-contract-eligibility.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../plugins/manifest-contract-eligibility.js")>()),
  loadManifestMetadataSnapshot: () =>
    fixture.createPluginMetadataSnapshotFixture({
      plugins: [
        { id: "firecrawl", contracts: { tools: ["firecrawl_search", "firecrawl_scrape"] } },
        { id: "lobster" },
      ],
    }),
}));

const outlook = { command: "node", args: ["outlook-server.js"] };
const sandboxTools = { alsoAllow: ["web_fetch"] };

function mcpWarnings(cfg: OpenClawConfig) {
  return collectPluginToolAllowlistWarnings({
    cfg: {
      agents: { defaults: { sandbox: { mode: "all" } } },
      mcp: { servers: { outlook } },
      ...cfg,
    },
  });
}

describe("collectPluginToolAllowlistWarnings", () => {
  it.each<{ name: string; cfg: OpenClawConfig; warning: string }>([
    {
      name: "wildcard",
      cfg: { tools: { allow: ["*"] } },
      warning:
        '- plugins.allow is an exclusive plugin allowlist. tools.allow contains "*", but that wildcard only matches tools from plugins that are loaded; plugin tools outside plugins.allow stay unavailable. Add the required plugin ids to plugins.allow or remove plugins.allow.',
    },
    {
      name: "tool owner",
      cfg: { tools: { allow: ["firecrawl_search"] } },
      warning:
        '- tools.allow references tool "firecrawl_search", owned by plugin "firecrawl", but plugins.allow does not include the owning plugin. Add "firecrawl" to plugins.allow or remove plugins.allow.',
    },
    {
      name: "agent plugin policy",
      cfg: { agents: { entries: { "agent-a": { tools: { alsoAllow: ["lobster"] } } } } },
      warning:
        '- agents.entries.agent-a.tools.alsoAllow references plugin "lobster", but plugins.allow does not include it. Add "lobster" to plugins.allow or remove plugins.allow.',
    },
  ])("warns about $name outside plugins.allow", ({ cfg, warning }) => {
    expect(
      collectPluginToolAllowlistWarnings({ cfg: { plugins: { allow: ["telegram"] }, ...cfg } }),
    ).toEqual([warning]);
  });

  it.each<{ name: string; cfg: OpenClawConfig; expected: string[] }>([
    {
      name: "only one configured MCP server allowed",
      cfg: {
        mcp: { servers: { gmail: { command: "node", args: ["gmail-server.js"] }, outlook } },
        tools: { sandbox: { tools: { alsoAllow: ["outlook__*"] } } },
      },
      expected: [
        '- mcp.servers defines 2 MCP servers ("gmail", "outlook"), but tools.sandbox.tools.alsoAllow does not include "bundle-mcp", "group:plugins", or a matching server-prefixed MCP tool name/glob such as "<server>__*". Sandboxed agents will filter bundled MCP tools before provider requests. Add "bundle-mcp" to tools.sandbox.tools.alsoAllow (or use "group:plugins" / server globs) if those MCP tools should be visible; use tools.sandbox.tools.allow: [] only when you intentionally want no sandbox allow gate.',
      ],
    },
    {
      name: "all configured MCP servers disabled",
      cfg: {
        mcp: { servers: { supabase: { url: "http://localhost:54321/mcp", enabled: false } } },
        tools: { sandbox: { tools: { alsoAllow: ["web_search"] } } },
      },
      expected: [],
    },
    {
      name: "unset sandbox allowlist",
      cfg: {},
      expected: [
        '- mcp.servers defines 1 MCP server ("outlook"), but tools.sandbox.tools.alsoAllow (unset) does not include "bundle-mcp", "group:plugins", or a matching server-prefixed MCP tool name/glob such as "<server>__*". Sandboxed agents will filter bundled MCP tools before provider requests. Add "bundle-mcp" to tools.sandbox.tools.alsoAllow (or use "group:plugins" / server globs) if those MCP tools should be visible; use tools.sandbox.tools.allow: [] only when you intentionally want no sandbox allow gate.',
      ],
    },
    {
      name: "agent profile already blocking MCP",
      cfg: {
        agents: {
          entries: {
            worker: {
              sandbox: { mode: "all" },
              tools: { profile: "minimal", sandbox: { tools: sandboxTools } },
            },
          },
        },
      },
      expected: [],
    },
    {
      name: "provider allowing MCP but sandbox hiding it",
      cfg: {
        tools: {
          byProvider: { openai: { allow: ["bundle-mcp"] } },
          sandbox: { tools: sandboxTools },
        },
      },
      expected: [
        '- mcp.servers defines 1 MCP server ("outlook"), but tools.sandbox.tools.alsoAllow does not include "bundle-mcp", "group:plugins", or a matching server-prefixed MCP tool name/glob such as "<server>__*". Sandboxed agents will filter bundled MCP tools before provider requests. Add "bundle-mcp" to tools.sandbox.tools.alsoAllow (or use "group:plugins" / server globs) if those MCP tools should be visible; use tools.sandbox.tools.allow: [] only when you intentionally want no sandbox allow gate.',
      ],
    },
    {
      name: "multiple sandbox allow sources",
      cfg: {
        agents: {
          defaults: { sandbox: { mode: "all" } },
          entries: { worker: { tools: { sandbox: { tools: sandboxTools } } } },
        },
        tools: { sandbox: { tools: { alsoAllow: ["web_search"] } } },
      },
      expected: [
        '- mcp.servers defines 1 MCP server ("outlook"), but agents.entries.worker.tools.sandbox.tools.alsoAllow, tools.sandbox.tools.alsoAllow do not include "bundle-mcp", "group:plugins", or a matching server-prefixed MCP tool name/glob such as "<server>__*". Sandboxed agents will filter bundled MCP tools before provider requests. Add "bundle-mcp" to tools.sandbox.tools.alsoAllow (or use "group:plugins" / server globs) if those MCP tools should be visible; use tools.sandbox.tools.allow: [] only when you intentionally want no sandbox allow gate.',
      ],
    },
  ])("handles $name", ({ cfg, expected }) => {
    expect(mcpWarnings(cfg)).toStrictEqual(expected);
  });

  it.each(["google/gemini-2.5-pro", "openai/gpt-4.1"])(
    "uses the agent alias target %s for MCP policy warnings",
    (target) => {
      const warnings = mcpWarnings({
        agents: {
          entries: {
            worker: {
              model: "fast",
              models: { [target]: { alias: "fast" } },
              sandbox: { mode: "all" },
              tools: { sandbox: { tools: sandboxTools } },
            },
          },
        },
        tools: { byProvider: { google: { profile: "minimal" } } },
      });
      expect(warnings).toEqual(
        target.startsWith("google/")
          ? []
          : [expect.stringContaining("agents.entries.worker.tools.sandbox.tools.alsoAllow")],
      );
    },
  );
});
