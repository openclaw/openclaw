// Doctor health contribution tests cover plugin-provided health checks.
import fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DoctorPrompter } from "../commands/doctor-prompter.js";
import { CORE_HEALTH_CHECKS } from "./doctor-core-checks.js";
import {
  createDoctorHealthContribution,
  resolveDoctorContributionHealthChecks,
  resolveDoctorHealthContributions,
  shouldSkipLegacyUpdateDoctorConfigWrite,
} from "./doctor-health-contributions.js";
import type { HealthCheck } from "./health-checks.js";

const mocks = vi.hoisted(() => ({
  maybeRunConfiguredPluginInstallReleaseStep: vi.fn(),
  registerBundledHealthChecks: vi.fn(),
  runDoctorHealthRepairs: vi.fn(),
  maybeRepairLegacyFlatAuthProfileStores: vi.fn().mockResolvedValue(undefined),
  maybeRepairCanonicalApiKeyFieldAlias: vi.fn().mockResolvedValue(undefined),
  maybeRepairGatewayDaemon: vi.fn().mockResolvedValue(undefined),
  maybeRepairLegacyOAuthProfileIds: vi.fn(async (cfg: unknown) => cfg),
  maybeRepairLegacyOAuthSidecarProfiles: vi.fn().mockResolvedValue(undefined),
  noteAuthProfileHealth: vi.fn().mockResolvedValue(undefined),
  noteLegacyCodexProviderOverride: vi.fn(),
  buildGatewayConnectionDetails: vi.fn(() => ({ message: "gateway details" })),
  resolveSecretInputRef: vi.fn((params: { value?: unknown }) => ({
    ref:
      params.value === "exec-token"
        ? { source: "exec", command: "printf token", cache: false }
        : undefined,
  })),
  resolveGatewayAuth: vi.fn(() => ({ mode: "token", token: undefined })),
  resolveGatewayAuthToken: vi.fn(async () => ({
    source: "unavailable",
    unresolvedRefReason: "exec provider failed",
  })),
  getSkippedExecRefStaticError: vi.fn(() => undefined),
  maybeRepairGatewayServiceConfig: vi.fn().mockResolvedValue(undefined),
  maybeScanExtraGatewayServices: vi.fn().mockResolvedValue(undefined),
  noteMacLaunchAgentOverrides: vi.fn(),
  noteMacLaunchctlGatewayEnvOverrides: vi.fn(),
  noteMacStaleOpenClawUpdateLaunchdJobs: vi.fn(),
  gatewaySecretInputPathCanWin: vi.fn(),
  readGatewaySecretInputValue: vi.fn((..._args: unknown[]) => undefined as string | undefined),
  checkGatewayHealth: vi.fn(async () => ({
    authenticated: true,
    healthOk: true,
    status: { ok: true },
  })),
  probeGatewayMemoryStatus: vi.fn(async () => ({ checked: true, ready: true, skipped: false })),
  listHealthChecks: vi.fn(),
  getHealthCheck: vi.fn(),
  registerHealthCheck: vi.fn(),
  noteChromeMcpBrowserReadiness: vi.fn(),
  detectLegacyClawdBrowserProfileResidue: vi.fn(),
  maybeArchiveLegacyClawdBrowserProfileResidue: vi.fn(),
  resolveAgentWorkspaceDir: vi.fn(() => "/tmp/openclaw-workspace"),
  resolveDefaultAgentId: vi.fn(() => "default"),
  note: vi.fn(),
  loadModelCatalog: vi.fn(async () => []),
  getModelRefStatus: vi.fn(() => ({ allowed: true, inCatalog: true, key: "openai/gpt-5.5" })),
  resolveConfiguredModelRef: vi.fn(() => ({ provider: "openai", model: "gpt-5.5" })),
  resolveHooksGmailModel: vi.fn(() => ({ provider: "openai", model: "gpt-5.5" })),
  replaceConfigFile: vi.fn().mockResolvedValue(undefined),
  readConfigFileSnapshot: vi.fn().mockResolvedValue({
    exists: true,
    valid: true,
    config: {},
    issues: [],
  }),
  gatherDaemonStatus: vi.fn(),
  noteWorkspaceStatus: vi.fn(),
  applyWizardMetadata: vi.fn((cfg: unknown) => cfg),
  logConfigUpdated: vi.fn(),
  isRecord: vi.fn(
    (value: unknown): value is Record<string, unknown> =>
      typeof value === "object" && value !== null && !Array.isArray(value),
  ),
  shortenHomePath: vi.fn((p: string) => p),
  formatCliCommand: vi.fn((cmd: string) => cmd),
}));

const DOCTOR_GATEWAY_HEALTH_ID = "doctor:gateway-health";

vi.mock("../commands/doctor/shared/release-configured-plugin-installs.js", () => ({
  maybeRunConfiguredPluginInstallReleaseStep: mocks.maybeRunConfiguredPluginInstallReleaseStep,
}));

vi.mock("./bundled-health-checks.js", () => ({
  registerBundledHealthChecks: mocks.registerBundledHealthChecks,
}));

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

vi.mock("../gateway/auth.js", () => ({
  resolveGatewayAuth: mocks.resolveGatewayAuth,
}));

vi.mock("../gateway/auth-token-resolution.js", () => ({
  resolveGatewayAuthToken: mocks.resolveGatewayAuthToken,
}));

vi.mock("../secrets/exec-resolution-policy.js", () => ({
  getSkippedExecRefStaticError: mocks.getSkippedExecRefStaticError,
}));

vi.mock("../commands/doctor-gateway-services.js", () => ({
  maybeRepairGatewayServiceConfig: mocks.maybeRepairGatewayServiceConfig,
  maybeScanExtraGatewayServices: mocks.maybeScanExtraGatewayServices,
}));

vi.mock("../commands/doctor-auth-flat-profiles.js", () => ({
  maybeRepairLegacyFlatAuthProfileStores: mocks.maybeRepairLegacyFlatAuthProfileStores,
  maybeRepairCanonicalApiKeyFieldAlias: mocks.maybeRepairCanonicalApiKeyFieldAlias,
}));

vi.mock("../commands/doctor-gateway-daemon-flow.js", () => ({
  maybeRepairGatewayDaemon: mocks.maybeRepairGatewayDaemon,
}));

vi.mock("../commands/doctor-auth-legacy-oauth.js", () => ({
  maybeRepairLegacyOAuthProfileIds: mocks.maybeRepairLegacyOAuthProfileIds,
}));

vi.mock("../commands/doctor-auth-oauth-sidecar.js", () => ({
  maybeRepairLegacyOAuthSidecarProfiles: mocks.maybeRepairLegacyOAuthSidecarProfiles,
}));

vi.mock("../commands/doctor-auth.js", () => ({
  noteAuthProfileHealth: mocks.noteAuthProfileHealth,
  noteLegacyCodexProviderOverride: mocks.noteLegacyCodexProviderOverride,
}));

vi.mock("../gateway/call.js", () => ({
  buildGatewayConnectionDetails: mocks.buildGatewayConnectionDetails,
}));

vi.mock("../commands/doctor-platform-notes.js", () => ({
  noteMacLaunchAgentOverrides: mocks.noteMacLaunchAgentOverrides,
  noteMacLaunchctlGatewayEnvOverrides: mocks.noteMacLaunchctlGatewayEnvOverrides,
  noteMacStaleOpenClawUpdateLaunchdJobs: mocks.noteMacStaleOpenClawUpdateLaunchdJobs,
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
    readGatewaySecretInputValue: (...args: Parameters<typeof actual.readGatewaySecretInputValue>) =>
      mocks.readGatewaySecretInputValue.getMockImplementation()
        ? mocks.readGatewaySecretInputValue(...args)
        : actual.readGatewaySecretInputValue(...args),
  };
});

vi.mock("../commands/doctor-gateway-health.js", () => ({
  checkGatewayHealth: mocks.checkGatewayHealth,
  probeGatewayMemoryStatus: mocks.probeGatewayMemoryStatus,
}));

vi.mock("./health-check-registry.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./health-check-registry.js")>();
  return {
    ...actual,
    listHealthChecks: mocks.listHealthChecks,
    listExtensionHealthChecksForDoctor: (
      coreChecks: Parameters<typeof actual.listExtensionHealthChecksForDoctor>[0],
    ) => {
      const coreIds = new Set(coreChecks.map((check) => check.id));
      const registeredChecks = mocks.listHealthChecks() as readonly HealthCheck[];
      for (const check of registeredChecks) {
        if (check.id.startsWith("core/doctor/") || coreIds.has(check.id)) {
          throw new actual.HealthCheckRegistrationError(check.id);
        }
      }
      return registeredChecks.filter((check) => check.kind !== "core");
    },
    getHealthCheck: mocks.getHealthCheck,
    registerHealthCheck: mocks.registerHealthCheck,
  };
});

vi.mock("../commands/doctor-browser.js", () => ({
  noteChromeMcpBrowserReadiness: mocks.noteChromeMcpBrowserReadiness,
  detectLegacyClawdBrowserProfileResidue: mocks.detectLegacyClawdBrowserProfileResidue,
  maybeArchiveLegacyClawdBrowserProfileResidue: mocks.maybeArchiveLegacyClawdBrowserProfileResidue,
}));

vi.mock("../agents/agent-scope.js", () => ({
  resolveAgentWorkspaceDir: mocks.resolveAgentWorkspaceDir,
  resolveDefaultAgentId: mocks.resolveDefaultAgentId,
}));

vi.mock("../../packages/terminal-core/src/note.js", () => ({
  note: mocks.note,
}));

vi.mock("../agents/model-catalog.js", () => ({
  loadModelCatalog: mocks.loadModelCatalog,
}));

vi.mock("../agents/model-selection.js", () => ({
  getModelRefStatus: mocks.getModelRefStatus,
  resolveConfiguredModelRef: mocks.resolveConfiguredModelRef,
  resolveHooksGmailModel: mocks.resolveHooksGmailModel,
}));

vi.mock("../version.js", async () => ({
  ...(await vi.importActual<typeof import("../version.js")>("../version.js")),
  VERSION: "2026.5.2-test",
  resolveCompatibilityHostVersion: vi.fn(() => "2026.5.2-test"),
  resolveIsNixMode: vi.fn(() => false),
}));

vi.mock("../config/config.js", () => ({
  CONFIG_PATH: "/tmp/fake-openclaw.json",
  replaceConfigFile: mocks.replaceConfigFile,
  readConfigFileSnapshot: mocks.readConfigFileSnapshot,
}));

vi.mock("../commands/doctor-gateway-health.js", () => ({
  checkGatewayHealth: mocks.checkGatewayHealth,
  probeGatewayMemoryStatus: mocks.probeGatewayMemoryStatus,
}));

vi.mock("../cli/daemon-cli/status.gather.js", () => ({
  gatherDaemonStatus: mocks.gatherDaemonStatus,
}));

vi.mock("../commands/doctor-workspace-status.js", () => ({
  noteWorkspaceStatus: mocks.noteWorkspaceStatus,
}));

vi.mock("../commands/onboard-helpers.js", () => ({
  applyWizardMetadata: mocks.applyWizardMetadata,
  randomToken: vi.fn(() => "generated-gateway-token"),
}));

vi.mock("../config/logging.js", () => ({
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

vi.mock("../cli/command-format.js", () => ({
  formatCliCommand: mocks.formatCliCommand,
}));

function requireDoctorContribution(id: string) {
  const contribution = resolveDoctorHealthContributions().find((entry) => entry.id === id);
  if (!contribution) {
    throw new Error(`expected doctor contribution ${id}`);
  }
  return contribution;
}

function buildDoctorPrompter(shouldRepair: boolean): DoctorPrompter {
  return {
    confirm: vi.fn(async () => shouldRepair),
    confirmAutoFix: vi.fn(async () => shouldRepair),
    confirmAggressiveAutoFix: vi.fn(async () => shouldRepair),
    confirmRuntimeRepair: vi.fn(async () => shouldRepair),
    select: vi.fn(async (_params, fallback) => fallback),
    shouldRepair,
    shouldForce: false,
    repairMode: {
      shouldRepair,
      shouldForce: false,
      nonInteractive: true,
      canPrompt: false,
      updateInProgress: false,
    },
  };
}

describe("doctor health contributions", () => {
  beforeEach(() => {
    mocks.maybeRunConfiguredPluginInstallReleaseStep.mockReset();
    mocks.registerBundledHealthChecks.mockReset();
    mocks.runDoctorHealthRepairs.mockReset();
    mocks.maybeRepairLegacyFlatAuthProfileStores.mockClear();
    mocks.maybeRepairLegacyFlatAuthProfileStores.mockResolvedValue(undefined);
    mocks.maybeRepairCanonicalApiKeyFieldAlias.mockClear();
    mocks.maybeRepairCanonicalApiKeyFieldAlias.mockResolvedValue(undefined);
    mocks.maybeRepairGatewayDaemon.mockClear();
    mocks.maybeRepairGatewayDaemon.mockResolvedValue(undefined);
    mocks.maybeRepairLegacyOAuthProfileIds.mockClear();
    mocks.maybeRepairLegacyOAuthProfileIds.mockImplementation(async (cfg: unknown) => cfg);
    mocks.maybeRepairLegacyOAuthSidecarProfiles.mockClear();
    mocks.maybeRepairLegacyOAuthSidecarProfiles.mockResolvedValue(undefined);
    mocks.noteAuthProfileHealth.mockClear();
    mocks.noteAuthProfileHealth.mockResolvedValue(undefined);
    mocks.noteLegacyCodexProviderOverride.mockClear();
    mocks.buildGatewayConnectionDetails.mockClear();
    mocks.buildGatewayConnectionDetails.mockReturnValue({ message: "gateway details" });
    mocks.resolveSecretInputRef.mockClear();
    mocks.resolveGatewayAuth.mockClear();
    mocks.resolveGatewayAuth.mockReturnValue({ mode: "token", token: undefined });
    mocks.resolveGatewayAuthToken.mockClear();
    mocks.resolveGatewayAuthToken.mockResolvedValue({
      source: "unavailable",
      unresolvedRefReason: "exec provider failed",
    });
    mocks.getSkippedExecRefStaticError.mockClear();
    mocks.getSkippedExecRefStaticError.mockReturnValue(undefined);
    mocks.maybeRepairGatewayServiceConfig.mockClear();
    mocks.maybeRepairGatewayServiceConfig.mockResolvedValue(undefined);
    mocks.maybeScanExtraGatewayServices.mockClear();
    mocks.maybeScanExtraGatewayServices.mockResolvedValue(undefined);
    mocks.noteMacLaunchAgentOverrides.mockClear();
    mocks.noteMacLaunchctlGatewayEnvOverrides.mockClear();
    mocks.noteMacStaleOpenClawUpdateLaunchdJobs.mockClear();
    mocks.gatewaySecretInputPathCanWin.mockClear();
    mocks.gatewaySecretInputPathCanWin.mockReset();
    mocks.readGatewaySecretInputValue.mockClear();
    mocks.readGatewaySecretInputValue.mockReset();
    mocks.checkGatewayHealth.mockClear();
    mocks.checkGatewayHealth.mockResolvedValue({
      authenticated: true,
      healthOk: true,
      status: { ok: true },
    });
    mocks.probeGatewayMemoryStatus.mockClear();
    mocks.probeGatewayMemoryStatus.mockResolvedValue({
      checked: true,
      ready: true,
      skipped: false,
    });
    mocks.runDoctorHealthRepairs.mockResolvedValue({
      config: {},
      findings: [],
      remainingFindings: [],
      changes: [],
      warnings: [],
      diffs: [],
      effects: [],
      checksRun: 0,
      checksRepaired: 0,
      checksValidated: 0,
    });
    mocks.listHealthChecks.mockReset();
    mocks.listHealthChecks.mockReturnValue([
      { id: "core/example/internal", kind: "core" },
      { id: "plugin/example/unrelated", kind: "plugin" },
    ]);
    mocks.getHealthCheck.mockReset();
    mocks.getHealthCheck.mockReturnValue(undefined);
    mocks.registerHealthCheck.mockReset();
    mocks.noteChromeMcpBrowserReadiness.mockReset();
    mocks.noteChromeMcpBrowserReadiness.mockResolvedValue(undefined);
    mocks.detectLegacyClawdBrowserProfileResidue.mockReset();
    mocks.detectLegacyClawdBrowserProfileResidue.mockReturnValue(null);
    mocks.maybeArchiveLegacyClawdBrowserProfileResidue.mockReset();
    mocks.maybeArchiveLegacyClawdBrowserProfileResidue.mockResolvedValue({
      changes: [],
      warnings: [],
    });
    mocks.resolveAgentWorkspaceDir.mockReset();
    mocks.resolveAgentWorkspaceDir.mockReturnValue("/tmp/openclaw-workspace");
    mocks.resolveDefaultAgentId.mockReset();
    mocks.resolveDefaultAgentId.mockReturnValue("default");
    mocks.note.mockReset();
    mocks.loadModelCatalog.mockReset();
    mocks.loadModelCatalog.mockResolvedValue([]);
    mocks.getModelRefStatus.mockReset();
    mocks.getModelRefStatus.mockReturnValue({
      allowed: true,
      inCatalog: true,
      key: "openai/gpt-5.5",
    });
    mocks.resolveConfiguredModelRef.mockReset();
    mocks.resolveConfiguredModelRef.mockReturnValue({ provider: "openai", model: "gpt-5.5" });
    mocks.resolveHooksGmailModel.mockReset();
    mocks.resolveHooksGmailModel.mockReturnValue({ provider: "openai", model: "gpt-5.5" });
    mocks.readConfigFileSnapshot.mockReset();
    mocks.readConfigFileSnapshot.mockResolvedValue({
      exists: true,
      valid: true,
      config: {},
      issues: [],
    });
    mocks.checkGatewayHealth.mockReset();
    mocks.probeGatewayMemoryStatus.mockReset();
    mocks.gatherDaemonStatus.mockReset();
    mocks.gatherDaemonStatus.mockResolvedValue({});
    mocks.noteWorkspaceStatus.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("runs release configured plugin install repair before plugin registry and final config writes", () => {
    const ids = resolveDoctorHealthContributions().map((entry) => entry.id);

    expect(ids.indexOf("doctor:release-configured-plugin-installs")).toBeGreaterThan(-1);
    expect(ids.indexOf("doctor:plugin-registry")).toBeGreaterThan(-1);
    expect(ids.indexOf("doctor:release-configured-plugin-installs")).toBeLessThan(
      ids.indexOf("doctor:plugin-registry"),
    );
    expect(ids.indexOf("doctor:plugin-registry")).toBeLessThan(ids.indexOf("doctor:write-config"));
  });

  it("skips read-scope gateway probes when gateway health only proved reachability", async () => {
    mocks.checkGatewayHealth.mockResolvedValue({
      authenticated: false,
      healthOk: true,
      status: { ok: true },
    });
    const contribution = requireDoctorContribution(DOCTOR_GATEWAY_HEALTH_ID);
    const ctx = {
      cfg: {},
      configResult: { cfg: {} },
      sourceConfigValid: true,
      prompter: buildDoctorPrompter(false),
      runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
      options: {},
      cfgForPersistence: {},
      configPath: "/tmp/fake-openclaw.json",
      env: {},
    } as Parameters<(typeof contribution)["run"]>[0];

    await contribution.run(ctx);

    expect(ctx.healthOk).toBe(true);
    expect(ctx.gatewayHealthAuthenticated).toBe(false);
    expect(ctx.gatewayMemoryProbe).toEqual({ checked: false, ready: false, skipped: true });
    expect(mocks.probeGatewayMemoryStatus).not.toHaveBeenCalled();
  });

  it("skips remote gateway health probes for local fallback exec SecretRefs", async () => {
    mocks.checkGatewayHealth.mockResolvedValue({
      authenticated: false,
      healthOk: true,
      status: { ok: true },
    });
    mocks.gatewaySecretInputPathCanWin.mockImplementation(
      ({ path }: { path: string }) => path === "gateway.auth.token",
    );
    mocks.readGatewaySecretInputValue.mockReturnValue("exec-token");
    const contribution = requireDoctorContribution(DOCTOR_GATEWAY_HEALTH_ID);
    const cfg = {
      gateway: {
        mode: "remote",
        remote: {
          url: "wss://gateway.example",
        },
        auth: {
          mode: "token",
          token: { source: "exec", provider: "vault", id: "gateway/token" },
        },
      },
      secrets: {
        providers: {
          vault: { source: "exec", command: "/bin/false" },
        },
      },
    };
    const ctx = {
      cfg,
      configResult: { cfg },
      sourceConfigValid: true,
      prompter: buildDoctorPrompter(false),
      runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
      options: {},
      cfgForPersistence: cfg,
      configPath: "/tmp/fake-openclaw.json",
      env: {},
    } as Parameters<(typeof contribution)["run"]>[0];

    await contribution.run(ctx);

    expect(mocks.checkGatewayHealth).not.toHaveBeenCalled();
    expect(mocks.note).toHaveBeenCalledWith(
      expect.stringContaining("Gateway health probes skipped"),
      "Gateway",
    );
    expect(ctx.gatewayHealthSkipped).toBe(true);
    expect(ctx.gatewayMemoryProbe).toEqual({ checked: false, ready: false, skipped: true });
  });

  it("skips local gateway health probes for remote fallback exec SecretRefs", async () => {
    mocks.gatewaySecretInputPathCanWin.mockImplementation(
      ({ path }: { path: string }) => path === "gateway.remote.token",
    );
    mocks.readGatewaySecretInputValue.mockReturnValue("exec-token");
    const contribution = requireDoctorContribution(DOCTOR_GATEWAY_HEALTH_ID);
    const cfg = {
      gateway: {
        mode: "local",
        auth: {
          mode: "token",
        },
        remote: {
          token: { source: "exec", provider: "vault", id: "gateway/remote-token" },
        },
      },
      secrets: {
        providers: {
          vault: { source: "exec", command: "/bin/false" },
        },
      },
    };
    const ctx = {
      cfg,
      configResult: { cfg },
      sourceConfigValid: true,
      prompter: buildDoctorPrompter(false),
      runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
      options: {},
      cfgForPersistence: cfg,
      configPath: "/tmp/fake-openclaw.json",
      env: {},
    } as Parameters<(typeof contribution)["run"]>[0];

    await contribution.run(ctx);

    expect(mocks.checkGatewayHealth).not.toHaveBeenCalled();
    expect(mocks.note).toHaveBeenCalledWith(
      expect.stringContaining("Gateway health probes skipped"),
      "Gateway",
    );
    expect(ctx.gatewayHealthSkipped).toBe(true);
    expect(ctx.gatewayMemoryProbe).toEqual({ checked: false, ready: false, skipped: true });
  });

  it("keeps release configured plugin installs repair-only", async () => {
    const contribution = requireDoctorContribution("doctor:release-configured-plugin-installs");
    const ctx = {
      cfg: {},
      configResult: { cfg: {}, sourceLastTouchedVersion: "2026.4.29" },
      sourceConfigValid: true,
      prompter: buildDoctorPrompter(false),
      env: {},
    } as unknown as Parameters<(typeof contribution)["run"]>[0];

    await contribution.run(ctx);

    expect(mocks.maybeRunConfiguredPluginInstallReleaseStep).not.toHaveBeenCalled();
    expect(mocks.note).not.toHaveBeenCalled();
  });

  it("stamps release configured plugin installs after repair changes", async () => {
    mocks.maybeRunConfiguredPluginInstallReleaseStep.mockResolvedValue({
      changes: ["Installed configured plugin matrix."],
      warnings: [],
      touchedConfig: true,
    });
    const contribution = requireDoctorContribution("doctor:release-configured-plugin-installs");
    const ctx = {
      cfg: {},
      configResult: { cfg: {}, sourceLastTouchedVersion: "2026.4.29" },
      sourceConfigValid: true,
      prompter: buildDoctorPrompter(true),
      env: {},
    } as unknown as Parameters<(typeof contribution)["run"]>[0];

    await contribution.run(ctx);

    expect(mocks.maybeRunConfiguredPluginInstallReleaseStep).toHaveBeenCalledWith({
      cfg: {},
      env: {},
      touchedVersion: "2026.4.29",
    });
    expect(mocks.note).toHaveBeenCalledWith(
      "Installed configured plugin matrix.",
      "Doctor changes",
    );
    expect(ctx.cfg.meta?.lastTouchedVersion).toBe("2026.5.2-test");
  });

  it("keeps legacy parent writable release repairs old-parent-readable", async () => {
    mocks.maybeRunConfiguredPluginInstallReleaseStep.mockResolvedValue({
      changes: ["Installed configured plugin matrix."],
      warnings: [],
      touchedConfig: true,
    });
    const contribution = requireDoctorContribution("doctor:release-configured-plugin-installs");
    const ctx = {
      cfg: {},
      configResult: { cfg: {}, sourceLastTouchedVersion: "2026.5.16-beta.4" },
      sourceConfigValid: true,
      prompter: buildDoctorPrompter(true),
      runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
      options: {},
      cfgForPersistence: {},
      configPath: "/tmp/fake-openclaw.json",
      env: {
        OPENCLAW_UPDATE_IN_PROGRESS: "1",
        OPENCLAW_UPDATE_PARENT_SUPPORTS_DOCTOR_CONFIG_WRITE: "1",
      },
    } as unknown as Parameters<(typeof contribution)["run"]>[0];

    await contribution.run(ctx);

    expect(ctx.cfg.meta?.lastTouchedVersion).toBe("2026.5.16-beta.4");
    expect(ctx.cfg.meta?.lastTouchedAt).toEqual(expect.any(String));
  });

  it("checks command owner configuration before final config writes", () => {
    const ids = resolveDoctorHealthContributions().map((entry) => entry.id);

    expect(ids.indexOf("doctor:command-owner")).toBeGreaterThan(-1);
    expect(ids.indexOf("doctor:command-owner")).toBeLessThan(ids.indexOf("doctor:write-config"));
  });

  it("checks skill readiness before final config writes", () => {
    const ids = resolveDoctorHealthContributions().map((entry) => entry.id);

    expect(ids.indexOf("doctor:skills")).toBeGreaterThan(-1);
    expect(ids.indexOf("doctor:skills")).toBeLessThan(ids.indexOf("doctor:write-config"));
  });

  it("passes daemon-context plugin drift into the workspace status note", async () => {
    const contribution = requireDoctorContribution("doctor:workspace-status");
    const pluginVersionDrift = {
      gatewayVersion: "2026.6.1",
      drifts: [
        {
          pluginId: "codex",
          installedVersion: "2026.5.30-beta.1",
          gatewayVersion: "2026.6.1",
          source: "npm",
        },
      ],
    };
    mocks.gatherDaemonStatus.mockResolvedValueOnce({
      gateway: { version: "2026.6.1" },
      pluginVersionDrift,
    });
    const cfg = { plugins: { entries: { codex: { enabled: true } } } };

    await contribution.run({
      cfg,
      options: { nonInteractive: true },
    } as unknown as Parameters<(typeof contribution)["run"]>[0]);

    expect(mocks.gatherDaemonStatus).toHaveBeenCalledWith({
      rpc: {
        timeout: "3000",
        json: true,
      },
      probe: true,
      requireRpc: false,
      deep: false,
      allowExecSecretRefs: false,
    });
    expect(mocks.noteWorkspaceStatus).toHaveBeenCalledWith(cfg, { pluginVersionDrift });
  });

  it("omits daemon-context plugin drift when gateway version used the fallback", async () => {
    const contribution = requireDoctorContribution("doctor:workspace-status");
    const pluginVersionDrift = {
      gatewayVersion: "2026.5.2-test",
      drifts: [
        {
          pluginId: "codex",
          installedVersion: "2026.5.30-beta.1",
          gatewayVersion: "2026.5.2-test",
          source: "npm",
        },
      ],
    };
    mocks.gatherDaemonStatus.mockResolvedValueOnce({
      gateway: { version: null },
      pluginVersionDrift,
    });
    const cfg = { plugins: { entries: { codex: { enabled: true } } } };

    await contribution.run({
      cfg,
      options: { nonInteractive: true },
    } as unknown as Parameters<(typeof contribution)["run"]>[0]);

    expect(mocks.noteWorkspaceStatus).toHaveBeenCalledWith(cfg, {
      pluginVersionDrift: undefined,
    });
  });

  it("omits daemon-context plugin drift when probe auth was skipped", async () => {
    const contribution = requireDoctorContribution("doctor:workspace-status");
    const pluginVersionDrift = {
      gatewayVersion: "2026.6.1",
      drifts: [
        {
          pluginId: "codex",
          installedVersion: "2026.5.30-beta.1",
          gatewayVersion: "2026.6.1",
          source: "npm",
        },
      ],
    };
    mocks.gatherDaemonStatus.mockResolvedValueOnce({
      gateway: {},
      rpc: { authWarning: "exec SecretRef probe auth skipped" },
      pluginVersionDrift,
    });
    const cfg = { plugins: { entries: { codex: { enabled: true } } } };

    await contribution.run({
      cfg,
      options: { nonInteractive: true },
    } as unknown as Parameters<(typeof contribution)["run"]>[0]);

    expect(mocks.noteWorkspaceStatus).toHaveBeenCalledWith(cfg, {
      pluginVersionDrift: undefined,
    });
  });

  it("skips daemon-context plugin drift probes for remote gateway mode", async () => {
    const contribution = requireDoctorContribution("doctor:workspace-status");
    const cfg = {
      gateway: { mode: "remote" },
      plugins: { entries: { codex: { enabled: true } } },
    };

    await contribution.run({
      cfg,
      options: { nonInteractive: true },
    } as unknown as Parameters<(typeof contribution)["run"]>[0]);

    expect(mocks.gatherDaemonStatus).not.toHaveBeenCalled();
    expect(mocks.noteWorkspaceStatus).toHaveBeenCalledWith(cfg, {
      pluginVersionDrift: undefined,
    });
  });

  it("lets daemon status decide exec SecretRef probing from daemon config", async () => {
    const contribution = requireDoctorContribution("doctor:workspace-status");
    const pluginVersionDrift = {
      gatewayVersion: "2026.6.1",
      drifts: [
        {
          pluginId: "codex",
          installedVersion: "2026.5.30-beta.1",
          gatewayVersion: "2026.6.1",
          source: "npm",
        },
      ],
    };
    mocks.gatherDaemonStatus.mockResolvedValueOnce({
      gateway: { version: "2026.6.1" },
      pluginVersionDrift,
    });
    const cfg = {
      gateway: {
        auth: {
          mode: "token",
          token: {
            source: "exec",
            provider: "vault",
            id: "gateway/token",
          },
        },
      },
    };

    await contribution.run({
      cfg,
      options: { nonInteractive: true },
    } as unknown as Parameters<(typeof contribution)["run"]>[0]);

    expect(mocks.gatherDaemonStatus).toHaveBeenCalledWith({
      rpc: {
        timeout: "3000",
        json: true,
      },
      probe: true,
      requireRpc: false,
      deep: false,
      allowExecSecretRefs: false,
    });
    expect(mocks.noteWorkspaceStatus).toHaveBeenCalledWith(cfg, { pluginVersionDrift });
  });

  it("ignores remote-only exec SecretRefs for local daemon-context plugin drift probes", async () => {
    const contribution = requireDoctorContribution("doctor:workspace-status");
    const cfg = {
      gateway: {
        auth: {
          mode: "token",
        },
        remote: {
          token: {
            source: "exec",
            provider: "vault",
            id: "gateway/remote-token",
          },
        },
      },
    };

    await contribution.run({
      cfg,
      options: { nonInteractive: true },
    } as unknown as Parameters<(typeof contribution)["run"]>[0]);

    expect(mocks.gatherDaemonStatus).toHaveBeenCalledWith({
      rpc: {
        timeout: "3000",
        json: true,
      },
      probe: true,
      requireRpc: false,
      deep: false,
      allowExecSecretRefs: false,
    });
  });

  it("uses the read-only model catalog for hooks.gmail.model warnings", async () => {
    const contribution = requireDoctorContribution("doctor:hooks-model");
    const cfg = {
      hooks: {
        gmail: {
          model: "openai/gpt-5.5",
        },
      },
    };
    const ctx = {
      cfg,
      options: {},
    } as unknown as Parameters<(typeof contribution)["run"]>[0];

    await contribution.run(ctx);

    expect(mocks.loadModelCatalog).toHaveBeenCalledWith({ config: cfg, readOnly: true });
  });

  it("repairs heartbeat templates before final config writes", () => {
    const ids = resolveDoctorHealthContributions().map((entry) => entry.id);

    expect(ids.indexOf("doctor:heartbeat-template-repair")).toBeGreaterThan(-1);
    expect(ids.indexOf("doctor:heartbeat-template-repair")).toBeLessThan(
      ids.indexOf("doctor:write-config"),
    );
  });

  it("preserves allow-exec Gateway SecretRef resolution in auth health", async () => {
    const contribution = requireDoctorContribution("doctor:gateway-auth");
    const ctx = {
      cfg: {
        gateway: {
          mode: "local",
          auth: { mode: "token", token: "exec-token" },
        },
      },
      sourceConfigValid: true,
      prompter: buildDoctorPrompter(false),
      runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
      options: { allowExec: true, nonInteractive: true },
      env: { OPENCLAW_TEST_GATEWAY_TOKEN: "1" },
    } as unknown as Parameters<(typeof contribution)["run"]>[0];

    await contribution.run(ctx);

    expect(mocks.resolveGatewayAuthToken).toHaveBeenCalledWith(
      expect.objectContaining({
        cfg: ctx.cfg,
        env: ctx.env,
        unresolvedReasonStyle: "detailed",
        envFallback: "never",
      }),
    );
    expect(mocks.note).toHaveBeenCalledWith(
      expect.stringContaining(
        "Gateway token SecretRef could not be resolved: exec provider failed",
      ),
      "Gateway auth",
    );
  });

  it("forwards allow-exec to Gateway service repair", async () => {
    const contribution = requireDoctorContribution("doctor:gateway-services");
    const ctx = {
      cfg: { gateway: { mode: "local" } },
      sourceConfigValid: true,
      prompter: buildDoctorPrompter(true),
      runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
      options: { allowExec: true },
    } as unknown as Parameters<(typeof contribution)["run"]>[0];

    await contribution.run(ctx);

    expect(mocks.maybeRepairGatewayServiceConfig).toHaveBeenCalledWith(
      ctx.cfg,
      "local",
      ctx.runtime,
      ctx.prompter,
      { allowExecSecretRefs: true },
    );
  });

  it("skips Gateway health probes for exec SecretRefs unless allow-exec is set", async () => {
    const contribution = requireDoctorContribution("doctor:gateway-health");
    mocks.gatewaySecretInputPathCanWin.mockImplementation(
      ({ path }: { path: string }) => path === "gateway.auth.token",
    );
    mocks.readGatewaySecretInputValue.mockReturnValue("exec-token");
    const ctx = {
      cfg: {
        gateway: {
          mode: "local",
          auth: { mode: "token", token: "exec-token" },
        },
      },
      sourceConfigValid: true,
      prompter: buildDoctorPrompter(false),
      runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
      options: { nonInteractive: true },
    } as unknown as Parameters<(typeof contribution)["run"]>[0];

    await contribution.run(ctx);

    expect(mocks.checkGatewayHealth).not.toHaveBeenCalled();
    expect(ctx.gatewayHealthSkipped).toBe(true);
    expect(ctx.gatewayMemoryProbe).toEqual({ checked: false, ready: false, skipped: true });
    expect(mocks.note).toHaveBeenCalledWith(
      expect.stringContaining("Gateway health probes skipped"),
      "Gateway",
    );
  });

  it("keeps canonical api_key alias repair wired through auth profile health", async () => {
    const contribution = requireDoctorContribution("doctor:auth-profiles");
    const ctx = {
      cfg: {},
      sourceConfigValid: true,
      prompter: buildDoctorPrompter(true),
      runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
      options: { nonInteractive: true },
    } as unknown as Parameters<(typeof contribution)["run"]>[0];

    await contribution.run(ctx);

    expect(mocks.maybeRepairLegacyFlatAuthProfileStores).toHaveBeenCalledWith({
      cfg: ctx.cfg,
      prompter: ctx.prompter,
    });
    expect(mocks.maybeRepairCanonicalApiKeyFieldAlias).toHaveBeenCalledWith({
      cfg: ctx.cfg,
      prompter: ctx.prompter,
    });
  });

  it("forwards skipped Gateway health to daemon repair", async () => {
    const contribution = requireDoctorContribution("doctor:gateway-daemon");
    const ctx = {
      cfg: {},
      gatewayDetails: { message: "gateway details" },
      gatewayHealthSkipped: true,
      healthOk: false,
      sourceConfigValid: true,
      prompter: buildDoctorPrompter(true),
      runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
      options: { nonInteractive: true },
    } as unknown as Parameters<(typeof contribution)["run"]>[0];

    await contribution.run(ctx);

    expect(mocks.maybeRepairGatewayDaemon).toHaveBeenCalledWith(
      expect.objectContaining({
        cfg: ctx.cfg,
        runtime: ctx.runtime,
        prompter: ctx.prompter,
        options: ctx.options,
        gatewayDetailsMessage: "gateway details",
        healthOk: false,
        healthSkipped: true,
      }),
    );
  });

  it("keeps implemented core health checks owned by ordered doctor contributions", async () => {
    const coreIds = CORE_HEALTH_CHECKS.map((check) => check.id);
    const contributionIds = resolveDoctorHealthContributions().flatMap(
      (entry) => entry.healthCheckIds,
    );
    const contributionChecks = await resolveDoctorContributionHealthChecks();

    for (const coreId of coreIds) {
      expect(contributionIds).toContain(coreId);
    }
    expect(contributionIds).toContain("core/doctor/sandbox/registry-files");
    expect(contributionIds).toContain("core/doctor/gateway-services/extra");
    expect(contributionIds).toContain("core/doctor/config-audit-scrub");
    expect(contributionIds).toContain("core/doctor/session-transcripts");
    expect(contributionIds).toContain("core/doctor/session-snapshots");
    expect(contributionChecks.map((check) => check.id)).toEqual(contributionIds);
  });

  it("uses legacy run when a contribution also declares structured health", async () => {
    const legacyRun = vi.fn();
    const healthChecks = {
      description: "test legacy precedence",
      detect: vi.fn(async () => []),
    };
    const contribution = createDoctorHealthContribution({
      id: "doctor:test-legacy-wins",
      label: "Test legacy wins",
      healthChecks,
      run: legacyRun,
    });
    const ctx = {
      cfg: {},
      cfgForPersistence: {},
      configResult: { cfg: {} },
      sourceConfigValid: true,
      prompter: buildDoctorPrompter(true),
      runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
      options: {},
      configPath: "/tmp/fake-openclaw.json",
    } as unknown as Parameters<(typeof contribution)["run"]>[0];

    await contribution.run(ctx);

    expect(legacyRun).toHaveBeenCalledWith(ctx);
    expect(mocks.runDoctorHealthRepairs).not.toHaveBeenCalled();
    expect(contribution.healthCheckIds).toEqual(["core/doctor/test-legacy-wins"]);
    expect(contribution.healthChecks).toMatchObject([
      {
        id: "core/doctor/test-legacy-wins",
        kind: "core",
        source: "doctor",
      },
    ]);
  });

  it("lets structured health own execution when legacy run is omitted", async () => {
    const healthChecks = {
      description: "test structured run",
      detect: vi.fn(async () => []),
    };
    mocks.runDoctorHealthRepairs.mockResolvedValue({
      config: { updated: true },
      findings: [],
      remainingFindings: [],
      changes: ["changed from structured health"],
      warnings: ["structured warning"],
      diffs: [],
      effects: [],
      checksRun: 1,
      checksRepaired: 1,
      checksValidated: 0,
    });
    const contribution = createDoctorHealthContribution({
      id: "doctor:test-structured-run",
      label: "Test structured run",
      healthChecks,
    });
    const ctx = {
      cfg: {},
      cfgForPersistence: {},
      configResult: { cfg: {} },
      sourceConfigValid: true,
      prompter: buildDoctorPrompter(true),
      runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
      options: {},
      configPath: "/tmp/fake-openclaw.json",
    } as unknown as Parameters<(typeof contribution)["run"]>[0];

    await contribution.run(ctx);

    expect(mocks.runDoctorHealthRepairs).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd: "/tmp/openclaw-workspace",
        configPath: "/tmp/fake-openclaw.json",
      }),
      {
        checks: contribution.healthChecks,
        dryRun: false,
      },
    );
    expect(ctx.cfg).toEqual({ updated: true });
    expect(ctx.cfgForPersistence).toEqual({});
    expect(ctx.runtime.error).toHaveBeenCalledWith("structured warning");
    expect(ctx.runtime.log).toHaveBeenCalledWith("changed from structured health");
  });

  it("renders findings from structured health when legacy run is omitted", async () => {
    const healthChecks = {
      description: "test structured findings",
      detect: vi.fn(async () => []),
    };
    mocks.runDoctorHealthRepairs.mockResolvedValue({
      config: {},
      findings: [
        {
          checkId: "core/doctor/test-structured-findings",
          severity: "warning",
          message: "structured finding needs attention",
          path: "openclaw.json",
          line: 12,
          fixHint: "run openclaw doctor --fix",
        },
      ],
      remainingFindings: [],
      changes: [],
      warnings: [],
      diffs: [],
      effects: [],
      checksRun: 1,
      checksRepaired: 0,
      checksValidated: 0,
    });
    const contribution = createDoctorHealthContribution({
      id: "doctor:test-structured-findings",
      label: "Test structured findings",
      healthChecks,
    });
    const ctx = {
      cfg: {},
      cfgForPersistence: {},
      configResult: { cfg: {} },
      sourceConfigValid: true,
      prompter: buildDoctorPrompter(false),
      runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
      options: {},
      configPath: "/tmp/fake-openclaw.json",
    } as unknown as Parameters<(typeof contribution)["run"]>[0];

    await contribution.run(ctx);

    expect(ctx.runtime.log).toHaveBeenCalledWith(
      "[warning] core/doctor/test-structured-findings openclaw.json:12 - structured finding needs attention",
    );
    expect(ctx.runtime.log).toHaveBeenCalledWith("  fix: run openclaw doctor --fix");
  });

  it("runs structured-only contributions in dry-run mode when doctor is not repairing", async () => {
    const healthChecks = {
      description: "test structured dry-run",
      detect: vi.fn(async () => []),
    };
    const contribution = createDoctorHealthContribution({
      id: "doctor:test-structured-dry-run",
      label: "Test structured dry-run",
      healthChecks,
    });
    const ctx = {
      cfg: {},
      cfgForPersistence: {},
      configResult: { cfg: {} },
      sourceConfigValid: true,
      prompter: buildDoctorPrompter(false),
      runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
      options: {},
      configPath: "/tmp/fake-openclaw.json",
    } as unknown as Parameters<(typeof contribution)["run"]>[0];

    await contribution.run(ctx);

    expect(mocks.runDoctorHealthRepairs).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: "/tmp/openclaw-workspace" }),
      {
        checks: contribution.healthChecks,
        dryRun: true,
      },
    );
  });

  it("requires explicit health check ids for multi-check contributions", () => {
    expect(() =>
      createDoctorHealthContribution({
        id: "doctor:test-multiple-checks",
        label: "Test multiple checks",
        healthChecks: [
          {
            description: "first",
            detect: vi.fn(async () => []),
          },
          {
            description: "second",
            detect: vi.fn(async () => []),
          },
        ],
      }),
    ).toThrow("must specify health check ids when it declares multiple healthChecks");
  });

  it("repairs browser residue before browser readiness notes", async () => {
    const calls: string[] = [];
    mocks.runDoctorHealthRepairs.mockImplementation(async () => {
      calls.push("repair");
      return {
        config: {},
        findings: [],
        remainingFindings: [],
        changes: [],
        warnings: [],
        diffs: [],
        effects: [],
        checksRun: 1,
        checksRepaired: 1,
        checksValidated: 0,
      };
    });
    mocks.noteChromeMcpBrowserReadiness.mockImplementation(async () => {
      calls.push("note");
    });
    const contribution = requireDoctorContribution("doctor:browser");
    const ctx = {
      cfg: {},
      cfgForPersistence: {},
      configResult: { cfg: {} },
      sourceConfigValid: true,
      prompter: buildDoctorPrompter(true),
      runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
      options: {},
      configPath: "/tmp/fake-openclaw.json",
    } as unknown as Parameters<(typeof contribution)["run"]>[0];

    await contribution.run(ctx);

    expect(calls).toEqual(["repair", "note"]);
  });

  it("runs structured repairs before legacy skill repairs and config writes", () => {
    const ids = resolveDoctorHealthContributions().map((entry) => entry.id);

    expect(ids.indexOf("doctor:structured-health-repairs")).toBeGreaterThan(-1);
    expect(ids.indexOf("doctor:structured-health-repairs")).toBeLessThan(
      ids.indexOf("doctor:skills"),
    );
    expect(ids.indexOf("doctor:structured-health-repairs")).toBeLessThan(
      ids.indexOf("doctor:write-config"),
    );
  });

  it("keeps core-kind repairs out of the extension repair pass", async () => {
    const contribution = requireDoctorContribution("doctor:structured-health-repairs");
    const ctx = {
      cfg: {},
      configResult: { cfg: {} },
      sourceConfigValid: true,
      prompter: buildDoctorPrompter(true),
      runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
      options: {},
      cfgForPersistence: {},
      configPath: "/tmp/fake-openclaw.json",
      env: {},
    } as unknown as Parameters<(typeof contribution)["run"]>[0];

    await contribution.run(ctx);

    expect(mocks.runDoctorHealthRepairs).toHaveBeenCalledWith(expect.any(Object), {
      checks: [{ id: "plugin/example/unrelated", kind: "plugin" }],
    });
  });

  it("rejects extension repairs that claim reserved core doctor ids", async () => {
    mocks.listHealthChecks.mockReturnValue([
      { id: "plugin/example/unrelated", kind: "plugin" },
      { id: "core/doctor/shell-completion", kind: "plugin" },
    ]);
    const contribution = requireDoctorContribution("doctor:structured-health-repairs");
    const ctx = {
      cfg: {},
      configResult: { cfg: {} },
      sourceConfigValid: true,
      prompter: buildDoctorPrompter(true),
      runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
      options: {},
      cfgForPersistence: {},
      configPath: "/tmp/fake-openclaw.json",
      env: {},
    } as unknown as Parameters<(typeof contribution)["run"]>[0];

    await expect(contribution.run(ctx)).rejects.toThrow(
      "health check already registered: core/doctor/shell-completion",
    );
    expect(mocks.runDoctorHealthRepairs).not.toHaveBeenCalled();
  });

  it("rejects registered core-kind repairs that claim reserved core doctor ids", async () => {
    mocks.listHealthChecks.mockReturnValue([
      { id: "plugin/example/unrelated", kind: "plugin" },
      { id: "core/doctor/shell-completion", kind: "core" },
    ]);
    const contribution = requireDoctorContribution("doctor:structured-health-repairs");
    const ctx = {
      cfg: {},
      configResult: { cfg: {} },
      sourceConfigValid: true,
      prompter: buildDoctorPrompter(true),
      runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
      options: {},
      cfgForPersistence: {},
      configPath: "/tmp/fake-openclaw.json",
      env: {},
    } as unknown as Parameters<(typeof contribution)["run"]>[0];

    await expect(contribution.run(ctx)).rejects.toThrow(
      "health check already registered: core/doctor/shell-completion",
    );
    expect(mocks.runDoctorHealthRepairs).not.toHaveBeenCalled();
  });

  it("reports runtime tool schema blockers during normal doctor runs", async () => {
    const contribution = requireDoctorContribution("doctor:runtime-tool-schemas");
    mocks.getHealthCheck.mockReturnValue({
      id: "core/doctor/runtime-tool-schemas",
      detect: vi.fn(async () => [
        {
          checkId: "core/doctor/runtime-tool-schemas",
          severity: "error",
          message:
            "Tool fuzzplugin_move_angles from plugin fuzzplugin has an unsupported input schema for runtime projection.",
          path: "plugins.entries.fuzzplugin",
          target: "fuzzplugin_move_angles",
          requirement: 'fuzzplugin_move_angles.parameters.type must be "object"',
          fixHint:
            "Disable or update the offending plugin/tool so its parameters are a JSON object schema, then rerun doctor.",
        },
      ]),
    });
    const ctx = {
      cfg: {},
      configResult: { cfg: {} },
      sourceConfigValid: true,
      prompter: buildDoctorPrompter(false),
      runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
      options: {},
      cfgForPersistence: {},
      configPath: "/tmp/fake-openclaw.json",
      env: {},
    } as unknown as Parameters<(typeof contribution)["run"]>[0];

    await contribution.run(ctx);

    expect(ctx.healthOk).toBe(false);
    expect(mocks.note).toHaveBeenCalledWith(
      expect.stringContaining("Tool fuzzplugin_move_angles from plugin fuzzplugin"),
      "Doctor warnings",
    );
    expect(mocks.note).toHaveBeenCalledWith(
      expect.stringContaining('issue: fuzzplugin_move_angles.parameters.type must be "object"'),
      "Doctor warnings",
    );
  });

  it("reports provider catalog projection blockers during normal doctor runs", async () => {
    const contribution = requireDoctorContribution("doctor:provider-catalog-projection");
    mocks.getHealthCheck.mockReturnValue({
      id: "core/doctor/provider-catalog-projection",
      detect: vi.fn(async () => [
        {
          checkId: "core/doctor/provider-catalog-projection",
          severity: "error",
          message:
            "Provider catalog mockplugin cannot be projected into the unified text model catalog.",
          path: "plugins.entries.mockplugin",
          target: "mockplugin",
          requirement: "provider catalog entry read failed",
          fixHint:
            "Fix the plugin provider catalog hook or disable the plugin, then rerun doctor before relying on model discovery.",
        },
      ]),
    });
    const ctx = {
      cfg: {},
      configResult: { cfg: {} },
      sourceConfigValid: true,
      prompter: buildDoctorPrompter(false),
      runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
      options: {},
      cfgForPersistence: {},
      configPath: "/tmp/fake-openclaw.json",
      env: {},
    } as Parameters<(typeof contribution)["run"]>[0];

    await contribution.run(ctx);

    expect(ctx.healthOk).toBe(false);
    expect(mocks.note).toHaveBeenCalledWith(
      expect.stringContaining("Provider catalog mockplugin cannot be projected"),
      "Doctor warnings",
    );
    expect(mocks.note).toHaveBeenCalledWith(
      expect.stringContaining("issue: provider catalog entry read failed"),
      "Doctor warnings",
    );
  });

  it("skips doctor config writes under legacy update parents", () => {
    expect(
      shouldSkipLegacyUpdateDoctorConfigWrite({
        env: { OPENCLAW_UPDATE_IN_PROGRESS: "1" },
      }),
    ).toBe(true);
  });

  it("keeps doctor writes outside legacy update writable", () => {
    expect(
      shouldSkipLegacyUpdateDoctorConfigWrite({
        env: {},
      }),
    ).toBe(false);
  });

  it("keeps current update parents writable", () => {
    expect(
      shouldSkipLegacyUpdateDoctorConfigWrite({
        env: {
          OPENCLAW_UPDATE_IN_PROGRESS: "1",
          OPENCLAW_UPDATE_PARENT_SUPPORTS_DOCTOR_CONFIG_WRITE: "1",
        },
      }),
    ).toBe(false);
  });

  it("treats falsey update env values as normal writes", () => {
    expect(
      shouldSkipLegacyUpdateDoctorConfigWrite({
        env: {
          OPENCLAW_UPDATE_IN_PROGRESS: "0",
        },
      }),
    ).toBe(false);
  });

  describe("config size drops during update", () => {
    beforeEach(() => {
      mocks.replaceConfigFile.mockReset();
      mocks.replaceConfigFile.mockResolvedValue(undefined);
      mocks.applyWizardMetadata.mockImplementation((cfg: unknown) => cfg);
      vi.spyOn(fs, "existsSync").mockReturnValue(false);
    });

    function buildWriteConfigCtx(env: Record<string, string | undefined>) {
      const cfg = { gateway: { mode: "local" } };
      return {
        cfg,
        cfgForPersistence: { gateway: { mode: "remote" } },
        configResult: {
          cfg,
          shouldWriteConfig: true,
          skipPluginValidationOnWrite: false,
        },
        configPath: "/tmp/fake-openclaw.json",
        sourceConfigValid: true,
        prompter: buildDoctorPrompter(true),
        runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
        options: {},
        env,
      } as Parameters<(typeof writeConfigContribution)["run"]>[0];
    }

    const writeConfigContribution = resolveDoctorHealthContributions().find(
      (entry) => entry.id === "doctor:write-config",
    )!;

    it("allows config size drops when OPENCLAW_UPDATE_IN_PROGRESS=1", async () => {
      const ctx = buildWriteConfigCtx({
        OPENCLAW_UPDATE_IN_PROGRESS: "1",
        OPENCLAW_UPDATE_PARENT_SUPPORTS_DOCTOR_CONFIG_WRITE: "1",
      });
      await writeConfigContribution.run(ctx);
      expect(mocks.replaceConfigFile).toHaveBeenCalledWith(
        expect.objectContaining({
          writeOptions: expect.objectContaining({
            allowConfigSizeDrop: true,
          }),
        }),
      );
    });

    it("skips plugin schema validation during update doctor writes", async () => {
      const ctx = buildWriteConfigCtx({
        OPENCLAW_UPDATE_IN_PROGRESS: "1",
        OPENCLAW_UPDATE_PARENT_SUPPORTS_DOCTOR_CONFIG_WRITE: "1",
      });
      await writeConfigContribution.run(ctx);
      expect(mocks.replaceConfigFile).toHaveBeenCalledWith(
        expect.objectContaining({
          writeOptions: expect.objectContaining({
            skipPluginValidation: true,
          }),
        }),
      );
    });

    it("preserves source config version for legacy parent writable update doctor writes", async () => {
      const ctx = buildWriteConfigCtx({
        OPENCLAW_UPDATE_IN_PROGRESS: "1",
        OPENCLAW_UPDATE_PARENT_SUPPORTS_DOCTOR_CONFIG_WRITE: "1",
      });
      ctx.configResult.sourceLastTouchedVersion = "2026.5.16-beta.4";

      await writeConfigContribution.run(ctx);

      expect(mocks.replaceConfigFile).toHaveBeenCalledWith(
        expect.objectContaining({
          writeOptions: expect.objectContaining({
            lastTouchedVersionOverride: "2026.5.16-beta.4",
          }),
        }),
      );
    });

    it("does not preserve source config version for explicit deferral update doctors", async () => {
      const ctx = buildWriteConfigCtx({
        OPENCLAW_UPDATE_IN_PROGRESS: "1",
        OPENCLAW_UPDATE_DEFER_CONFIGURED_PLUGIN_INSTALL_REPAIR: "1",
        OPENCLAW_UPDATE_PARENT_SUPPORTS_DOCTOR_CONFIG_WRITE: "1",
      });
      ctx.configResult.sourceLastTouchedVersion = "2026.5.16-beta.4";

      await writeConfigContribution.run(ctx);

      expect(mocks.replaceConfigFile).toHaveBeenCalledWith(
        expect.objectContaining({
          writeOptions: expect.not.objectContaining({
            lastTouchedVersionOverride: expect.anything(),
          }),
        }),
      );
    });

    it("keeps plugin schema validation for ordinary doctor writes", async () => {
      const ctx = buildWriteConfigCtx({});
      await writeConfigContribution.run(ctx);
      expect(mocks.replaceConfigFile).toHaveBeenCalledWith(
        expect.objectContaining({
          writeOptions: expect.objectContaining({
            skipPluginValidation: false,
          }),
        }),
      );
    });

    it("points update-time config rewrites at the pre-update backup", async () => {
      vi.mocked(fs.existsSync).mockImplementation((value) => String(value).endsWith(".pre-update"));
      const ctx = buildWriteConfigCtx({
        OPENCLAW_UPDATE_IN_PROGRESS: "1",
        OPENCLAW_UPDATE_PARENT_SUPPORTS_DOCTOR_CONFIG_WRITE: "1",
      });

      await writeConfigContribution.run(ctx);

      expect(ctx.runtime.log).toHaveBeenCalledWith(
        "Update changed config; pre-update backup: /tmp/fake-openclaw.json.pre-update",
      );
    });

    it("skips plugin schema validation for final validation during update doctor runs", async () => {
      const contribution = requireDoctorContribution("doctor:final-config-validation");

      await contribution.run({
        cfg: {},
        cfgForPersistence: {},
        configResult: { cfg: {} },
        configPath: "/tmp/fake-openclaw.json",
        sourceConfigValid: true,
        prompter: buildDoctorPrompter(true),
        runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
        options: {},
        env: {
          OPENCLAW_UPDATE_IN_PROGRESS: "1",
        },
      } as Parameters<(typeof contribution)["run"]>[0]);

      expect(mocks.readConfigFileSnapshot).toHaveBeenCalledWith({
        skipPluginValidation: true,
      });
    });

    it("keeps plugin schema validation for ordinary doctor final validation", async () => {
      const contribution = requireDoctorContribution("doctor:final-config-validation");

      await contribution.run({
        cfg: {},
        cfgForPersistence: {},
        configResult: { cfg: {} },
        configPath: "/tmp/fake-openclaw.json",
        sourceConfigValid: true,
        prompter: buildDoctorPrompter(true),
        runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
        options: {},
        env: {},
      } as Parameters<(typeof contribution)["run"]>[0]);

      expect(mocks.readConfigFileSnapshot).toHaveBeenCalledWith({
        skipPluginValidation: false,
      });
    });

    it("allows allowConfigSizeDrop when not in update", async () => {
      const ctx = buildWriteConfigCtx({});
      await writeConfigContribution.run(ctx);
      expect(mocks.replaceConfigFile).toHaveBeenCalledWith(
        expect.objectContaining({
          writeOptions: expect.objectContaining({
            allowConfigSizeDrop: true,
          }),
        }),
      );
    });
  });
});
