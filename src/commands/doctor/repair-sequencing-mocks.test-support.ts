import { vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";

const hoistedMocks = vi.hoisted(() => ({
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
  maybeRepairLegacyOAuthSidecarProfiles: vi.fn(),
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
  applyPluginAutoEnable: hoistedMocks.applyPluginAutoEnable,
  materializePluginAutoEnableCandidates: hoistedMocks.materializePluginAutoEnableCandidates,
}));

vi.mock("../../config/io.plugin-metadata.js", () => ({
  resolveConfigWidePluginManifestRegistry: hoistedMocks.resolveConfigWidePluginManifestRegistry,
  resolveConfigWidePluginMetadataSnapshot: hoistedMocks.resolveConfigWidePluginMetadataSnapshot,
}));

vi.mock("../doctor-plugin-host-links.js", () => ({
  maybeRepairPluginOpenClawHostLinks: hoistedMocks.maybeRepairPluginOpenClawHostLinks,
}));

vi.mock("../doctor-plugin-registry.js", () => ({
  maybeRepairStaleManagedNpmBundledPlugins: hoistedMocks.maybeRepairStaleManagedNpmBundledPlugins,
}));

vi.mock("../doctor-auth-oauth-sidecar.js", () => ({
  maybeRepairLegacyOAuthSidecarProfiles: hoistedMocks.maybeRepairLegacyOAuthSidecarProfiles,
}));

vi.mock("../../state/user-profiles-tailscale-migration.js", () => ({
  migrateLegacyTailscaleProfileIdentities: hoistedMocks.migrateLegacyTailscaleProfileIdentities,
}));

vi.mock("../../state/user-profiles-owner-migration.js", () => ({
  repairMergedGatewayOwnerProfile: hoistedMocks.repairMergedGatewayOwnerProfile,
}));

vi.mock("../doctor-auth-flat-profiles.js", () => ({
  maybeRepairLegacyAuthProfileStores: ({
    profileIdMap,
  }: {
    profileIdMap: Map<string, string>;
  }) => ({
    changes: [],
    warnings: [],
    profileIdMap,
  }),
  collectOpenAICodexAuthProfileStoreIdMap: hoistedMocks.collectOpenAICodexAuthProfileStoreIdMap,
  maybeMigrateAuthProfileJsonStoresToSqlite: hoistedMocks.maybeMigrateAuthProfileJsonStoresToSqlite,
  maybeRepairOpenAICodexAuthConfig: hoistedMocks.maybeRepairOpenAICodexAuthConfig,
}));

vi.mock("./shared/missing-configured-plugin-install.js", () => ({
  repairMissingConfiguredPluginInstalls: hoistedMocks.repairMissingConfiguredPluginInstalls,
}));

vi.mock("./shared/stale-agent-model-ref-repair.js", () => ({
  repairStaleAgentModelRefs: hoistedMocks.repairStaleAgentModelRefs,
}));

vi.mock("../../agents/auth-profiles.js", () => ({
  ensureAuthProfileStore: hoistedMocks.ensureAuthProfileStore,
  resolveAuthProfileOrder: hoistedMocks.resolveAuthProfileOrder,
  resolveProfileUnusableUntilForDisplay: hoistedMocks.resolveProfileUnusableUntilForDisplay,
}));

vi.mock("../../agents/auth-profiles/credential-state.js", () => ({
  evaluateStoredCredentialEligibility: hoistedMocks.evaluateStoredCredentialEligibility,
}));

vi.mock("../../plugins/installed-plugin-index.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../plugins/installed-plugin-index.js")>()),
  isInstalledPluginEnabled: hoistedMocks.isInstalledPluginEnabled,
  loadInstalledPluginIndex: hoistedMocks.loadInstalledPluginIndex,
}));

vi.mock("../../plugins/plugin-metadata-snapshot.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../plugins/plugin-metadata-snapshot.js")>()),
  loadPluginMetadataSnapshot: hoistedMocks.loadPluginMetadataSnapshot,
}));

vi.mock("../../plugins/provider-install-catalog.js", () => ({
  resolveProviderInstallCatalogEntries: hoistedMocks.resolveProviderInstallCatalogEntries,
}));

vi.mock("./shared/channel-doctor.js", () => ({
  collectChannelDoctorCompatibilityMutations:
    hoistedMocks.collectChannelDoctorCompatibilityMutations,
  collectChannelDoctorRepairMutations: ({ cfg }: { cfg: OpenClawConfig }) => {
    const allowFrom = cfg.channels?.discord?.allowFrom as unknown[] | undefined;
    if (allowFrom?.[0] === 123) {
      return [
        {
          config: {
            ...cfg,
            channels: {
              ...cfg.channels,
              discord: {
                ...cfg.channels?.discord,
                allowFrom: ["123"],
              },
            },
          },
          changes: ["channels.discord.allowFrom: converted 1 numeric ID to strings"],
        },
      ];
    }
    if (allowFrom?.[0] === 106232522769186816) {
      return [
        {
          config: cfg,
          changes: [],
          warnings: [
            "channels.discord.allowFrom[0] cannot be auto-repaired because it is not a safe integer",
          ],
        },
      ];
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
  maybeRepairAllowlistPolicyAllowFrom: async (cfg: OpenClawConfig) => ({
    config: cfg,
    changes: [],
  }),
}));

vi.mock("./shared/allowfrom-fallback-migration.js", () => ({
  maybeRepairGroupAllowFromFallback: hoistedMocks.maybeRepairGroupAllowFromFallback,
}));

vi.mock("./shared/bundled-plugin-load-paths.js", () => ({
  maybeRepairBundledPluginLoadPaths: (cfg: OpenClawConfig) => ({
    config: cfg,
    changes: [],
  }),
}));

vi.mock("./shared/open-policy-allowfrom.js", () => ({
  maybeRepairOpenPolicyAllowFrom: hoistedMocks.maybeRepairOpenPolicyAllowFrom,
}));

vi.mock("./shared/stale-plugin-config.js", () => ({
  maybeRepairStalePluginConfig: hoistedMocks.maybeRepairStalePluginConfig,
}));

vi.mock("./shared/stale-oauth-profile-shadows.js", () => ({
  repairStaleOAuthProfileShadows: hoistedMocks.repairStaleOAuthProfileShadows,
}));

vi.mock("./shared/stale-auth-order.js", () => ({
  maybeRepairStaleConfiguredAuthOrders: hoistedMocks.maybeRepairStaleConfiguredAuthOrders,
}));

vi.mock("./shared/invalid-plugin-config.js", () => ({
  maybeRepairInvalidPluginConfig: (cfg: OpenClawConfig) => ({
    config: cfg,
    changes: [],
  }),
}));

vi.mock("./shared/legacy-tools-by-sender.js", () => ({
  maybeRepairLegacyToolsBySenderKeys: (cfg: OpenClawConfig) => {
    const channels = cfg.channels as Record<string, unknown> | undefined;
    const tools = channels?.tools as
      | { exec?: { toolsBySender?: Record<string, unknown> } }
      | undefined;
    const bySender = tools?.exec?.toolsBySender;
    const rawKey = bySender
      ? Object.keys(bySender).find((key) => !key.startsWith("id:"))
      : undefined;
    if (!bySender || !rawKey) {
      return { config: cfg, changes: [] };
    }
    const targetKey = `id:${rawKey.trim()}`;
    return {
      config: {
        ...cfg,
        channels: {
          ...cfg.channels,
          tools: {
            ...(channels?.tools as Record<string, unknown> | undefined),
            exec: {
              ...tools?.exec,
              toolsBySender: {
                [targetKey]: bySender[rawKey],
              },
            },
          },
        },
      },
      changes: [
        `channels.tools.exec.toolsBySender: migrated 1 legacy key to typed id: entries (${rawKey} -> ${targetKey})`,
      ],
    };
  },
}));

vi.mock("./shared/exec-safe-bins.js", () => ({
  maybeRepairExecSafeBinProfiles: (cfg: OpenClawConfig) => ({
    config: cfg,
    changes: [],
  }),
}));

export const mocks = hoistedMocks;
