import { afterEach, beforeEach, vi } from "vitest";
import type { UpdateRunResult } from "../../infra/update-runner.js";
import type { captureTargetDatabaseSchemaContext } from "./schema-preflight.js";
import type { executeMutableUpdate } from "./update-command-execution.js";
import type { PreManagedServiceStop } from "./update-command-service.js";

const mocks = vi.hoisted(() => ({
  captureManagedContext: vi.fn(),
  captureManagedPreflight:
    vi.fn<
      typeof import("./update-command-managed-context.js").captureOwnedManagedUpdatePreflightContext
    >(),
  captureSchemaContext:
    vi.fn<typeof import("./schema-preflight.js").captureTargetDatabaseSchemaContext>(),
  checkTargetSchemas:
    vi.fn<typeof import("./schema-preflight.js").checkTargetDatabaseSchemasForContexts>(),
  formatSchemaRefusalLines: vi.fn(),
  hasSchemaRefusal: vi.fn(),
  maybeRestartService: vi.fn(),
  maybeStopService: vi.fn(),
  prepareMutableUpdate: vi.fn<(env?: NodeJS.ProcessEnv) => Promise<void>>(),
  pluginPreflight: vi.fn(),
  pluginTargets: vi.fn(),
  pluginRecords: vi.fn(),
  npmMetadata: vi.fn(),
  readGitRecovery: vi.fn(),
  runGitUpdate: vi.fn(),
  runPackageUpdate: vi.fn(),
  runtimeError: vi.fn(),
  revalidateSchemaContext:
    vi.fn<typeof import("./update-command-managed-context.js").revalidateUpdateDatabaseContext>(),
  validateCanary: vi.fn(),
  nativeSupport:
    vi.fn<
      typeof import("./update-command-service-command.js").isUpdatedInstallGatewayExecutorSupported
    >(),
  serviceStopped: false,
  shouldBlockServiceUpdate: vi.fn(),
  verifyPackageRecovery: vi.fn(),
}));

vi.mock("./update-command-service-command.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./update-command-service-command.js")>()),
  isUpdatedInstallGatewayExecutorSupported: mocks.nativeSupport,
}));

afterEach(() => vi.restoreAllMocks());

vi.mock("../../infra/update-global.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../infra/update-global.js")>()),
  verifyPackageUpdateRecovery: mocks.verifyPackageRecovery,
}));
vi.mock("../../infra/update-candidate-canary.js", () => ({
  validateUpdateCandidateCanary: mocks.validateCanary,
}));

vi.mock("./update-command-plugin-preflight.js", () => ({
  preflightConfiguredNpmPluginTargets: mocks.pluginPreflight,
}));

vi.mock("../../commands/doctor/shared/missing-configured-plugin-install.targets.js", () => ({
  collectConfiguredNpmPluginTargets: mocks.pluginTargets,
}));
vi.mock("../../plugins/installed-plugin-index-records.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../plugins/installed-plugin-index-records.js")>()),
  loadInstalledPluginIndexInstallRecords: mocks.pluginRecords,
}));
vi.mock("../../infra/install-source-utils.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../infra/install-source-utils.js")>()),
  resolveNpmSpecMetadata: mocks.npmMetadata,
}));

vi.mock("../../infra/update-runner-git-recovery.js", () => ({
  readCurrentGitUpdateRecovery: mocks.readGitRecovery,
}));

vi.mock("../../runtime.js", () => ({
  defaultRuntime: { error: mocks.runtimeError },
}));

vi.mock("./schema-preflight.js", () => ({
  captureTargetDatabaseSchemaContext: mocks.captureSchemaContext,
  checkTargetDatabaseSchemasForContexts: mocks.checkTargetSchemas,
  formatSchemaRefusalLines: mocks.formatSchemaRefusalLines,
  hasSchemaRefusal: mocks.hasSchemaRefusal,
}));

vi.mock("./update-command-git.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./update-command-git.js")>()),
  updateGitInstall: mocks.runGitUpdate,
}));

vi.mock("./update-command-handoff.js", () => ({
  formatUpdateAncestryBlockMessage: (message: string) => message,
  handoffUpdateFromGateway: vi.fn(),
}));

vi.mock("./update-command-managed-context.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./update-command-managed-context.js")>()),
  captureOwnedManagedUpdateContext: mocks.captureManagedContext,
  captureOwnedManagedUpdatePreflightContext: mocks.captureManagedPreflight,
  revalidateUpdateDatabaseContext: mocks.revalidateSchemaContext,
}));

vi.mock("./update-command-package.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./update-command-package.js")>()),
  runPackageInstallUpdate: mocks.runPackageUpdate,
}));

vi.mock("./update-command-service.js", async () => {
  const actual = await vi.importActual<typeof import("./update-command-service-maintenance.js")>(
    "./update-command-service-maintenance.js",
  );
  const { resolveUpdatedGatewayRestartPort } = await import("./update-command-service-plan.js");
  return {
    maybeRestartServiceAfterFailedMutableUpdate: mocks.maybeRestartService,
    maybeStopManagedServiceBeforeMutableUpdate: mocks.maybeStopService,
    shouldBlockMutableUpdateFromGatewayServiceEnv: mocks.shouldBlockServiceUpdate,
    UpdateCommandAbort: actual.UpdateCommandAbort,
    resolveUpdatedGatewayRestartPort,
  };
});

const successfulUpdate: UpdateRunResult = {
  status: "ok",
  mode: "npm",
  root: "/opt/openclaw",
  before: { version: "1.0.0" },
  after: { version: "1.0.1" },
  steps: [],
  durationMs: 1,
};

function executionParams(
  updateInstallKind: "git" | "package",
): Parameters<typeof executeMutableUpdate>[0] {
  return {
    root: "/opt/openclaw",
    installKind: updateInstallKind,
    updateInstallKind,
    switchToGit: false,
    timeoutMs: 30_000,
    updateStepTimeoutMs: 30_000,
    startedAt: 1,
    progress: {},
    stop: vi.fn(),
    channel: "stable",
    tag: "1.0.1",
    opts: { json: true },
    shouldRestart: true,
    packageInstallSpec: "openclaw@1.0.1",
    packageTargetVersion: "1.0.1",
    managedServiceRootRedirect: null,
    invocationCwd: "/work",
    recoveryState: { triageTarget: { env: {} } },
    prepareMutableUpdate: mocks.prepareMutableUpdate,
    packageTargetSchemaVersions: { state: 15, agent: 19 },
  };
}

function schemaContext(
  profile: string,
): Awaited<ReturnType<typeof captureTargetDatabaseSchemaContext>> {
  const env = { OPENCLAW_PROFILE: profile };
  return {
    env,
    readEnv: { ...env },
    config: {},
    configSnapshot: {
      path: `/fixture/${profile}/openclaw.json`,
      exists: true,
      raw: "{}",
      parsed: {},
      resolved: {},
      sourceConfig: {},
      config: {},
      runtimeConfig: {},
      valid: true,
      issues: [],
      warnings: [],
      legacyIssues: [],
    },
  };
}

function inspectOrStopService(phase: "inspect" | "prepare" = "prepare"): PreManagedServiceStop {
  const running = !mocks.serviceStopped;
  if (phase === "prepare") {
    mocks.serviceStopped = true;
  }
  return {
    stopped: phase === "prepare",
    inspected: true,
    runtimeInspected: true,
    running,
    serviceEnv: { OPENCLAW_PROFILE: "default" },
    serviceUpdateVerdict: {
      kind: "owned",
      root: "/opt/openclaw",
      fingerprint: "service-fingerprint",
      refreshDefinition: false,
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.serviceStopped = false;
  mocks.validateCanary.mockResolvedValue({
    status: "ok",
    phase: "readiness",
    steps: [],
    durationMs: 1,
    logTail: [],
  });
  mocks.captureManagedContext.mockResolvedValue(undefined);
  mocks.captureManagedPreflight.mockResolvedValue(schemaContext("default"));
  mocks.captureSchemaContext.mockResolvedValue(schemaContext("invoker"));
  mocks.revalidateSchemaContext.mockImplementation(async (context) => context);
  mocks.checkTargetSchemas.mockResolvedValue({ incompatible: [], indeterminate: [] });
  mocks.formatSchemaRefusalLines.mockReturnValue(["schema refused"]);
  mocks.hasSchemaRefusal.mockImplementation(
    (schemas) => schemas.incompatible.length > 0 || schemas.indeterminate.length > 0,
  );
  mocks.maybeRestartService.mockResolvedValue(undefined);
  mocks.maybeStopService.mockImplementation(async ({ phase }) => inspectOrStopService(phase));
  mocks.prepareMutableUpdate.mockResolvedValue(undefined);
  mocks.pluginPreflight.mockResolvedValue([]);
  mocks.readGitRecovery.mockResolvedValue({ serviceRestartSafe: true });
  mocks.runGitUpdate.mockResolvedValue({ ...successfulUpdate, mode: "git" });
  mocks.runPackageUpdate.mockResolvedValue(successfulUpdate);
  mocks.shouldBlockServiceUpdate.mockReturnValue(false);
  mocks.verifyPackageRecovery.mockResolvedValue({ serviceRestartSafe: true });
});

export { executionParams, inspectOrStopService, mocks, schemaContext, successfulUpdate };
