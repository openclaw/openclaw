import { expect, it } from "vitest";
import type { PluginEntryConfig } from "../config/types.plugins.js";
import { buildPluginCapabilitySummary } from "./capability-summary.js";
import type { PluginManifestContracts } from "./manifest-types.js";
import type { PluginOrigin } from "./plugin-origin.types.js";

const granted = { effective: true };
const denied = { effective: false };
const allowed = { effective: true, configured: true };
const restricted = { effective: false, configured: false };
type Grant = typeof granted & { configured?: boolean };

it.each<[string, PluginOrigin | "official", PluginEntryConfig["hooks"], Grant, Grant]>([
  ["bundled defaults", "bundled", undefined, granted, granted],
  ["external defaults", "global", undefined, granted, denied],
  ["official defaults", "official", undefined, granted, denied],
  [
    "external grants",
    "workspace",
    { allowPromptInjection: false, allowConversationAccess: true },
    restricted,
    allowed,
  ],
  ["bundled restrictions", "bundled", { allowConversationAccess: false }, granted, restricted],
])(
  "preserves fail-closed policy for %s",
  (_label, origin, hooks, promptInjection, conversationAccess) => {
    const entryConfig = hooks ? { hooks } : undefined;
    const summary = buildPluginCapabilitySummary({ manifest: {}, origin, entryConfig });

    expect(summary.grants.hooks).toEqual({
      allowPromptInjection: promptInjection,
      allowConversationAccess: conversationAccess,
    });
  },
);

it("normalizes every manifest contract family, surface and configured model grant", () => {
  const contracts = {
    codeModeExecutors: ["quickjs"],
    agentToolResultMiddleware: ["middleware"],
    trustedToolPolicies: ["trusted-policy"],
    externalAuthProviders: ["external-auth"],
    embeddingProviders: ["embedding"],
    speechProviders: ["speech"],
    realtimeTranscriptionProviders: ["transcription"],
    realtimeVoiceProviders: ["voice"],
    mediaUnderstandingProviders: ["media"],
    transcriptSourceProviders: ["transcript"],
    documentExtractors: ["document"],
    imageGenerationProviders: ["image"],
    videoGenerationProviders: ["video"],
    musicGenerationProviders: ["music"],
    webContentExtractors: ["web-content"],
    webFetchProviders: ["web-fetch"],
    webSearchProviders: ["web-search"],
    workerProviders: ["worker"],
    workerProfileSuggestions: ["worker"],
    storageProviders: ["storage"],
    decisionProviders: ["decision"],
    usageProviders: ["usage"],
    migrationProviders: ["migration"],
    gatewayMethodDispatch: ["gateway-method"],
    tools: ["shared", "zeta-tool"],
  } satisfies Required<PluginManifestContracts>;
  const command = (name: string) => ({ name, description: name, hasSubcommands: false });
  const summary = buildPluginCapabilitySummary({
    manifest: {
      channels: ["zeta", "alpha"],
      providers: ["zulu", "beta"],
      contracts,
      toolMetadata: { "alpha-tool": {}, shared: {} },
      hooks: ["zeta-hook", "alpha-hook"],
      mcpServers: { zulu: { command: "zulu" }, alpha: { command: "alpha" } },
      cliCommands: ["zulu", "alpha"].map(command),
      cliBackends: ["zulu", "alpha"],
      skills: ["zulu", "alpha"],
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
    channels: ["alpha", "zeta"],
    providers: ["beta", "zulu"],
    tools: ["alpha-tool", "shared", "zeta-tool"],
    contracts: Object.entries(contracts)
      .flatMap(([family, ids]) => ids.map((id) => `${family}: ${id}`))
      .toSorted(),
    hooks: ["alpha-hook", "zeta-hook"],
    mcpServers: ["alpha", "zulu"],
    cliCommands: ["alpha", "zulu"],
    cliBackends: ["alpha", "zulu"],
    skills: ["alpha", "zulu"],
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
