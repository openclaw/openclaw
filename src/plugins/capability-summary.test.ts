import { expect, it } from "vitest";
import { buildPluginCapabilitySummary } from "./capability-summary.js";

it.each([
  ["bundled", undefined, { effective: true }],
  ["global", undefined, { effective: false }],
  ["bundled", { allowConversationAccess: false }, { effective: false, configured: false }],
] as const)("preserves conversation policy for %s with %j", (origin, hooks, conversationAccess) => {
  const entryConfig = hooks ? { hooks } : undefined;
  const summary = buildPluginCapabilitySummary({ manifest: {}, origin, entryConfig });

  expect(summary.grants.hooks).toEqual({
    allowPromptInjection: { effective: true },
    allowConversationAccess: conversationAccess,
  });
});

it("normalizes manifest surfaces and configured model grants", () => {
  const unsorted = ["zulu", "alpha"];
  const sorted = ["alpha", "zulu"];
  const contracts = {
    tools: ["shared", "zeta-tool"],
  };
  const command = (name: string) => ({ name, description: name, hasSubcommands: false });
  const summary = buildPluginCapabilitySummary({
    manifest: {
      channels: unsorted,
      providers: unsorted,
      contracts,
      toolMetadata: { "alpha-tool": {}, shared: {} },
      hooks: unsorted,
      mcpServers: { zulu: { command: "zulu" }, alpha: { command: "alpha" } },
      cliCommands: unsorted.map(command),
      cliBackends: unsorted,
      skills: unsorted,
      configContracts: {
        dangerousFlags: ["plugins.zulu", "plugins.alpha"].map((path) => ({ path, equals: true })),
      },
    },
    origin: "global",
    entryConfig: {
      llm: {
        allowModelOverride: true,
        allowedModels: ["zulu/model", "alpha/model"],
        allowedCompletionModels: ["zulu/completion", "alpha/completion"],
        allowAuthProfileOverride: false,
        allowAgentIdOverride: true,
      },
      subagent: { allowModelOverride: false, allowedModels: ["zulu/model", "alpha/model"] },
    },
  });

  expect(summary.declared).toEqual({
    channels: sorted,
    providers: sorted,
    tools: ["alpha-tool", "shared", "zeta-tool"],
    contracts: ["tools: shared", "tools: zeta-tool"],
    hooks: sorted,
    mcpServers: sorted,
    cliCommands: sorted,
    cliBackends: sorted,
    skills: sorted,
    dangerousConfigFlags: ["plugins.alpha", "plugins.zulu"],
  });
  expect(summary.grants.llm).toEqual({
    allowModelOverride: true,
    allowedModels: ["alpha/model", "zulu/model"],
    allowedCompletionModels: ["alpha/completion", "zulu/completion"],
    allowAuthProfileOverride: false,
    allowAgentIdOverride: true,
  });
  expect(summary.grants.subagent).toEqual({
    allowModelOverride: false,
    allowedModels: ["alpha/model", "zulu/model"],
  });
});

it("reads channel and provider identities from official catalog manifests", () => {
  const summary = buildPluginCapabilitySummary({
    manifest: {
      channel: { id: "catalog-channel" },
      providers: [{ id: "zulu" }, {}, { id: "alpha" }],
    },
    origin: "official",
  });

  expect(summary.declared.channels).toEqual(["catalog-channel"]);
  expect(summary.declared.providers).toEqual(["alpha", "zulu"]);
});
