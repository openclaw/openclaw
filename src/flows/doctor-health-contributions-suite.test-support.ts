// Shared mocks and lifecycle for the focused doctor-health-contributions suites.
import { afterEach, beforeEach, vi } from "vitest";
import { createDoctorConfigSnapshot } from "../commands/doctor-config-snapshot.test-helpers.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveDoctorContributionHealthChecks } from "./doctor-health-contributions.js";
import {
  createDoctorHealthFlowContext,
  createDoctorLintContext,
  createDoctorPrompterFixture,
  resolveDoctorHealthContributions,
} from "./doctor-health-contributions.test-support.js";
import { clearHealthChecksForTest, registerHealthCheck } from "./health-check-registry.js";
import type { HealthCheck, HealthFinding } from "./health-checks.js";

const mocks = vi.hoisted(() => ({
  isDefaultInstallIdentity: vi.fn(() => true),
  isContainerEnvironment: vi.fn(() => false),
  maybeRunConfiguredPluginInstallReleaseStep: vi.fn(),
  registerBundledHealthChecks: vi.fn((): HealthFinding[] => []),
  runDoctorHealthRepairs: vi.fn(),
  maybeMigrateAuthProfileJsonStoresToSqlite: vi.fn().mockResolvedValue({
    detected: [],
    changes: [],
    migratedProfileIds: new Set<string>(),
    blockedProfileIds: new Set<string>(),
    warnings: [],
  }),
  collectOpenAICodexAuthProfileStoreIdMap: vi.fn(() => new Map<string, string>()),
  maybeRepairOpenAICodexAuthConfig: vi.fn((cfg: unknown) => ({
    config: cfg,
    changes: [],
    warnings: [],
  })),
  maybeMigrateLegacyPluginModelCatalogs: vi.fn().mockResolvedValue({
    detected: 0,
    migrated: 0,
    warnings: [],
  }),
  maybeMigrateModelCatalogCredentials: vi.fn(async () => ({
    detected: 0,
    migrated: 0,
    warnings: [],
  })),
  maybeRepairGatewayDaemon: vi.fn().mockResolvedValue(undefined),
  maybeRepairLegacyOAuthProfileIds: vi.fn(async (cfg: unknown) => ({
    config: cfg,
    retiredProfileCleanupPlans: [] as Array<{
      agentDir?: string;
      profileIds: readonly string[];
    }>,
  })),
  removeAuthProfilesAcrossOwnerStores: vi.fn(async () => true),
  collectAuthProfileHealthFindings: vi.fn(async () => []),
  noteAuthProfileHealth: vi.fn().mockResolvedValue(undefined),
  noteCopilotAmbientToken: vi.fn(),
  noteLegacyCodexProviderOverride: vi.fn(),
  noteSharedAuthStoreStatus: vi.fn(),
  noteMemorySearchHealth: vi.fn().mockResolvedValue(undefined),
  collectMemorySearchHealthFindings: vi
    .fn<() => Promise<readonly HealthFinding[]>>()
    .mockResolvedValue([]),
  noteWebFetchProxyDiagnostic: vi.fn().mockResolvedValue(undefined),
  buildGatewayConnectionDetails: vi.fn(() => ({ message: "gateway details" })),
  callGateway: vi.fn(),
  resolveSecretInputRef: vi.fn((params: { value?: unknown }) => ({
    ref:
      params.value === "exec-token"
        ? { source: "exec", command: "printf token", cache: false }
        : undefined,
  })),
  resolveGatewayAuth: vi.fn<() => { mode: string; token?: string }>(() => ({
    mode: "token",
    token: undefined,
  })),
  resolveGatewayAuthToken: vi.fn<
    () => Promise<{ source: string; token?: string; unresolvedRefReason?: string }>
  >(async () => ({
    source: "unavailable",
    unresolvedRefReason: "exec provider failed",
  })),
  getSkippedExecRefStaticError: vi.fn(() => undefined),
  maybeRepairGatewayServiceConfig: vi.fn().mockResolvedValue(undefined),
  maybeScanExtraGatewayServices: vi.fn().mockResolvedValue(undefined),
  maybeResolveDuelingSystemdGatewayScopes: vi.fn().mockResolvedValue(undefined),
  noteMacGatewayPlatformWarnings: vi.fn(),
  noteMacDisabledGatewayLaunchAgent: vi.fn(),
  gatewaySecretInputPathCanWin: vi.fn(),
  readGatewaySecretInputValue: vi.fn((..._args: unknown[]) => undefined as string | undefined),
  checkGatewayHealth: vi.fn(async () => ({
    authenticated: true,
    healthOk: true,
    status: { ok: true },
  })),
  probeGatewayMemoryStatus: vi.fn(async () => ({ checked: true, ready: true, skipped: false })),
  noteChromeMcpBrowserReadiness: vi.fn(),
  detectLegacyStateMigrations: vi.fn(),
  runLegacyStateMigrations: vi.fn(),
  repairObsoleteGeneratedExecApprovals: vi.fn(() => 0),
  collectLegacyPluginManifestContractMigrations: vi.fn(() => [] as unknown[]),
  legacyPluginManifestContractMigrationToHealthFinding: vi.fn(
    (migration: { pluginId: string }) => ({
      checkId: "core/doctor/legacy-plugin-manifests",
      severity: "warning" as const,
      message: `Plugin manifest ${migration.pluginId} uses legacy top-level capability keys.`,
      path: "/tmp/openclaw-plugin/openclaw.plugin.json",
      target: migration.pluginId,
      requirement: "contracts-capability-keys",
    }),
  ),
  maybeRepairLegacyPluginManifestContracts: vi.fn().mockResolvedValue(undefined),
  maybeRepairOwnedChromeExtensionNativeHosts: vi.fn().mockResolvedValue({
    changes: [],
    warnings: [],
  }),
  listAgentIds: vi.fn<(_cfg: OpenClawConfig) => string[]>(() => ["default"]),
  listAgentEntries: vi.fn(() => [{ id: "default" }]),
  tryResolveSoleAgentId: vi.fn<(_cfg: OpenClawConfig) => string | undefined>(() => "default"),
  resolveAgentWorkspaceDir: vi.fn<(_cfg: OpenClawConfig, agentId: string) => string>(
    () => "/tmp/openclaw-workspace",
  ),
  tryResolveConfiguredAgentWorkspaceDir: vi.fn(() => "/tmp/openclaw-workspace"),
  tryResolveSystemAgentWorkspaceDir: vi.fn(() => "/tmp/openclaw-workspace"),
  resolveDefaultAgentId: vi.fn<(_cfg: OpenClawConfig) => string>(() => "default"),
  resolveAgentContextLimits: vi.fn(
    (cfg: { agents?: { defaults?: { contextLimits?: unknown } } }) =>
      cfg.agents?.defaults?.contextLimits ?? {},
  ),
  note: vi.fn(),
  loadModelCatalog: vi.fn(async () => []),
  findModelCatalogEntry: vi.fn(() => ({ contextTokens: 200_000 })),
  getModelRefStatus: vi.fn(() => ({ allowed: true, inCatalog: true, key: "openai/gpt-5.5" })),
  resolveConfiguredModelRef: vi.fn(() => ({ provider: "openai", model: "gpt-5.5" })),
  resolveDefaultModelForAgent: vi.fn(() => ({ provider: "openai", model: "gpt-5.5" })),
  resolveHooksGmailModel: vi.fn(() => ({ provider: "openai", model: "gpt-5.5" })),
  modelKey: vi.fn((provider: string, model: string) => `${provider}/${model}`),
  replaceConfigFile: vi.fn().mockResolvedValue(undefined),
  readConfigFileSnapshot: vi.fn().mockResolvedValue({
    exists: true,
    valid: true,
    config: {},
    issues: [],
  }),
  gatherDaemonStatus: vi.fn(),
  noteWorkspaceStatus: vi.fn(),
  collectWorkspaceStatusHealthFindings: vi.fn().mockResolvedValue([]),
  collectWorkspaceBackupTip: vi.fn<(workspaceDir: string) => string | undefined>(() => undefined),
  shouldSuggestMemorySystem: vi.fn<(workspaceDir: string) => Promise<boolean>>(async () => false),
  collectDiskSpaceHealthFindings: vi.fn((): readonly HealthFinding[] => []),
  collectHeartbeatCadenceMigrationFindings: vi.fn(async () => [] as unknown[]),
  maybeMigrateHeartbeatCadenceToCron: vi.fn().mockResolvedValue({ changes: [], warnings: [] }),
  collectHeartbeatScratchMigrationFindings: vi.fn(async () => [] as unknown[]),
  collectToolsMdMigrationFindings: vi.fn(async () => [] as unknown[]),
  maybeMigrateHeartbeatFilesToScratch: vi.fn().mockResolvedValue({ changes: [], warnings: [] }),
  maybeMigrateToolsMd: vi.fn().mockResolvedValue({ changes: [], warnings: [] }),
  collectHeartbeatTaskMigrationFindings: vi.fn(async () => [] as unknown[]),
  maybeMigrateHeartbeatTasksToCron: vi.fn().mockResolvedValue({ changes: [], warnings: [] }),
  collectWhatsappResponsivenessHealthFindings: vi.fn((): readonly HealthFinding[] => []),
  noteWhatsappResponsivenessHealth: vi.fn().mockResolvedValue(undefined),
  collectDevicePairingHealthFindings: vi.fn(async () => []),
  collectLegacyCronStoreHealthFindings: vi.fn(async (): Promise<readonly HealthFinding[]> => []),
  collectLegacyWhatsAppCrontabHealthWarning: vi.fn(
    async (): Promise<string | undefined> => undefined,
  ),
  maybeRepairLegacyCronStore: vi.fn().mockResolvedValue(undefined),
  repairCronCodexModelRefsAfterConfigWrite: vi.fn().mockResolvedValue({
    changes: [],
    warnings: [],
  }),
  noteLegacyWhatsAppCrontabHealthCheck: vi.fn().mockResolvedValue(undefined),
  scanConfiguredChannelPluginBlockers: vi.fn(
    (): Array<{ channelId: string; pluginId: string; reason: string }> => [],
  ),
  channelPluginBlockerHitToHealthFinding: vi.fn(
    (hit: { channelId: string; pluginId: string; reason: string }) => ({
      checkId: "core/doctor/channel-plugin-blockers",
      severity: "warning" as const,
      message: "channels." + hit.channelId + " blocked",
      path: "channels." + hit.channelId,
      target: hit.pluginId,
      requirement: hit.reason,
    }),
  ),
  collectBundledChannelPackageStateLoadFailures: vi.fn(() => [] as unknown[]),
  collectStalePluginRuntimeSymlinkHealthFindings: vi.fn(async () => [] as unknown[]),
  collectChannelPreviewWarningHealthFindings: vi.fn(
    async (): Promise<readonly HealthFinding[]> => [],
  ),
  applyWizardMetadata: vi.fn((cfg: unknown) => cfg),
  logConfigUpdated: vi.fn(),
  isRecord: vi.fn(
    (value: unknown): value is Record<string, unknown> =>
      typeof value === "object" && value !== null && !Array.isArray(value),
  ),
  shortenHomePath: vi.fn((p: string) => p),
  formatCliCommand: vi.fn((cmd: string) => cmd),
  findInstalledSystemdGatewayScope: vi.fn<
    (typeof import("../daemon/systemd.js"))["findInstalledSystemdGatewayScope"]
  >(async () => ({
    scope: "user",
    unitName: "openclaw-gateway.service",
    unitPath: "/home/alice/.config/systemd/user/openclaw-gateway.service",
  })),
  isSystemdUserServiceAvailable: vi.fn(async () => true),
  readSystemdUserLingerStatus: vi.fn(
    async (_params: {
      env: Record<string, string | undefined>;
      user?: string;
    }): Promise<{ user: string; linger: "yes" | "no" } | null> => ({
      user: "alice",
      linger: "no",
    }),
  ),
  resolveSystemdUserServiceAccount: vi.fn(() => "alice" as string | null),
  gatewayServiceIsLoaded: vi.fn(async () => true),
  resolveGatewayService: vi.fn(),
}));

vi.mock("../config/paths.js", async () => {
  const actual = await vi.importActual<typeof import("../config/paths.js")>("../config/paths.js");
  return { ...actual, isDefaultInstallIdentity: mocks.isDefaultInstallIdentity };
});

export const DOCTOR_GATEWAY_HEALTH_ID = "doctor:gateway-health";

// mock-isolation: Keep plugin installation and release stamping behind the fixture; these flow tests must not install packages.
vi.mock("../commands/doctor/shared/release-configured-plugin-installs.js", () => ({
  maybeRunConfiguredPluginInstallReleaseStep: mocks.maybeRunConfiguredPluginInstallReleaseStep,
}));

// mock-isolation: Supply stale-link findings without scanning or repairing host plugin-runtime links.
vi.mock("../commands/doctor/shared/plugin-runtime-symlinks.js", () => ({
  collectStalePluginRuntimeSymlinkHealthFindings:
    mocks.collectStalePluginRuntimeSymlinkHealthFindings,
}));

// mock-isolation: Each case controls the health registry; do not register the real bundled checks over that fixture.
vi.mock("./bundled-health-checks.js", () => ({
  registerBundledHealthChecks: mocks.registerBundledHealthChecks,
}));

// mock-isolation: Capture repair dispatch without running the nested repair pipeline or its state writes.
vi.mock("./doctor-repair-flow.js", () => ({
  runDoctorHealthRepairs: mocks.runDoctorHealthRepairs,
}));

vi.mock("../config/types.secrets.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config/types.secrets.js")>();
  return {
    ...actual,
    resolveSecretInputRef: mocks.resolveSecretInputRef,
  };
});

vi.mock("../gateway/auth.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../gateway/auth.js")>()),
  resolveGatewayAuth: mocks.resolveGatewayAuth,
}));

vi.mock("../gateway/auth-token-resolution.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../gateway/auth-token-resolution.js")>()),
  resolveGatewayAuthToken: mocks.resolveGatewayAuthToken,
}));

vi.mock("../secrets/exec-resolution-policy.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../secrets/exec-resolution-policy.js")>()),
  getSkippedExecRefStaticError: mocks.getSkippedExecRefStaticError,
}));

// mock-isolation: Model service repairs and conflicts without discovering or mutating host service definitions.
vi.mock("../commands/doctor-gateway-services.js", () => ({
  maybeRepairGatewayServiceConfig: mocks.maybeRepairGatewayServiceConfig,
  maybeScanExtraGatewayServices: mocks.maybeScanExtraGatewayServices,
  maybeResolveDuelingSystemdGatewayScopes: mocks.maybeResolveDuelingSystemdGatewayScopes,
}));

// mock-isolation: Supply profile migration receipts without rewriting authentication stores or deleting legacy files.
vi.mock("../commands/doctor-auth-flat-profiles.js", () => ({
  maybeRepairLegacyAuthProfileStores: ({
    profileIdMap,
  }: {
    profileIdMap: Map<string, string>;
  }) => ({
    changes: [],
    warnings: [],
    profileIdMap,
  }),
  collectOpenAICodexAuthProfileStoreIdMap: mocks.collectOpenAICodexAuthProfileStoreIdMap,
  maybeMigrateAuthProfileJsonStoresToSqlite: mocks.maybeMigrateAuthProfileJsonStoresToSqlite,
  maybeRepairOpenAICodexAuthConfig: mocks.maybeRepairOpenAICodexAuthConfig,
}));

// mock-isolation: Supply catalog migration results without migrating installed plugin data.
vi.mock("../commands/doctor-plugin-model-catalog.js", () => ({
  maybeMigrateLegacyPluginModelCatalogs: mocks.maybeMigrateLegacyPluginModelCatalogs,
}));

// mock-isolation: Supply credential migration results without reading or rewriting credential stores.
vi.mock("../commands/doctor-model-catalog-credentials.js", () => ({
  maybeMigrateModelCatalogCredentials: mocks.maybeMigrateModelCatalogCredentials,
}));

// mock-isolation: Capture daemon repair requests without installing, stopping, or restarting a host service.
vi.mock("../commands/doctor-gateway-daemon-flow.js", () => ({
  maybeRepairGatewayDaemon: mocks.maybeRepairGatewayDaemon,
}));

vi.mock("../infra/container-environment.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/container-environment.js")>()),
  isContainerEnvironment: mocks.isContainerEnvironment,
}));

vi.mock("../daemon/service.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../daemon/service.js")>();
  return {
    ...actual,
    readGatewayServiceState: async () => ({
      installed: true,
      loadState: {
        status: (await mocks.gatewayServiceIsLoaded()) ? "loaded" : "not-loaded",
      },
      running: false,
      env: {},
      command: null,
      runtime: { status: "stopped" },
    }),
    resolveGatewayService: mocks.resolveGatewayService,
  };
});

vi.mock("../daemon/systemd.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../daemon/systemd.js")>();
  return {
    ...actual,
    findInstalledSystemdGatewayScope: mocks.findInstalledSystemdGatewayScope,
    isSystemdUserServiceAvailable: mocks.isSystemdUserServiceAvailable,
    readSystemdUserLingerStatus: mocks.readSystemdUserLingerStatus,
    resolveSystemdUserServiceAccount: mocks.resolveSystemdUserServiceAccount,
  };
});

// mock-isolation: Control retired OAuth cleanup plans without inspecting or changing real profile stores.
vi.mock("../commands/doctor-auth-legacy-oauth.js", () => ({
  maybeRepairLegacyOAuthProfileIds: mocks.maybeRepairLegacyOAuthProfileIds,
}));

// mock-isolation: Control legacy migration detection and results without migrating host state.
vi.mock("../infra/state-migrations.doctor.js", () => ({
  detectLegacyStateMigrations: mocks.detectLegacyStateMigrations,
  runLegacyStateMigrations: mocks.runLegacyStateMigrations,
}));

// mock-isolation: Keep generated-approval repair in the fixture rather than modifying an approvals store.
vi.mock("../infra/exec-approvals-generated-migration.js", () => ({
  repairObsoleteGeneratedExecApprovals: mocks.repairObsoleteGeneratedExecApprovals,
}));

// mock-isolation: Control manifest migration findings and receipts without rewriting plugin manifests.
vi.mock("../commands/doctor-plugin-manifests.js", () => ({
  collectLegacyPluginManifestContractMigrations:
    mocks.collectLegacyPluginManifestContractMigrations,
  legacyPluginManifestContractMigrationToHealthFinding:
    mocks.legacyPluginManifestContractMigrationToHealthFinding,
  maybeRepairLegacyPluginManifestContracts: mocks.maybeRepairLegacyPluginManifestContracts,
}));

vi.mock("../agents/auth-profiles.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../agents/auth-profiles.js")>()),
  removeAuthProfilesAcrossOwnerStores: mocks.removeAuthProfilesAcrossOwnerStores,
}));

// mock-isolation: Use synthetic auth health findings instead of probing ambient credentials or external auth providers.
vi.mock("../commands/doctor-auth.js", () => ({
  collectAuthProfileHealthFindings: mocks.collectAuthProfileHealthFindings,
  noteAuthProfileHealth: mocks.noteAuthProfileHealth,
  noteCopilotAmbientToken: mocks.noteCopilotAmbientToken,
  noteLegacyCodexProviderOverride: mocks.noteLegacyCodexProviderOverride,
  noteSharedAuthStoreStatus: mocks.noteSharedAuthStoreStatus,
}));

// mock-isolation: Exclude memory provider probes and repairs from these Doctor orchestration tests.
vi.mock("../commands/doctor-memory-recall.js", () => ({
  maybeRepairMemoryRecallHealth: vi.fn().mockResolvedValue(undefined),
  noteMemoryRecallHealth: vi.fn().mockResolvedValue(undefined),
}));

// mock-isolation: Use fixture memory-search findings without contacting or initializing a memory provider.
vi.mock("../commands/doctor-memory-search.js", () => ({
  noteMemorySearchHealth: mocks.noteMemorySearchHealth,
  collectMemorySearchHealthFindings: mocks.collectMemorySearchHealthFindings,
}));

// mock-isolation: Record diagnostic ordering without probing a network proxy.
vi.mock("../commands/doctor-web-fetch-proxy.js", () => ({
  noteWebFetchProxyDiagnostic: mocks.noteWebFetchProxyDiagnostic,
}));

// mock-isolation: Supply Gateway connection and RPC outcomes without opening a live Gateway connection.
vi.mock("../gateway/call.js", () => ({
  buildGatewayConnectionDetails: mocks.buildGatewayConnectionDetails,
  callGateway: mocks.callGateway,
}));

vi.mock("../commands/doctor-platform-notes.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../commands/doctor-platform-notes.js")>()),
  noteMacGatewayPlatformWarnings: mocks.noteMacGatewayPlatformWarnings,
  noteMacDisabledGatewayLaunchAgent: mocks.noteMacDisabledGatewayLaunchAgent,
}));

// mock-isolation: Do not scan the host launchd domain while exercising synthetic platform diagnostics.
vi.mock("../commands/doctor-foreign-launchd-jobs.js", () => ({
  noteMacForeignLaunchdJobs: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../gateway/credentials-secret-inputs.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../gateway/credentials-secret-inputs.js")>();
  return {
    ...actual,
    gatewaySecretInputPathCanWin: (
      ...args: Parameters<typeof actual.gatewaySecretInputPathCanWin>
    ) =>
      mocks.gatewaySecretInputPathCanWin.getMockImplementation()
        ? mocks.gatewaySecretInputPathCanWin(...args)
        : actual.gatewaySecretInputPathCanWin(...args),
  };
});

vi.mock("../gateway/secret-input-paths.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../gateway/secret-input-paths.js")>();
  return {
    ...actual,
    readGatewaySecretInputValue: (
      ...args: Parameters<typeof actual.readGatewaySecretInputValue>
    ) =>
      mocks.readGatewaySecretInputValue.getMockImplementation()
        ? mocks.readGatewaySecretInputValue(...args)
        : actual.readGatewaySecretInputValue(...args),
  };
});

// mock-isolation: Supply Gateway and memory health outcomes without probing live services.
vi.mock("../commands/doctor-gateway-health.js", () => ({
  checkGatewayHealth: mocks.checkGatewayHealth,
  probeGatewayMemoryStatus: mocks.probeGatewayMemoryStatus,
}));

// mock-isolation: Supply browser readiness and repair results without inspecting or changing native-host registrations.
vi.mock("../commands/doctor-browser.js", () => ({
  noteChromeMcpBrowserReadiness: mocks.noteChromeMcpBrowserReadiness,
  maybeRepairOwnedChromeExtensionNativeHosts: mocks.maybeRepairOwnedChromeExtensionNativeHosts,
}));

vi.mock("../agents/agent-scope.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../agents/agent-scope.js")>()),
  listAgentIds: mocks.listAgentIds,
  listAgentEntries: mocks.listAgentEntries,
  tryResolveSoleAgentId: mocks.tryResolveSoleAgentId,
  resolveAgentWorkspaceDir: mocks.resolveAgentWorkspaceDir,
  tryResolveConfiguredAgentWorkspaceDir: mocks.tryResolveConfiguredAgentWorkspaceDir,
  tryResolveSystemAgentWorkspaceDir: mocks.tryResolveSystemAgentWorkspaceDir,
  resolveDefaultAgentId: mocks.resolveDefaultAgentId,
  resolveAgentContextLimits: mocks.resolveAgentContextLimits,
}));

vi.mock("../../packages/terminal-core/src/note.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../packages/terminal-core/src/note.js")>()),
  note: mocks.note,
}));

vi.mock("../agents/model-catalog.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../agents/model-catalog.js")>()),
  findModelCatalogEntry: mocks.findModelCatalogEntry,
}));

vi.mock("../agents/prepared-model-catalog.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../agents/prepared-model-catalog.js")>()),
  loadProviderScopedThinkingCatalog: vi.fn(async () => []),
  readPreparedModelCatalog: mocks.loadModelCatalog,
}));

vi.mock("../agents/model-selection.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../agents/model-selection.js")>()),
  getModelRefStatus: mocks.getModelRefStatus,
  resolveConfiguredModelRef: mocks.resolveConfiguredModelRef,
  resolveDefaultModelForAgent: mocks.resolveDefaultModelForAgent,
  resolveHooksGmailModel: mocks.resolveHooksGmailModel,
  modelKey: mocks.modelKey,
}));

vi.mock("../version.js", async () => ({
  ...(await vi.importActual<typeof import("../version.js")>("../version.js")),
  VERSION: "2026.5.2-test",
  resolveCompatibilityHostVersion: vi.fn(() => "2026.5.2-test"),
  resolveIsNixMode: vi.fn(() => false),
}));

vi.mock("../commands/doctor/shared/config-flow-steps.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../commands/doctor/shared/config-flow-steps.js")>()),
  restoreDoctorConfigEnvRefs: (cfg: OpenClawConfig) => cfg,
}));

vi.mock("../config/config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../config/config.js")>()),
  CONFIG_PATH: "/tmp/fake-openclaw.json",
  transformConfigFile: async ({
    transform,
    ...options
  }: Parameters<typeof import("../config/config.js").transformConfigFile>[0]) => {
    const { nextConfig } = await transform(
      {},
      { snapshot: createDoctorConfigSnapshot(), previousHash: null, attempt: 0 },
      {},
    );
    await mocks.replaceConfigFile({ ...options, nextConfig });
    const path = options.writeOptions?.expectedConfigPath;
    if (!path) {
      throw new Error("Doctor write fixture requires an expected config path");
    }
    return { nextConfig, path, persistedHash: "committed-revision" };
  },
  readConfigFileSnapshot: mocks.readConfigFileSnapshot,
}));

// mock-isolation: Keep package-target lookups synthetic; these health tests must not query the npm registry.
vi.mock("../infra/update-check-package-target.js", () => ({
  fetchNpmPackageTargetStatus: vi.fn(),
}));

// mock-isolation: Supply daemon status without probing host processes or service managers.
vi.mock("../cli/daemon-cli/status.gather.js", () => ({
  gatherDaemonStatus: mocks.gatherDaemonStatus,
}));

// mock-isolation: Supply workspace findings without inspecting the operator workspace.
vi.mock("../commands/doctor-workspace-status.js", () => ({
  noteWorkspaceStatus: mocks.noteWorkspaceStatus,
  collectWorkspaceStatusHealthFindings: mocks.collectWorkspaceStatusHealthFindings,
}));

// mock-isolation: Use fixture workspace suggestions instead of reading host workspace contents.
vi.mock("../commands/doctor-workspace.js", () => ({
  collectWorkspaceBackupTip: mocks.collectWorkspaceBackupTip,
  MEMORY_SYSTEM_PROMPT: "Enable memory system for better recall.",
  shouldSuggestMemorySystem: mocks.shouldSuggestMemorySystem,
}));

// mock-isolation: Supply disk-space findings independent of the test host filesystem capacity.
vi.mock("../commands/doctor-disk-space.js", () => ({
  noteDiskSpace: vi.fn(),
  collectDiskSpaceHealthFindings: mocks.collectDiskSpaceHealthFindings,
}));

// mock-isolation: Control cadence migration findings and writes without modifying a real cron store.
vi.mock("../commands/doctor-heartbeat-cadence-migration.js", () => ({
  collectHeartbeatCadenceMigrationFindings: mocks.collectHeartbeatCadenceMigrationFindings,
  maybeMigrateHeartbeatCadenceToCron: mocks.maybeMigrateHeartbeatCadenceToCron,
}));

// mock-isolation: Control scratch migration results without moving heartbeat workspace files.
vi.mock("../commands/doctor-heartbeat-scratch-migration.js", () => ({
  collectHeartbeatScratchMigrationFindings: mocks.collectHeartbeatScratchMigrationFindings,
  maybeMigrateHeartbeatFilesToScratch: mocks.maybeMigrateHeartbeatFilesToScratch,
}));

// mock-isolation: Control tools migration results without rewriting workspace documents.
vi.mock("../commands/doctor-tools-md-migration.js", () => ({
  collectToolsMdMigrationFindings: mocks.collectToolsMdMigrationFindings,
  maybeMigrateToolsMd: mocks.maybeMigrateToolsMd,
}));

// mock-isolation: Control heartbeat task migration without creating jobs in a real cron store.
vi.mock("../commands/doctor-heartbeat-task-migration.js", () => ({
  collectHeartbeatTaskMigrationFindings: mocks.collectHeartbeatTaskMigrationFindings,
  maybeMigrateHeartbeatTasksToCron: mocks.maybeMigrateHeartbeatTasksToCron,
}));

// mock-isolation: Supply synthetic responsiveness findings without discovering host TUI processes.
vi.mock("../commands/doctor-whatsapp-responsiveness.js", () => ({
  collectWhatsappResponsivenessHealthFindings: mocks.collectWhatsappResponsivenessHealthFindings,
  noteWhatsappResponsivenessHealth: mocks.noteWhatsappResponsivenessHealth,
}));

// mock-isolation: Supply pairing findings without reading or changing real device authorization state.
vi.mock("../commands/doctor-device-pairing.js", () => ({
  collectDevicePairingHealthFindings: mocks.collectDevicePairingHealthFindings,
  noteDevicePairingHealth: vi.fn().mockResolvedValue(undefined),
}));

// mock-isolation: Supply legacy cron findings and repair results without loading or migrating host cron state.
vi.mock("../commands/doctor/cron/index.js", () => ({
  collectLegacyCronStoreHealthFindings: mocks.collectLegacyCronStoreHealthFindings,
  collectLegacyWhatsAppCrontabHealthWarning: mocks.collectLegacyWhatsAppCrontabHealthWarning,
  maybeRepairLegacyCronStore: mocks.maybeRepairLegacyCronStore,
  noteLegacyWhatsAppCrontabHealthCheck: mocks.noteLegacyWhatsAppCrontabHealthCheck,
}));

// mock-isolation: Capture post-write cron repair without rewriting a real job store.
vi.mock("../commands/doctor/cron/legacy-repair.js", () => ({
  repairCronCodexModelRefsAfterConfigWrite: mocks.repairCronCodexModelRefsAfterConfigWrite,
}));

// mock-isolation: Supply channel blocker findings without loading configured channel plugins.
vi.mock("../commands/doctor/shared/channel-plugin-blockers.js", () => ({
  scanConfiguredChannelPluginBlockers: mocks.scanConfiguredChannelPluginBlockers,
  channelPluginBlockerHitToHealthFinding: mocks.channelPluginBlockerHitToHealthFinding,
}));

vi.mock("../channels/plugins/package-state-probes.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../channels/plugins/package-state-probes.js")>()),
  collectBundledChannelPackageStateLoadFailures:
    mocks.collectBundledChannelPackageStateLoadFailures,
}));

vi.mock("./doctor-startup-channel-maintenance.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./doctor-startup-channel-maintenance.js")>();
  return {
    ...actual,
    collectChannelPreviewWarningHealthFindings: mocks.collectChannelPreviewWarningHealthFindings,
  };
});

// mock-isolation: Keep token generation deterministic and wizard metadata mutation under the fixture.
vi.mock("../commands/onboard-helpers.js", () => ({
  applyWizardMetadata: mocks.applyWizardMetadata,
  randomToken: vi.fn(() => "generated-gateway-token"),
}));

vi.mock("../config/logging.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../config/logging.js")>()),
  logConfigUpdated: mocks.logConfigUpdated,
}));

vi.mock("../utils.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../utils.js")>();
  return {
    ...actual,
    isRecord: mocks.isRecord,
    resolveConfigDir: vi.fn(() => "/tmp/openclaw-config"),
    resolveUserPath: vi.fn((value: string) => value),
    shortenHomePath: mocks.shortenHomePath,
  };
});

vi.mock("../cli/command-format.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../cli/command-format.js")>()),
  formatCliCommand: mocks.formatCliCommand,
}));

export function requireDoctorContribution(id: string) {
  const contribution = resolveDoctorHealthContributions().find((entry) => entry.id === id);
  if (!contribution) {
    throw new Error(`expected doctor contribution ${id}`);
  }
  return contribution;
}

export async function requireDoctorHealthCheck(id: string) {
  const check = (await resolveDoctorContributionHealthChecks()).find((entry) => entry.id === id);
  if (!check) {
    throw new Error(`expected doctor health check ${id}`);
  }
  return check;
}

export type DoctorContributionRunContext = Parameters<
  ReturnType<typeof requireDoctorContribution>["run"]
>[0];

export function createDoctorContext({
  shouldRepair = false,
  ...overrides
}: Parameters<typeof createDoctorHealthFlowContext>[0] & { shouldRepair?: boolean } = {}) {
  return createDoctorHealthFlowContext({
    configPath: "/tmp/fake-openclaw.json",
    prompter: createDoctorPrompterFixture(shouldRepair),
    ...overrides,
  });
}

export function createDoctorLintFixture(
  cfg: OpenClawConfig | Record<string, unknown> = {},
  overrides: Omit<Parameters<typeof createDoctorLintContext>[0], "cfg"> = {},
) {
  return createDoctorLintContext({
    cfg: cfg as OpenClawConfig,
    mode: "lint",
    runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
    ...overrides,
  });
}

export function setRegisteredHealthChecks(
  checks: ReadonlyArray<Pick<HealthCheck, "id" | "kind"> & { defaultEnabled?: boolean }>,
) {
  clearHealthChecksForTest();
  for (const check of checks) {
    registerHealthCheck({ ...check, description: check.id, detect: async () => [] });
  }
}

export async function withProcessPlatform<T>(
  platform: NodeJS.Platform,
  run: () => Promise<T>,
): Promise<T> {
  const original = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
  try {
    return await run();
  } finally {
    if (original) {
      Object.defineProperty(process, "platform", original);
    }
  }
}

export function setupDoctorHealthContributionsFixture() {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.maybeMigrateAuthProfileJsonStoresToSqlite.mockResolvedValue({
      detected: [],
      changes: [],
      migratedProfileIds: new Set<string>(),
      blockedProfileIds: new Set<string>(),
      warnings: [],
    });
    mocks.maybeMigrateLegacyPluginModelCatalogs.mockResolvedValue({
      detected: 0,
      migrated: 0,
      warnings: [],
    });
    mocks.maybeRepairGatewayDaemon.mockResolvedValue(undefined);
    mocks.maybeRepairLegacyPluginManifestContracts.mockResolvedValue(undefined);
    mocks.noteAuthProfileHealth.mockResolvedValue(undefined);
    mocks.noteMemorySearchHealth.mockResolvedValue(undefined);
    mocks.collectMemorySearchHealthFindings.mockResolvedValue([]);
    mocks.noteWebFetchProxyDiagnostic.mockResolvedValue(undefined);
    mocks.callGateway.mockResolvedValue({});
    mocks.maybeRepairGatewayServiceConfig.mockImplementation(async (cfg: unknown) => cfg);
    mocks.maybeScanExtraGatewayServices.mockResolvedValue(undefined);
    mocks.runDoctorHealthRepairs.mockImplementation(async (input: { cfg?: unknown }) => ({
      config: input.cfg ?? {},
      findings: [],
      remainingFindings: [],
      changes: [],
      warnings: [],
      diffs: [],
      effects: [],
      checksRun: 0,
      checksRepaired: 0,
      checksValidated: 0,
    }));
    mocks.noteChromeMcpBrowserReadiness.mockResolvedValue(undefined);
    mocks.detectLegacyStateMigrations.mockResolvedValue({ preview: [], warnings: [], notices: [] });
    mocks.runLegacyStateMigrations.mockResolvedValue({
      changes: [],
      warnings: [],
      stepReceipts: [],
    });
    mocks.readConfigFileSnapshot.mockResolvedValue({
      exists: true,
      valid: true,
      sourceConfig: {},
      config: {},
      issues: [],
    });
    mocks.gatherDaemonStatus.mockResolvedValue({});
    mocks.resolveGatewayService.mockReturnValue({ isLoaded: mocks.gatewayServiceIsLoaded });
    mocks.collectWorkspaceStatusHealthFindings.mockResolvedValue([]);
    mocks.maybeMigrateHeartbeatCadenceToCron.mockResolvedValue({ changes: [], warnings: [] });
    mocks.maybeMigrateHeartbeatFilesToScratch.mockResolvedValue({ changes: [], warnings: [] });
    mocks.maybeMigrateToolsMd.mockResolvedValue({ changes: [], warnings: [] });
    mocks.maybeMigrateHeartbeatTasksToCron.mockResolvedValue({ changes: [], warnings: [] });
    mocks.noteWhatsappResponsivenessHealth.mockResolvedValue(undefined);
    mocks.maybeRepairLegacyCronStore.mockResolvedValue(undefined);
    mocks.repairCronCodexModelRefsAfterConfigWrite.mockResolvedValue({
      changes: [],
      warnings: [],
    });
    mocks.noteLegacyWhatsAppCrontabHealthCheck.mockResolvedValue(undefined);
    mocks.collectStalePluginRuntimeSymlinkHealthFindings.mockResolvedValue([]);
    mocks.replaceConfigFile.mockResolvedValue(undefined);
    mocks.noteMacGatewayPlatformWarnings.mockResolvedValue(undefined);
    setRegisteredHealthChecks([
      { id: "core/example/internal", kind: "core" },
      { id: "plugin/example/unrelated", kind: "plugin" },
    ]);
  });

  afterEach(() => {
    clearHealthChecksForTest();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });
}

export { mocks };
