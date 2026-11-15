import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { explainToolAvailability } from "./tool-availability-explanation.js";
import { resolveRunToolSurfaceBlock } from "./tool-availability-session-gates.runtime.js";

const selectAgentHarness = vi.hoisted(() => vi.fn());
vi.mock("./harness/selection.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./harness/selection.js")>();
  selectAgentHarness.mockImplementation(actual.selectAgentHarness);
  return { ...actual, selectAgentHarness };
});

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

// Ordinary allowlist and deny paths are covered through the plugin runtime e2e suites.
describe("explainToolAvailability", () => {
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
      "provider profile",
      { tools: { byProvider: { openai: { profile: "messaging" } } } },
      {
        stage: "provider-policy",
        source: 'tools.byProvider["openai"].profile',
        fix: 'Add tools.byProvider["openai"].alsoAllow: ["web_fetch"].',
      },
    ],
    [
      "wildcard deny over an earlier profile exclusion",
      { tools: { profile: "minimal", deny: ["web_*"] } },
      { stage: "deny", source: "tools.deny" },
    ],
  ] satisfies [string, OpenClawConfig, object][])("names the %s stage", async (_, cfg, block) => {
    expect(await explainOne(cfg)).toMatchObject({ available: false, block });
  });

  it("matches plugin-ID and group:plugins entries only for plugin-owned tools", async () => {
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

  it("applies manifest tool-profile grants like real tool construction", async () => {
    // memory-core declares toolMetadata.intent.profiles: ["coding", "messaging"].
    expect(await explainOne({ tools: { profile: "coding" } }, "intent", "memory-core")).toEqual({
      name: "intent",
      available: true,
    });
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
