import { afterEach, describe, expect, it } from "vitest";
import { createPluginRecord } from "../plugins/loader-records.js";
import { createTestPluginRegistry } from "../plugins/registry-runtime.test-helpers.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../plugins/runtime.js";
import { buildAgentSystemPrompt } from "./system-prompt.js";

function registerGuidedTools(order: readonly string[]) {
  const builder = createTestPluginRegistry();
  for (const id of order) {
    const record = createPluginRecord({
      id,
      source: `/synthetic/${id}.ts`,
      origin: "global",
      enabled: true,
      configSchema: false,
      contracts: { tools: [`${id}_tool`] },
    });
    builder.registry.plugins.push(record);
    builder
      .createApi(record, { config: {} })
      .registerTool(() => null, { name: `${id}_tool`, promptGuidance: `## ${id} guidance` });
  }
  setActivePluginRegistry(builder.registry);
  return builder.registry;
}

afterEach(() => {
  resetPluginRuntimeStateForTest();
});

describe("tool-gated prompt guidance", () => {
  it("shows a plugin tool's guidance only while that tool is callable", () => {
    registerGuidedTools(["alpha"]);
    const prompt = (params: { toolNames?: string[]; capabilityToolNames?: string[] }) =>
      buildAgentSystemPrompt({ workspaceDir: "/isolated/workspace", ...params });

    expect(prompt({ toolNames: ["read", "alpha_tool"] })).toContain("## alpha guidance");
    // Tool Search keeps a deferred tool callable without listing it.
    expect(prompt({ toolNames: ["read"], capabilityToolNames: ["alpha_tool"] })).toContain(
      "## alpha guidance",
    );
    expect(prompt({ toolNames: ["read"] })).not.toContain("## alpha guidance");
  });

  it("orders guidance by owner, not plugin load order", () => {
    const toolNames = ["alpha_tool", "beta_tool"];
    registerGuidedTools(["beta", "alpha"]);
    const reversed = buildAgentSystemPrompt({ workspaceDir: "/w", toolNames });
    registerGuidedTools(["alpha", "beta"]);
    const ordered = buildAgentSystemPrompt({ workspaceDir: "/w", toolNames });

    expect(reversed).toBe(ordered);
    expect(ordered.indexOf("## alpha guidance")).toBeLessThan(ordered.indexOf("## beta guidance"));
  });

  it("keeps the tool but drops its guidance when prompt injection is disabled", () => {
    const builder = createTestPluginRegistry();
    const record = createPluginRecord({
      id: "quiet",
      source: "/synthetic/quiet.ts",
      origin: "global",
      enabled: true,
      configSchema: false,
      contracts: { tools: ["quiet_tool"] },
    });
    builder.registry.plugins.push(record);
    builder
      .createApi(record, { config: {}, hookPolicy: { allowPromptInjection: false } })
      .registerTool(() => null, { name: "quiet_tool", promptGuidance: "## quiet guidance" });
    setActivePluginRegistry(builder.registry);

    expect(builder.registry.tools.map((tool) => tool.names)).toEqual([["quiet_tool"]]);
    expect(buildAgentSystemPrompt({ workspaceDir: "/w", toolNames: ["quiet_tool"] })).not.toContain(
      "## quiet guidance",
    );
    expect(builder.registry.diagnostics).toMatchObject([
      { level: "warn", message: expect.stringContaining("allowPromptInjection=false") },
    ]);
  });

  it("rejects guidance on a registration that does not name its tools", () => {
    const builder = createTestPluginRegistry();
    const record = createPluginRecord({
      id: "unnamed",
      source: "/synthetic/unnamed.ts",
      origin: "global",
      enabled: true,
      configSchema: false,
      contracts: { tools: ["unnamed_tool"] },
    });
    builder.registry.plugins.push(record);
    builder.createApi(record, { config: {} }).registerTool(() => null, {
      promptGuidance: "## never shown",
    });

    expect(builder.registry.tools).toHaveLength(0);
    expect(builder.registry.diagnostics).toMatchObject([
      { level: "error", pluginId: "unnamed", message: expect.stringContaining("promptGuidance") },
    ]);
  });
});
