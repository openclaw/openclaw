import type { PluginMetadataSnapshot } from "../../plugins/plugin-metadata-snapshot.types.js";

/** Synthetic plugin metadata shared by model-list protocol tests. */
export async function createModelPluginMetadataSnapshot() {
  const { buildPluginMetadataProviderFacts } =
    await import("../../plugins/plugin-metadata-provider-facts.js");
  const { makeEmptyPluginMetadataOwners } =
    await import("../../plugins/current-plugin-metadata.test-support.js");
  const { buildDeclaredProviderOwnerIndex } = await import("../../plugins/provider-owner-index.js");
  const plugins: PluginMetadataSnapshot["manifestRegistry"]["plugins"] = [
    {
      id: "anthropic",
      channels: [],
      providers: ["anthropic"],
      cliBackends: ["claude-cli"],
      syntheticAuthRefs: ["claude-cli"],
      providerAuthChoices: [
        {
          provider: "anthropic",
          method: "cli",
          choiceId: "anthropic-cli",
          deprecatedChoiceIds: ["claude-cli"],
        },
        { provider: "anthropic", method: "setup-token", choiceId: "setup-token" },
        { provider: "anthropic", method: "api-key", choiceId: "apiKey" },
      ],
      modelSupport: { modelPrefixes: ["claude-"] },
      skills: [],
      hooks: [],
      origin: "bundled",
      enabledByDefault: true,
      rootDir: "/test/anthropic",
      source: "/test/anthropic/index.js",
      manifestPath: "/test/anthropic/openclaw.plugin.json",
    },
    {
      id: "byteplus",
      channels: [],
      providers: ["byteplus", "byteplus-plan"],
      syntheticAuthRefs: [],
      providerAuthAliases: { "byteplus-plan": "byteplus" },
      providerAuthChoices: [
        { provider: "byteplus", method: "api-key", choiceId: "byteplus-api-key" },
      ],
      cliBackends: [],
      skills: [],
      hooks: [],
      origin: "bundled",
      rootDir: "/test/byteplus",
      source: "/test/byteplus/index.js",
      manifestPath: "/test/byteplus/openclaw.plugin.json",
    },
    {
      id: "github-copilot",
      channels: [],
      providers: ["github-copilot"],
      syntheticAuthRefs: [],
      providerAuthChoices: [
        { provider: "github-copilot", method: "device", choiceId: "github-copilot" },
        {
          provider: "github-copilot",
          method: "device-enterprise",
          choiceId: "github-copilot-enterprise",
        },
      ],
      cliBackends: [],
      skills: [],
      hooks: [],
      origin: "bundled",
      rootDir: "/test/github-copilot",
      source: "/test/github-copilot/index.js",
      manifestPath: "/test/github-copilot/openclaw.plugin.json",
    },
  ];
  const index: PluginMetadataSnapshot["index"] = {
    version: 1,
    hostContractVersion: "test",
    compatRegistryVersion: "test",
    migrationVersion: 1,
    policyHash: "models-test-plugin-policy",
    generatedAtMs: 0,
    installRecords: {},
    // A real isolated bundled snapshot has no installed-index rows; bundled
    // manifest records remain the authoritative graph for this fixture.
    plugins: [],
    diagnostics: [],
  };
  return {
    policyHash: "models-test-plugin-policy",
    index,
    registryIndex: index,
    registryDiagnostics: [],
    manifestRegistry: { plugins, diagnostics: [] },
    plugins,
    diagnostics: [],
    byPluginId: new Map(plugins.map((plugin) => [plugin.id, plugin])),
    normalizePluginId: (pluginId: string) => pluginId,
    declaredProviderOwners: buildDeclaredProviderOwnerIndex(plugins),
    owners: {
      ...makeEmptyPluginMetadataOwners(),
      providerAuthContributions:
        buildPluginMetadataProviderFacts(plugins).providerAuthContributions,
      providers: new Map([
        ["anthropic", ["anthropic"]],
        ["byteplus", ["byteplus"]],
        ["byteplus-plan", ["byteplus"]],
        ["github-copilot", ["github-copilot"]],
      ]),
      cliBackends: new Map([["claude-cli", ["anthropic"]]]),
    },
    metrics: {
      registrySnapshotMs: 0,
      manifestRegistryMs: 0,
      ownerMapsMs: 0,
      totalMs: 0,
      indexPluginCount: 0,
      manifestPluginCount: plugins.length,
    },
  };
}
