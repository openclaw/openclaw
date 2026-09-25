import { afterEach, beforeEach, expect, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type {
  maybeStopManagedServiceBeforeMutableUpdate,
  PreManagedServiceStop,
  revalidateManagedGatewayServiceAfterUpdate,
} from "../cli/update-cli/update-command-service-maintenance.js";
import type { GatewayService, readGatewayServiceState } from "../daemon/service.js";
import type { recordUpdateRunStep, finishUpdateRun } from "../infra/update-run-ledger.js";
import { resolveCommandProcessSignal, retainCommandProcessCleanup } from "../process/exec-spawn.js";
import { createDeferredCore } from "../shared/deferred.js";
import type { readActiveOpenClawAgentDatabaseLeasesReadOnly } from "../state/openclaw-agent-db-lease.js";
import { beginDoctorMaintenance } from "./doctor-maintenance.js";

const boundary = vi.hoisted(() => ({
  external: vi.fn(),
  readLeases: vi.fn<typeof readActiveOpenClawAgentDatabaseLeasesReadOnly>(),
  gatewayAcquire: vi.fn(),
  admission: vi.fn(),
  authority: vi.fn(),
  scopeAssert: undefined as undefined | (() => void),
  stateAcquire: vi.fn(),
  schemas: vi.fn(),
  lease: vi.fn(),
  step: vi.fn<typeof recordUpdateRunStep>(),
  finish: vi.fn<typeof finishUpdateRun>(),
  owner: vi.fn(),
  sleep: vi.fn(),
  stop: vi.fn<typeof maybeStopManagedServiceBeforeMutableUpdate>(),
  read: vi.fn<typeof readGatewayServiceState>(),
  command: vi.fn<GatewayService["readCommand"]>(),
  revalidate: vi.fn<typeof revalidateManagedGatewayServiceAfterUpdate>(),
  repair: vi.fn(async () => ({})),
  restart: vi.fn(),
  health: vi.fn(),
  resume: vi.fn(),
  complete: vi.fn(),
  close: vi.fn(),
  release: vi.fn(),
  unlock: vi.fn(),
  log: vi.fn(),
  native: vi.fn(() => {
    throw new Error("Doctor settlement controls cannot start or inspect native processes");
  }),
}));

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawn: boundary.native,
  spawnSync: boundary.native,
  fork: boundary.native,
  exec: boundary.native,
  execSync: boundary.native,
  execFile: boundary.native,
  execFileSync: boundary.native,
}));
vi.mock("../config/paths.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../config/paths.js")>()),
  isDefaultInstallIdentity: () => true,
}));
vi.mock("../config/config.js", () => ({
  readConfigFileSnapshot: async () => ({ config: {} }),
}));
vi.mock("./doctor-service-repair-policy.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./doctor-service-repair-policy.js")>()),
  shouldManageGatewayService: async () => true,
  isServiceRepairExternallyManaged: boundary.external,
  resolveUpdateParentGatewayActivation: () => undefined,
}));
vi.mock("./doctor-update-refusal.js", () => ({
  recordUpdateDoctorRefusal: vi.fn(),
  resolveUpdateDoctorGitRecovery: async () => undefined,
}));
vi.mock("../infra/update-run-ledger.js", () => ({
  listUpdateRuns: () => [],
  recordUpdateRunRepairContinuation: vi.fn(),
  createUpdateRun: () => ({ runId: "typed-refusal-run" }),
  adoptUpdateRun: vi.fn(),
  finishUpdateRun: boundary.finish,
  heartbeatUpdateRun: vi.fn(),
  recordUpdateRunDiagnostic: vi.fn(),
  recordUpdateRunPhase: vi.fn(),
  recordUpdateRunStep: boundary.step,
}));
vi.mock("../infra/update-run-activity.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/update-run-activity.js")>()),
  inspectUpdateRepairDriverAdmission: boundary.admission,
}));
vi.mock("../utils/sleep.js", () => ({ sleep: boundary.sleep }));
vi.mock("node:timers/promises", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:timers/promises")>()),
  setTimeout: boundary.sleep,
}));
vi.mock("../infra/gateway-owner-lease.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/gateway-owner-lease.js")>()),
  readGatewayOwnerLease: boundary.owner,
}));
vi.mock("../infra/state-database-coordinator.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/state-database-coordinator.js")>()),
  acquireGatewayMaintenanceCoordinator: boundary.gatewayAcquire,
  acquireStateDatabaseCoordinator: boundary.stateAcquire,
}));
vi.mock("../state/openclaw-state-db-async-lifecycle.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../state/openclaw-state-db-async-lifecycle.js")>()),
  createOpenClawDatabaseMaintenanceScope: () => ({
    run: <T>(operation: () => T) => operation(),
    close: boundary.close,
  }),
}));
vi.mock("../state/openclaw-agent-db-lease.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../state/openclaw-agent-db-lease.js")>()),
  assertNoOpenClawAgentDatabaseLeasesReadOnly: boundary.lease,
  readActiveOpenClawAgentDatabaseLeasesReadOnly: boundary.readLeases,
}));
vi.mock("../state/openclaw-database-preflight.js", () => ({
  preflightOpenClawDatabaseSchemas: boundary.schemas,
  assertOpenClawDatabasesReady: async () => {},
}));
vi.mock("../cli/update-cli/update-command-service-maintenance.js", () => ({
  maybeStopManagedServiceBeforeMutableUpdate: boundary.stop,
  maybeResumeWindowsTaskAutoStartAfterPackageUpdate: boundary.resume,
  revalidateManagedGatewayServiceAfterUpdate: boundary.revalidate,
}));
vi.mock("../daemon/service.js", () => ({
  resolveGatewayService: () => ({ readCommand: boundary.command, restart: boundary.restart }),
  readGatewayServiceState: boundary.read,
}));
vi.mock("../daemon/service-operation-lock.js", () => ({
  withGatewayServiceOperationLock: async (
    _env: NodeJS.ProcessEnv,
    run: (assertCurrent: () => void) => Promise<unknown>,
  ) => {
    const previous = boundary.scopeAssert;
    let active = true;
    const assertCurrent = () => {
      if (!active) {
        throw new Error("native operation custody retired");
      }
      boundary.authority();
    };
    boundary.scopeAssert = assertCurrent;
    try {
      return await run(assertCurrent);
    } finally {
      active = false;
      boundary.scopeAssert = previous;
      boundary.unlock();
    }
  },
}));
vi.mock("./doctor-gateway-services.js", () => ({
  maybeRepairGatewayServiceConfig: boundary.repair,
}));
vi.mock("./doctor-prompter.js", () => ({ createDoctorPrompter: () => ({}) }));
vi.mock("../cli/update-cli/update-command-service-plan.js", () => ({
  resolveUpdatedGatewayRestartPort: async () => 18789,
}));
vi.mock("../cli/daemon-cli/restart-health.js", async () => ({
  waitForGatewayHealthyRestart: boundary.health,
  renderRestartDiagnostics: (await import("../cli/daemon-cli/restart-health-diagnostics.js"))
    .renderRestartDiagnostics,
}));

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const root = "/synthetic/doctor-install";
let stopped: PreManagedServiceStop;
beforeEach(() => {
  vi.resetAllMocks();
  boundary.external.mockReturnValue(false);
  boundary.readLeases.mockReturnValue([]);
  boundary.schemas.mockResolvedValue({ indeterminate: [] });
  boundary.scopeAssert = undefined;
  boundary.admission.mockReturnValue({ kind: "recovery", runs: [] });
  boundary.stateAcquire.mockImplementation(() => ({ release: boundary.release }));
  boundary.gatewayAcquire.mockImplementation(() => ({
    release: boundary.release,
    createSchemaFenceDelegate: vi.fn(),
  }));
  vi.stubEnv("OPENCLAW_STATE_DIR", "/synthetic/doctor-state");
  vi.stubEnv("OPENCLAW_CONFIG_PATH", "/synthetic/doctor-state/openclaw.json");
  vi.stubEnv("OPENCLAW_UPDATE_RUN_ID", undefined);
  vi.spyOn(process, "kill").mockImplementation(boundary.native);
  const serviceEnv = {
    OPENCLAW_STATE_DIR: "/synthetic/doctor-state",
    OPENCLAW_CONFIG_PATH: "/synthetic/doctor-state/openclaw.json",
  };
  const verdict = {
    kind: "owned" as const,
    root,
    fingerprint: "fixture",
    refreshDefinition: false,
  };
  stopped = {
    stopped: true,
    inspected: true,
    runtimeInspected: true,
    running: false,
    offline: true,
    serviceEnv,
    serviceUpdateVerdict: verdict,
    windowsTaskAutoStartRecovery: {
      suspended: Promise.resolve(true),
      beginMutation: () => {},
      restore: async () => {},
      handoff: () => {},
      complete: boundary.complete,
      interrupted: () => false,
    },
  };
  boundary.stop.mockImplementation(async (params) => {
    if (params.phase === "inspect") {
      return { ...stopped, stopped: false, running: true, offline: false };
    }
    params.onStopped?.(stopped);
    return stopped;
  });
  const command = { programArguments: ["/synthetic/node", `${root}/openclaw.mjs`, "gateway"] };
  boundary.command.mockResolvedValue(command);
  boundary.revalidate.mockResolvedValue(verdict);
  boundary.read.mockResolvedValue({
    installed: true,
    running: false,
    env: serviceEnv,
    command,
    loadState: { status: "loaded" },
    runtime: { status: "stopped" },
  });
  boundary.health.mockResolvedValue({ healthy: true });
  boundary.native.mockImplementation(() => {
    throw new Error("Doctor settlement controls cannot start or inspect native processes");
  });
});
afterEach(() => {
  try {
    expect(boundary.native).not.toHaveBeenCalled();
  } finally {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  }
});

function begin(assertCurrent?: () => void) {
  return beginDoctorMaintenance({
    root,
    options: { repair: true, nonInteractive: true },
    runtime: { log: boundary.log, error: vi.fn(), exit: vi.fn() },
    assertCurrent,
  });
}

function cleanupBarrier() {
  const cleanup = createDeferredCore<"forced" | "uncertain">();
  const joining = createDeferredCore();
  return {
    cleanup,
    joining: joining.promise,
    retain() {
      retainCommandProcessCleanup(cleanup.promise);
      resolveCommandProcessSignal()?.addEventListener("abort", () => joining.resolve(), {
        once: true,
      });
    },
  };
}

export { begin, boundary, cleanupBarrier, root, stopped, tempDirs };
