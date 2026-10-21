import { afterEach, beforeEach, vi } from "vitest";
import { createTestConfigSnapshot } from "../../commands/test-runtime-config-helpers.js";
import * as gatewayBindings from "../../daemon/managed-gateway-bindings.js";
import type { UpdateRunResult } from "../../infra/update-runner-types.js";
import type * as schema from "./schema-preflight.js";
import type { executeMutableUpdate } from "./update-command-execution.js";
import type * as managed from "./update-command-managed-context.js";
import type * as serviceCommand from "./update-command-service-command.js";
import type { PreManagedServiceStop } from "./update-command-service.js";

type ExecutionParams = Parameters<typeof executeMutableUpdate>[0];
const mocks = vi.hoisted(() => ({
  captureManagedContext: vi.fn(),
  captureManagedPreflight: vi.fn<typeof managed.captureOwnedManagedUpdatePreflightContext>(),
  captureSchemaContext: vi.fn<typeof schema.captureTargetDatabaseSchemaContext>(),
  checkTargetSchemas: vi.fn<typeof schema.checkTargetDatabaseSchemasForContexts>(),
  formatSchemaRefusalLines: vi.fn(),
  hasSchemaRefusal: vi.fn(),
  maybeRestartService: vi.fn(),
  maybeStopService: vi.fn(),
  prepareMutableUpdate: vi.fn<ExecutionParams["prepareMutableUpdate"]>(),
  pluginPreflight: vi.fn(),
  pluginTargets: vi.fn(),
  pluginRecords: vi.fn(),
  npmMetadata: vi.fn(),
  readGitRecovery: vi.fn(),
  runGitUpdate: vi.fn(),
  runPackageUpdate: vi.fn(),
  runtimeError: vi.fn(),
  validateCanary: vi.fn(),
  nativeSupport: vi.fn<typeof serviceCommand.isUpdatedInstallGatewayExecutorSupported>(),
  serviceStopped: false,
  shouldBlockServiceUpdate: vi.fn(),
  verifyPackageRecovery: vi.fn(),
}));

export { mocks };

vi.mock(import("./update-command-service-command.js"), async (original) => ({
  ...(await original()),
  isUpdatedInstallGatewayExecutorSupported: mocks.nativeSupport,
}));

afterEach(() => vi.restoreAllMocks());

vi.mock(import("../../infra/update-global.js"), async (original) => ({
  ...(await original()),
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
vi.mock(import("../../plugins/installed-plugin-index-records.js"), async (original) => ({
  ...(await original()),
  loadInstalledPluginIndexInstallRecords: mocks.pluginRecords,
}));
vi.mock(import("../../infra/install-source-utils.js"), async (original) => ({
  ...(await original()),
  resolveNpmSpecMetadata: mocks.npmMetadata,
}));

vi.mock(import("../../infra/update-runner-git-recovery.js"), async (original) => ({
  ...(await original()),
  readCurrentGitUpdateRecovery: mocks.readGitRecovery,
}));

vi.mock("../../runtime.js", () => ({
  defaultRuntime: { error: mocks.runtimeError },
}));

vi.mock(import("./schema-preflight.js"), async (original) => ({
  ...(await original()),
  captureTargetDatabaseSchemaContext: mocks.captureSchemaContext,
  checkTargetDatabaseSchemasForContexts: mocks.checkTargetSchemas,
  formatSchemaRefusalLines: mocks.formatSchemaRefusalLines,
  hasSchemaRefusal: mocks.hasSchemaRefusal,
}));

vi.mock(import("./update-command-git.js"), async (original) => ({
  ...(await original()),
  updateGitInstall: mocks.runGitUpdate,
}));

vi.mock(import("./update-command-handoff.js"), async (original) => ({
  ...(await original()),
  formatUpdateAncestryBlockMessage: (message: string) => message,
  handoffUpdateFromGateway: vi.fn(),
}));

vi.mock(import("./update-command-managed-context.js"), async (original) => ({
  ...(await original()),
  captureOwnedManagedUpdateContext: mocks.captureManagedContext,
  captureOwnedManagedUpdatePreflightContext: mocks.captureManagedPreflight,
}));

vi.mock(import("./update-command-package.js"), async (original) => ({
  ...(await original()),
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
    mutableUpdateGatewayServiceBlock: mocks.shouldBlockServiceUpdate,
    UpdateCommandAbort: actual.UpdateCommandAbort,
    resolveUpdatedGatewayRestartPort,
  };
});

export const successfulUpdate: UpdateRunResult = {
  status: "ok",
  mode: "npm",
  root: "/opt/openclaw",
  before: { version: "1.0.0" },
  after: { version: "1.0.1" },
  steps: [],
  durationMs: 1,
};

export function executionParams(
  updateInstallKind: "git" | "package",
): Omit<ExecutionParams, "executionGuards"> {
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

export async function bindExecutionGuards(
  params: Omit<ExecutionParams, "executionGuards">,
): Promise<ExecutionParams> {
  const finalParams = { ...params };
  const { createUpdateCommandExecutionGuards: createGuards } =
    await import("./update-command-execution-guards.js");
  return {
    ...finalParams,
    executionGuards: createGuards(finalParams.opts, finalParams.root),
  };
}

export function schemaContext(
  profile: string,
): Awaited<ReturnType<typeof schema.captureTargetDatabaseSchemaContext>> {
  const env = { OPENCLAW_PROFILE: profile };
  return {
    env,
    readEnv: { ...env },
    config: {},
    configSnapshot: createTestConfigSnapshot({}, {}, `/fixture/${profile}/openclaw.json`),
  };
}

export function inspectOrStopService(
  phase: "inspect" | "prepare" = "prepare",
): PreManagedServiceStop {
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
  vi.spyOn(gatewayBindings, "discoverManagedGatewayBindings").mockResolvedValue([]);
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
