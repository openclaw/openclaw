import type { PluginMetadataSnapshot } from "../../plugins/plugin-metadata-snapshot.types.js";

/** Synthetic plugin metadata shared by model-list protocol tests. */
export async function createModelPluginMetadataSnapshot() {
  const { buildPluginMetadataProviderFacts } =
    await import("../../plugins/plugin-metadata-provider-facts.js");
  const { makeEmptyPluginMetadataOwners } =
    await import("../../plugins/current-plugin-metadata.test-support.js");
  const { buildDeclaredProviderOwnerIndex } = await import("../../plugins/provider-owner-index.js");
  const bundled = (id: string) => ({
    id,
    channels: [],
    providers: [id],
    cliBackends: [],
    syntheticAuthRefs: [],
    skills: [],
    hooks: [],
    origin: "bundled" as const,
    rootDir: `/test/${id}`,
    source: `/test/${id}/index.js`,
    manifestPath: `/test/${id}/openclaw.plugin.json`,
  });
  const plugins: PluginMetadataSnapshot["manifestRegistry"]["plugins"] = [
    {
      ...bundled("anthropic"),
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
      enabledByDefault: true,
    },
    {
      ...bundled("byteplus"),
      providers: ["byteplus", "byteplus-plan"],
      providerAuthAliases: { "byteplus-plan": "byteplus" },
      providerAuthChoices: [
        { provider: "byteplus", method: "api-key", choiceId: "byteplus-api-key" },
      ],
    },
    {
      ...bundled("github-copilot"),
      providerAuthChoices: [
        { provider: "github-copilot", method: "device", choiceId: "github-copilot" },
        {
          provider: "github-copilot",
          method: "device-enterprise",
          choiceId: "github-copilot-enterprise",
        },
      ],
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
