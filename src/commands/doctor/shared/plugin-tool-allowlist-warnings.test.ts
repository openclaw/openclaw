import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import * as fixture from "../../../plugins/plugin-metadata.test-support.js";
import { collectPluginToolAllowlistWarnings } from "./plugin-tool-allowlist-warnings.js";

vi.mock("../../../plugins/manifest-contract-eligibility.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../plugins/manifest-contract-eligibility.js")>()),
  loadManifestMetadataSnapshot: () =>
    fixture.createPluginMetadataSnapshotFixture({
      plugins: [{ id: "firecrawl", contracts: { tools: ["firecrawl_search"] } }, { id: "lobster" }],
    }),
}));

const outlook = { command: "node", args: ["outlook-server.js"] };
const sandboxTools = { alsoAllow: ["web_fetch"] };
type Agent = NonNullable<NonNullable<OpenClawConfig["agents"]>["entries"]>[string];
const sandboxAgent: Agent = {
  sandbox: { mode: "all" },
  tools: { sandbox: { tools: sandboxTools } },
};
function worker(overrides: Agent = {}): OpenClawConfig["agents"] {
  return { entries: { worker: { ...sandboxAgent, ...overrides } } };
}
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
  it.each<[string, OpenClawConfig]>([
    ['tools.allow contains "*"', { tools: { allow: ["*"] } }],
    [
      'tool "firecrawl_search", owned by plugin "firecrawl"',
      { tools: { allow: ["firecrawl_search"] } },
    ],
    [
      'agents.entries.agent-a.tools.alsoAllow references plugin "lobster"',
      { agents: { entries: { "agent-a": { tools: { alsoAllow: ["lobster"] } } } } },
    ],
  ])("warns about excluded plugin policy: %s", (warning, cfg) => {
    expect(
      collectPluginToolAllowlistWarnings({
        cfg: { plugins: { allow: ["telegram"] }, ...cfg },
      }),
    ).toEqual([expect.stringContaining(warning)]);
  });

  it.each<[string | null, OpenClawConfig]>([
    [
      '2 MCP servers ("gmail", "outlook"), but tools.sandbox.tools.alsoAllow does not include',
      {
        mcp: { servers: { gmail: { command: "node", args: ["gmail-server.js"] }, outlook } },
        tools: { sandbox: { tools: { alsoAllow: ["outlook__*"] } } },
      },
    ],
    [
      null,
      {
        mcp: { servers: { supabase: { url: "http://localhost:54321/mcp", enabled: false } } },
        tools: { sandbox: { tools: { alsoAllow: ["web_search"] } } },
      },
    ],
    ['1 MCP server ("outlook"), but tools.sandbox.tools.alsoAllow (unset) does not include', {}],
    [null, { agents: worker({ tools: { profile: "minimal", sandbox: { tools: sandboxTools } } }) }],
    [
      '1 MCP server ("outlook"), but tools.sandbox.tools.alsoAllow does not include',
      {
        tools: {
          byProvider: { openai: { allow: ["bundle-mcp"] } },
          sandbox: { tools: sandboxTools },
        },
      },
    ],
    [
      "agents.entries.worker.tools.sandbox.tools.alsoAllow, tools.sandbox.tools.alsoAllow do not include",
      {
        agents: { defaults: { sandbox: { mode: "all" } }, ...worker() },
        tools: { sandbox: { tools: { alsoAllow: ["web_search"] } } },
      },
    ],
  ])("checks sandbox MCP policy %# (%s)", (warning, cfg) => {
    expect(mcpWarnings(cfg)).toEqual(warning === null ? [] : [expect.stringContaining(warning)]);
  });

  it.each(["google/gemini-2.5-pro", "openai/gpt-4.1"])(
    "uses the agent alias target %s for MCP policy warnings",
    (target) => {
      const warnings = mcpWarnings({
        agents: worker({ model: "fast", models: { [target]: { alias: "fast" } } }),
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
