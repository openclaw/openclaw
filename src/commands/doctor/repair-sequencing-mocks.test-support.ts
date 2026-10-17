import { vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";

const unchanged = vi.hoisted(() => (config: OpenClawConfig) => ({ config, changes: [] }));

const mocks = vi.hoisted(() => ({
  applyPluginAutoEnable: vi.fn(),
  materializePluginAutoEnableCandidates: vi.fn(),
  collectChannelDoctorCompatibilityMutations: vi.fn(),
  collectOpenAICodexAuthProfileStoreIdMap: vi.fn(),
  ensureAuthProfileStore: vi.fn(),
  evaluateStoredCredentialEligibility: vi.fn(),
  isInstalledPluginEnabled: vi.fn(),
  loadInstalledPluginIndex: vi.fn(),
  loadPluginMetadataSnapshot: vi.fn(),
  maybeRepairGroupAllowFromFallback: vi.fn(),
  maybeRepairPluginOpenClawHostLinks: vi.fn(),
  migrateLegacyTailscaleProfileIdentities: vi.fn(),
  repairMergedGatewayOwnerProfile: vi.fn(),
  maybeMigrateAuthProfileJsonStoresToSqlite: vi.fn(),
  maybeRepairOpenAICodexAuthConfig: vi.fn(),
  maybeRepairOpenPolicyAllowFrom: vi.fn(),
  maybeRepairStaleManagedNpmBundledPlugins: vi.fn(),
  maybeRepairStaleConfiguredAuthOrders: vi.fn(),
  maybeRepairStalePluginConfig: vi.fn(),
  repairStaleOAuthProfileShadows: vi.fn(),
  repairMissingConfiguredPluginInstalls: vi.fn(),
  repairStaleAgentModelRefs: vi.fn(),
  resolveConfigWidePluginManifestRegistry: vi.fn(),
  resolveConfigWidePluginMetadataSnapshot: vi.fn(),
  resolveAuthProfileOrder: vi.fn(),
  resolveProviderInstallCatalogEntries: vi.fn(),
  resolveProfileUnusableUntilForDisplay: vi.fn(),
}));
vi.mock("../../config/plugin-auto-enable.js", () => ({
  applyPluginAutoEnable: mocks.applyPluginAutoEnable,
  materializePluginAutoEnableCandidates: mocks.materializePluginAutoEnableCandidates,
}));
vi.mock("../../config/io.plugin-metadata.js", () => ({
  resolveConfigWidePluginManifestRegistry: mocks.resolveConfigWidePluginManifestRegistry,
  resolveConfigWidePluginMetadataSnapshot: mocks.resolveConfigWidePluginMetadataSnapshot,
}));
vi.mock("../doctor-plugin-host-links.js", () => ({
  maybeRepairPluginOpenClawHostLinks: mocks.maybeRepairPluginOpenClawHostLinks,
}));
vi.mock("../doctor-plugin-registry.js", () => ({
  maybeRepairStaleManagedNpmBundledPlugins: mocks.maybeRepairStaleManagedNpmBundledPlugins,
}));
vi.mock("../../state/user-profiles-tailscale-migration.js", () => ({
  migrateLegacyTailscaleProfileIdentities: mocks.migrateLegacyTailscaleProfileIdentities,
}));
vi.mock("../../state/user-profiles-owner-migration.js", () => ({
  repairMergedGatewayOwnerProfile: mocks.repairMergedGatewayOwnerProfile,
}));
vi.mock("../doctor-auth-flat-profiles.js", () => ({
  maybeRepairLegacyAuthProfileStores: (params: { profileIdMap: Map<string, string> }) => ({
    changes: [],
    warnings: [],
    profileIdMap: params.profileIdMap,
  }),
  collectOpenAICodexAuthProfileStoreIdMap: mocks.collectOpenAICodexAuthProfileStoreIdMap,
  maybeMigrateAuthProfileJsonStoresToSqlite: mocks.maybeMigrateAuthProfileJsonStoresToSqlite,
  maybeRepairOpenAICodexAuthConfig: mocks.maybeRepairOpenAICodexAuthConfig,
}));
vi.mock("./shared/missing-configured-plugin-install.js", () => ({
  repairMissingConfiguredPluginInstalls: mocks.repairMissingConfiguredPluginInstalls,
}));
vi.mock("./shared/stale-agent-model-ref-repair.js", () => ({
  repairStaleAgentModelRefs: mocks.repairStaleAgentModelRefs,
}));
vi.mock("../../agents/auth-profiles.js", () => ({
  ensureAuthProfileStore: mocks.ensureAuthProfileStore,
  resolveAuthProfileOrder: mocks.resolveAuthProfileOrder,
  resolveProfileUnusableUntilForDisplay: mocks.resolveProfileUnusableUntilForDisplay,
}));
vi.mock("../../agents/auth-profiles/credential-state.js", () => ({
  evaluateStoredCredentialEligibility: mocks.evaluateStoredCredentialEligibility,
}));
vi.mock("../../plugins/installed-plugin-index.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../plugins/installed-plugin-index.js")>()),
  isInstalledPluginEnabled: mocks.isInstalledPluginEnabled,
  loadInstalledPluginIndex: mocks.loadInstalledPluginIndex,
}));
vi.mock("../../plugins/plugin-metadata-snapshot.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../plugins/plugin-metadata-snapshot.js")>()),
  loadPluginMetadataSnapshot: mocks.loadPluginMetadataSnapshot,
}));
vi.mock("../../plugins/provider-install-catalog.js", () => ({
  resolveProviderInstallCatalogEntries: mocks.resolveProviderInstallCatalogEntries,
}));
vi.mock("./shared/channel-doctor.js", () => ({
  collectChannelDoctorCompatibilityMutations: mocks.collectChannelDoctorCompatibilityMutations,
  collectChannelDoctorRepairMutations: ({ cfg }: { cfg: OpenClawConfig }) => {
    const allowFrom = cfg.channels?.discord?.allowFrom as unknown[] | undefined;
    if (allowFrom?.[0] === 123) {
      return [
        {
          config: {
            ...cfg,
            channels: {
              ...cfg.channels,
              discord: { ...cfg.channels?.discord, allowFrom: ["123"] },
            },
          },
          changes: ["channels.discord.allowFrom: converted 1 numeric ID to strings"],
        },
      ];
    }
    if (allowFrom?.[0] === 106232522769186816) {
      const warning =
        "channels.discord.allowFrom[0] cannot be auto-repaired because it is not a safe integer";
      return [{ config: cfg, changes: [], warnings: [warning] }];
    }
    return [];
  },
  createChannelDoctorEmptyAllowlistPolicyHooks: () => ({
    extraWarningsForAccount: () => [],
    shouldSkipDefaultEmptyGroupAllowlistWarning: () => false,
  }),
}));
vi.mock("./shared/empty-allowlist-scan.js", () => ({
  scanEmptyAllowlistPolicyWarnings: (cfg: OpenClawConfig) =>
    cfg.channels?.signal
      ? ["channels.signal.accounts.ops\u001B[31m-team\u001B[0m\r\nnext.dmPolicy warning"]
      : [],
}));
vi.mock("./shared/allowlist-policy-repair.js", () => ({
  maybeRepairAllowlistPolicyAllowFrom: async (cfg: OpenClawConfig) => unchanged(cfg),
}));
vi.mock("./shared/allowfrom-fallback-migration.js", () => ({
  maybeRepairGroupAllowFromFallback: mocks.maybeRepairGroupAllowFromFallback,
}));
vi.mock("./shared/bundled-plugin-load-paths.js", () => ({
  maybeRepairBundledPluginLoadPaths: unchanged,
}));
vi.mock("./shared/open-policy-allowfrom.js", () => ({
  maybeRepairOpenPolicyAllowFrom: mocks.maybeRepairOpenPolicyAllowFrom,
}));
vi.mock("./shared/stale-plugin-config.js", () => ({
  maybeRepairStalePluginConfig: mocks.maybeRepairStalePluginConfig,
}));
vi.mock("./shared/stale-oauth-profile-shadows.js", () => ({
  repairStaleOAuthProfileShadows: mocks.repairStaleOAuthProfileShadows,
}));
vi.mock("./shared/stale-auth-order.js", () => ({
  maybeRepairStaleConfiguredAuthOrders: mocks.maybeRepairStaleConfiguredAuthOrders,
}));
vi.mock("./shared/invalid-plugin-config.js", () => ({ maybeRepairInvalidPluginConfig: unchanged }));
vi.mock("./shared/exec-safe-bins.js", () => ({ maybeRepairExecSafeBinProfiles: unchanged }));

export { mocks };
