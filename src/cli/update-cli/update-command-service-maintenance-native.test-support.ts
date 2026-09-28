import { vi } from "vitest";
import type { ConfigFileSnapshot } from "../../config/types.openclaw.js";
import { createFreeBsdPkgOwnershipInspection } from "../../infra/update-freebsd-pkg-ownership.js";
import type { UpdateCommandOptions } from "./shared.js";

const command = vi.hoisted(() => ({
  prepare: vi.fn<typeof import("./update-command-run.js").prepareUpdateCommand>(),
  admit: vi.fn<typeof import("./update-command-run.js").admitUpdateCommandRun>(),
  target: vi.fn<typeof import("./update-command-target.js").resolveUpdateCommandTarget>(),
  finish: vi.fn<typeof import("./update-command-post-update.js").finishUpdate>(),
}));

// Keep admission's caller, executor, activation sequence, and native stop real.
// Package preparation and finalization are outside this stop-authority contract.
vi.mock("./update-command-run.js", async (original) => ({
  ...(await original<typeof import("./update-command-run.js")>()),
  prepareUpdateCommand: command.prepare,
  admitUpdateCommandRun: command.admit,
  resolveUpdateCommandAdmissionEnv: async () => process.env,
  prepareMutableUpdateRuntime: async () => ({}),
}));
vi.mock("./update-command-initialization.js", () => ({
  updateStateNeedsInitialization: async () => false,
}));
vi.mock("./update-command-target.js", () => ({ resolveUpdateCommandTarget: command.target }));
vi.mock("../../infra/update-retained-runtime.js", () => ({
  withRetainedUpdateRuntime: async <T>(
    _url: string,
    operation: (retain: () => Promise<void>) => Promise<T>,
  ) => operation(async () => {}),
}));
vi.mock("./update-command-triage.js", () => ({
  withUpdateFailureTriage: async <T>(_opts: unknown, _target: unknown, run: () => Promise<T>) =>
    run(),
}));
vi.mock("./update-command-unwind.js", () => ({
  withUpdateCommandRecoveryUnwind: async <T>(
    _opts: unknown,
    _recovery: unknown,
    run: () => Promise<T>,
  ) => run(),
}));
vi.mock("./update-command-terminal.js", async (original) => ({
  ...(await original<typeof import("./update-command-terminal.js")>()),
  withUpdateCommandTerminalResult: async <T>(run: (register: () => void) => Promise<T>) =>
    run(() => {}),
}));
vi.mock("./update-command-schema.js", () => ({
  preflightUpdateCommandSchemas: async () => ({ preflightNotes: [], preflightFailures: [] }),
  captureUpdateActivationSchemas: async () => ({}),
}));
vi.mock("./update-command-database-context.js", () => ({
  inspectUpdateDatabaseContexts: async () => ({ services: new Map() }),
  revalidateUpdateDatabaseContexts: async (_params: unknown, context: unknown) => context,
}));
vi.mock("./update-command-managed-context.js", async (original) => ({
  ...(await original<typeof import("./update-command-managed-context.js")>()),
  captureOwnedManagedUpdateContext: async () => undefined,
  readUpdateCandidateSource: async () => ({ config: {} }),
}));
vi.mock("./update-command-node-runtime.js", () => ({
  preparePackageUpdateRuntime: async () => ({ ok: true, value: { nodeRunner: process.execPath } }),
}));
vi.mock("./update-command-original-service.js", () => ({
  observeOriginalManagedServiceRuntime: async () => undefined,
}));
vi.mock("./update-command-verification.js", () => ({
  verifyPreviousManagedGatewayForUpdate: async () => {},
}));
vi.mock("./update-command-package.js", () => ({
  runPackageInstallUpdate: async (
    params: Parameters<typeof import("./update-command-package.js").runPackageInstallUpdate>[0],
  ) => {
    await params.beforeActivate?.();
    return { status: "ok", mode: "npm", root: params.root, steps: [], durationMs: 0 };
  },
  preparePackageDoctorContext: () => undefined,
}));
vi.mock("../../infra/update-global.js", async (original) => ({
  ...(await original<typeof import("../../infra/update-global.js")>()),
  verifyPackageUpdateRecovery: async () => ({ serviceRestartSafe: true }),
}));
vi.mock("./update-execution.runtime.js", async () => ({
  executeMutableUpdate: (await import("./update-command-execution.js")).executeMutableUpdate,
  finishUpdate: command.finish,
  finishAlreadyCurrentUpdate: () => {
    throw new Error("Unexpected already-current update");
  },
  continueMigratedUpdateInFreshProcess: () => {
    throw new Error("Unexpected migrated update");
  },
  inspectActivatedUpdateState: async () => undefined,
}));

export async function runNativeMaintenanceUpdate(
  root: string,
  runId: string,
  handoffId: string,
  serviceRoot?: string,
) {
  const snapshot: ConfigFileSnapshot = {
    path: `${process.env.HOME}/.openclaw/openclaw.json`,
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
  };
  const run: NonNullable<UpdateCommandOptions["run"]> = { runId, env: process.env };
  command.prepare.mockResolvedValue({
    startedAt: Date.now(),
    postCoreUpdateResume: false,
    postCoreUpdateChannel: undefined,
    timeoutMs: undefined,
    shouldRestart: true,
    requestedChannel: null,
    devTarget: undefined,
    controlPlaneUpdateSentinelMeta: { root, runId, handoffId },
    discoveredRoot: root,
    installKind: "package",
    servicePlan: serviceRoot ? { rootRedirect: null, serviceRoot } : undefined,
    pkgOwnership: createFreeBsdPkgOwnershipInspection(),
  });
  command.admit.mockResolvedValue(run);
  command.target.mockResolvedValue({
    root,
    mode: "npm",
    updateInstallKind: "package",
    refuseUpdate: async () => {},
    configSnapshot: snapshot,
    configReadFailure: undefined,
    legacyConfigPlan: undefined,
    storedChannel: null,
    requestedChannel: null,
    channel: "stable",
    explicitTag: null,
    switchToGit: false,
    switchToPackage: false,
    tag: "2026.9.6",
    currentVersion: "2026.9.5",
    targetVersion: "2026.9.6",
    downgradeRisk: false,
    fallbackToLatest: false,
    packageInstallSpec: "/synthetic/candidate.tgz",
    packageInstallEnv: undefined,
    packageInstallTarget: undefined,
    packageAlreadyCurrent: false,
    packageTargetSchemaVersions: undefined,
    packageRuntimeTarget: undefined,
    managedServiceRootRedirect: null,
    managedServiceRoot: serviceRoot,
    managedServiceNodeRunner: undefined,
    packageUpdateNodeRunner: undefined,
    devTarget: undefined,
  });
  command.finish.mockReset().mockImplementation(async ({ result }) => {
    if (result.status === "error") {
      throw new Error(`${result.reason}: ${result.steps.at(-1)?.stderrTail}`);
    }
    return result;
  });
  const { updateCommand } = await import("./update-command.js");
  await updateCommand({ yes: true, json: true, admission: "installed" });
}
