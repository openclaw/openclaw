import type { PluginMetadataSnapshot } from "../../plugins/plugin-metadata-snapshot.types.js";

/** Synthetic plugin metadata shared by model-list protocol tests. */
export async function createModelPluginMetadataSnapshot() {
  const { buildPluginMetadataProviderFacts } =
    await import("../../plugins/plugin-metadata-provider-facts.js");
  const { makeEmptyPluginMetadataOwners } =
    await import("../../plugins/current-plugin-metadata.test-support.js");
  const { buildDeclaredProviderOwnerIndex } = await import("../../plugins/provider-owner-index.js");
  const { createPluginManifestRecordFixture, createPluginMetadataSnapshotFixture } =
    await import("../../plugins/plugin-metadata.test-support.js");
  const bundled = (id: string) => ({
    ...createPluginManifestRecordFixture({ id, rootDir: `/test/${id}` }),
    providers: [id],
    syntheticAuthRefs: [],
  });
  const choice = (provider: string, method: string, choiceId: string) => ({
    provider,
    method,
    choiceId,
  });
  const plugins: PluginMetadataSnapshot["manifestRegistry"]["plugins"] = [
    {
      ...bundled("anthropic"),
      cliBackends: ["claude-cli"],
      syntheticAuthRefs: ["claude-cli"],
      providerAuthChoices: [
        {
          ...choice("anthropic", "cli", "anthropic-cli"),
          deprecatedChoiceIds: ["claude-cli"],
        },
        choice("anthropic", "setup-token", "setup-token"),
        choice("anthropic", "api-key", "apiKey"),
      ],
      modelSupport: { modelPrefixes: ["claude-"] },
      enabledByDefault: true,
    },
    {
      ...bundled("byteplus"),
      providers: ["byteplus", "byteplus-plan"],
      providerAuthAliases: { "byteplus-plan": "byteplus" },
      providerAuthChoices: [choice("byteplus", "api-key", "byteplus-api-key")],
    },
    {
      ...bundled("github-copilot"),
      providerAuthChoices: [
        choice("github-copilot", "device", "github-copilot"),
        choice("github-copilot", "device-enterprise", "github-copilot-enterprise"),
      ],
    },
  ];
  const empty = createPluginMetadataSnapshotFixture();
  const index = {
    ...empty.index,
    policyHash: "models-test-plugin-policy",
    // A real isolated bundled snapshot has no installed-index rows; bundled
    // manifest records remain the authoritative graph for this fixture.
  };
  return {
    ...empty,
    policyHash: "models-test-plugin-policy",
    index,
    registryIndex: index,
    manifestRegistry: { plugins, diagnostics: [] },
    plugins,
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
      ...empty.metrics,
      manifestPluginCount: plugins.length,
    },
  };
}
