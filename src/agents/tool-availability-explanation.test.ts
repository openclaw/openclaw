import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { explainToolAvailability } from "./tool-availability-explanation.js";
import { resolveRunToolSurfaceBlock } from "./tool-availability-session-gates.runtime.js";

const selectAgentHarness = vi.hoisted(() => vi.fn(() => ({ id: "openclaw" })));
vi.mock("./harness/selection.js", () => ({ selectAgentHarness }));

const withModel = (config: OpenClawConfig): OpenClawConfig => ({
  ...config,
  agents: {
    entries: { main: {} },
    ...config.agents,
    defaults: { model: { primary: "openai/gpt-5.5" }, ...config.agents?.defaults },
  },
});

async function explainOne(config: OpenClawConfig, toolName = "web_fetch", pluginId?: string) {
  const report = await explainToolAvailability({
    config: withModel(config),
    agentId: "main",
    toolNames: [toolName],
    ...(pluginId ? { pluginId } : {}),
  });
  return report.tools[0];
}

describe("explainToolAvailability", () => {
  it("reports an allowed tool as available", async () => {
    expect(await explainOne({ tools: { profile: "coding" } }, "read")).toEqual({
      name: "read",
      available: true,
    });
  });

  it.each([
    [
      "profile",
      { agents: { entries: { main: { tools: { profile: "messaging" } } } } },
      {
        stage: "profile",
        source: "agents.entries.main.tools.profile",
        fix: 'Add agents.entries.main.tools.alsoAllow: ["web_fetch"].',
      },
    ],
    [
      "allowlist",
      { tools: { allow: ["read"] } },
      { stage: "allowlist", source: "tools.allow", fix: 'Add "web_fetch" to tools.allow.' },
    ],
    [
      "provider profile",
      { tools: { byProvider: { openai: { profile: "messaging" } } } },
      {
        stage: "provider-policy",
        source: 'tools.byProvider["openai"].profile',
        fix: 'Add tools.byProvider["openai"].alsoAllow: ["web_fetch"].',
      },
    ],
    [
      "provider allowlist",
      { tools: { byProvider: { openai: { allow: ["read"] } } } },
      { stage: "provider-policy", source: 'tools.byProvider["openai"].allow' },
    ],
    [
      "deny over an earlier profile exclusion",
      { tools: { profile: "minimal", deny: ["web_*"] } },
      { stage: "deny", source: "tools.deny" },
    ],
  ] satisfies [string, OpenClawConfig, object][])("names the %s stage", async (_, cfg, block) => {
    const tool = await explainOne(cfg);
    expect(tool).toMatchObject({ available: false, block });
  });

  it("matches plugin-ID and group:plugins entries for plugin-owned tools", async () => {
    const allowedByPlugin = { tools: { allow: ["read", "acme-memory"] } };
    expect(await explainOne(allowedByPlugin, "memory_save", "acme-memory")).toMatchObject({
      available: true,
    });
    expect(await explainOne(allowedByPlugin, "memory_save")).toMatchObject({
      available: false,
      block: { stage: "allowlist" },
    });
    expect(
      await explainOne({ tools: { deny: ["group:plugins"] } }, "memory_save", "acme-memory"),
    ).toMatchObject({ available: false, block: { stage: "deny" } });
  });

  it("reports the agent sandbox mode and the path that sets it", async () => {
    const report = await explainToolAvailability({
      config: withModel({ agents: { entries: { main: { sandbox: { mode: "all" } } } } }),
      agentId: "main",
      toolNames: ["read"],
    });
    expect(report.sandbox).toEqual({ mode: "all", source: "agents.entries.main.sandbox.mode" });
  });
});

describe("resolveRunToolSurfaceBlock", () => {
  const run = (config: OpenClawConfig) =>
    resolveRunToolSurfaceBlock({ config, agentId: "main", provider: "openai", model: "gpt-5.5" });

  it("names a harness that does not expose OpenClaw tools", () => {
    selectAgentHarness.mockReturnValueOnce({ id: "acme-harness" });
    expect(run({})).toMatchObject({ stage: "harness" });
  });

  it("names a model without tool support", () => {
    const model = {
      id: "gpt-5.5",
      name: "GPT-5.5",
      reasoning: true,
      input: ["text" as const],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128_000,
      maxTokens: 16_384,
    };
    const config = (supportsTools: boolean): OpenClawConfig => ({
      models: {
        providers: {
          openai: {
            baseUrl: "https://api.openai.com/v1",
            models: [{ ...model, compat: { supportsTools } }],
          },
        },
      },
    });
    expect(run(config(false))).toMatchObject({ stage: "model" });
    expect(run(config(true))).toBeUndefined();
  });
});
