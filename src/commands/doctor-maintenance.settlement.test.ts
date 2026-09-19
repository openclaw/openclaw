import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type {
  maybeStopManagedServiceBeforeMutableUpdate,
  PreManagedServiceStop,
} from "../cli/update-cli/update-command-service-maintenance.js";
import { UpdateFinalizationLifecycle } from "../cli/update-cli/update-finalization-lifecycle.js";
import type { GatewayService, readGatewayServiceState } from "../daemon/service.js";
import { collectNestedErrorCandidates } from "../infra/error-graph-internal.js";
import {
  collectUpdateDoctorFailureFacts,
  consumeUpdatePostInstallDoctorResult,
  createUpdatePostInstallDoctorResultPath,
  UpdateDoctorError,
  writeUpdatePostInstallDoctorResult,
} from "../infra/update-doctor-result.js";
import { projectPublicUpdateFailureIdentifiers } from "../infra/update-failure-public-identifiers.js";
import type { recordUpdateRunStep, finishUpdateRun } from "../infra/update-run-ledger.js";
import { redactPublicSupportDiagnosticLine } from "../logging/diagnostic-support-redaction.js";
import { hasCommandProcessCleanupError } from "../process/exec-result.js";
import { resolveCommandProcessSignal, retainCommandProcessCleanup } from "../process/exec-spawn.js";
import { defaultRuntime } from "../runtime.js";
import { createDeferredCore } from "../shared/deferred.js";
import { OpenClawAgentDatabaseLeaseActiveError } from "../state/openclaw-agent-db-lease.js";
import { beginDoctorMaintenance } from "./doctor-maintenance.js";

const boundary = vi.hoisted(() => ({
  lease: vi.fn(),
  step: vi.fn<typeof recordUpdateRunStep>(),
  finish: vi.fn<typeof finishUpdateRun>(),
  stop: vi.fn<typeof maybeStopManagedServiceBeforeMutableUpdate>(),
  read: vi.fn<typeof readGatewayServiceState>(),
  command: vi.fn<GatewayService["readCommand"]>(),
  revalidate: vi.fn(),
  restart: vi.fn(),
  health: vi.fn(),
  resume: vi.fn(),
  complete: vi.fn(),
  close: vi.fn(),
  release: vi.fn(),
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
vi.mock("./doctor-service-repair-policy.js", () => ({
  shouldManageGatewayService: async () => true,
  isServiceRepairExternallyManaged: () => false,
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
vi.mock("../infra/state-database-coordinator.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/state-database-coordinator.js")>()),
  acquireGatewayMaintenanceCoordinator: () => ({
    release: boundary.release,
    createSchemaFenceDelegate: vi.fn(),
  }),
  acquireStateDatabaseCoordinator: () => ({ release: boundary.release }),
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
}));
vi.mock("../state/openclaw-database-preflight.js", () => ({
  preflightOpenClawDatabaseSchemas: async () => ({ indeterminate: [] }),
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
  ) => run(() => {}),
}));
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
  vi.stubEnv("OPENCLAW_STATE_DIR", "/synthetic/doctor-state");
  vi.stubEnv("OPENCLAW_CONFIG_PATH", "/synthetic/doctor-state/openclaw.json");
  vi.stubEnv("OPENCLAW_UPDATE_RUN_ID", undefined);
  vi.spyOn(process, "kill").mockImplementation(boundary.native);
  const serviceEnv = {
    OPENCLAW_STATE_DIR: "/synthetic/doctor-state",
    OPENCLAW_CONFIG_PATH: "/synthetic/doctor-state/openclaw.json",
  };
  stopped = {
    stopped: true,
    inspected: true,
    runtimeInspected: true,
    running: false,
    offline: true,
    serviceEnv,
    serviceUpdateVerdict: { kind: "owned", root, fingerprint: "fixture", refreshDefinition: false },
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

function begin() {
  return beginDoctorMaintenance({
    root,
    options: { repair: true, nonInteractive: true },
    runtime: { log: boundary.log, error: vi.fn(), exit: vi.fn() },
  });
}

it("leaves a progressing Gateway running and warns after the readiness cap", async () => {
  boundary.health.mockResolvedValue({
    healthy: false,
    staleGatewayPids: [],
    runtime: { status: "running", pid: 4242 },
    portUsage: { port: 18789, status: "free", listeners: [], hints: [] },
    waitOutcome: "still-starting",
    elapsedMs: 300_000,
    startupPhase: "startup migration",
  });
  const maintenance = await begin();
  expect(maintenance).toBeDefined();

  await expect(maintenance!.finish({})).resolves.toBeUndefined();

  const warning = expect.stringMatching(
    /still starting after 300s.*startup migration.*openclaw gateway status --deep/,
  );
  expect(maintenance!.warnings).toContainEqual(warning);
  expect(boundary.log).toHaveBeenCalledWith(warning);
  expect(boundary.log).not.toHaveBeenCalledWith(
    "Gateway restarted and verified after Doctor repair.",
  );
  expect(boundary.restart).toHaveBeenCalledOnce();
});

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

it.each(["forced", "uncertain"] as const)(
  "joins failed maintenance admission before compensating (%s)",
  async (cleanup) => {
    const barrier = cleanupBarrier();
    const original = new Error("service stop failed after parking the Gateway");
    const stop = boundary.stop.getMockImplementation()!;
    boundary.stop.mockImplementation(async (params) => {
      const result = await stop(params);
      if (params.phase !== "inspect") {
        barrier.retain();
        throw original;
      }
      return result;
    });
    const work = begin().catch((error: unknown) => error);
    try {
      await Promise.race([
        barrier.joining,
        work.then(() => {
          throw new Error("Admission compensated before physical cleanup joined");
        }),
      ]);
      expect(boundary.resume).not.toHaveBeenCalled();
      expect(boundary.complete).not.toHaveBeenCalled();
      expect(boundary.restart).not.toHaveBeenCalled();
      expect(boundary.release).not.toHaveBeenCalled();
    } finally {
      barrier.cleanup.resolve(cleanup);
      await work;
    }
    const error = await work;
    expect(collectNestedErrorCandidates(error)).toContain(original);
    expect(hasCommandProcessCleanupError(error)).toBe(cleanup === "uncertain");
    expect(boundary.restart).toHaveBeenCalledTimes(cleanup === "forced" ? 1 : 0);
    expect(boundary.resume).toHaveBeenCalledTimes(cleanup === "forced" ? 1 : 0);
    expect(boundary.complete).toHaveBeenCalledTimes(cleanup === "forced" ? 1 : 0);
    if (cleanup === "uncertain") {
      expect(boundary.release).not.toHaveBeenCalled();
    }
  },
);

it.each(
  (["inspection", "autostart"] as const).flatMap((phase) =>
    (["forced", "uncertain"] as const).map((cleanup) => ({ phase, cleanup })),
  ),
)(
  "settles restoration $phase and retains unknown cleanup ($cleanup)",
  async ({ phase, cleanup }) => {
    const maintenance = await begin();
    if (!maintenance) {
      throw new Error("The repair did not acquire maintenance");
    }
    const barrier = cleanupBarrier();
    if (phase === "inspection") {
      const read = boundary.read.getMockImplementation()!;
      boundary.read.mockImplementation(async (...args) => {
        barrier.retain();
        return await read(...args);
      });
    } else {
      boundary.resume.mockImplementation(async () => barrier.retain());
    }
    const work = maintenance.finish({}).catch((error: unknown) => error);
    try {
      await Promise.race([
        barrier.joining,
        work.then(() => {
          throw new Error("Restoration advanced before physical cleanup joined");
        }),
      ]);
      expect(boundary.restart).not.toHaveBeenCalled();
      expect(boundary.health).not.toHaveBeenCalled();
      if (phase === "autostart") {
        expect(boundary.complete).not.toHaveBeenCalled();
        expect(boundary.read).not.toHaveBeenCalled();
      }
    } finally {
      barrier.cleanup.resolve(cleanup);
      await work;
    }
    const error = await work;
    if (cleanup === "forced") {
      expect(error).toBeUndefined();
      expect(boundary.restart).toHaveBeenCalledOnce();
      expect(boundary.health).toHaveBeenCalledOnce();
      expect(boundary.log).toHaveBeenCalledWith(
        "Gateway restarted and verified after Doctor repair.",
      );
      return;
    }
    expect(hasCommandProcessCleanupError(error)).toBe(true);
    const resumes = boundary.resume.mock.calls.length;
    const completions = boundary.complete.mock.calls.length;
    const releases = boundary.release.mock.calls.length;
    for (const release of [
      () => maintenance.release(),
      () => maintenance.finish({}),
      () => maintenance.releaseState(),
    ]) {
      const refusal = await release().catch((failure: unknown) => failure);
      expect(hasCommandProcessCleanupError(refusal)).toBe(true);
    }
    expect(boundary.resume).toHaveBeenCalledTimes(resumes);
    expect(boundary.complete).toHaveBeenCalledTimes(completions);
    expect(boundary.release).toHaveBeenCalledTimes(releases);
    expect(boundary.restart).not.toHaveBeenCalled();
    expect(boundary.health).not.toHaveBeenCalled();
    expect(boundary.log).not.toHaveBeenCalledWith(
      "Gateway restarted and verified after Doctor repair.",
    );
  },
);

const leaseGuidance =
  "Doctor could not enter maintenance. An agent database is in use. Stop other OpenClaw processes using this state, then retry the update.";
const leaseCode = "agent-database-lease-active";
const privateCause =
  "private-lease-class /synthetic/private-state/private.db token=fixture-only-token alice@example.invalid";

it("carries an actual typed lease refusal through Doctor IPC, finalization and public projection", async () => {
  const cause = new OpenClawAgentDatabaseLeaseActiveError(privateCause);
  boundary.lease.mockImplementation(() => {
    throw cause;
  });
  const refusal: unknown = await begin().catch((error: unknown) => error);
  expect(refusal).toBeInstanceOf(UpdateDoctorError);
  expect(refusal).toMatchObject({ cause, message: leaseGuidance });
  expect(boundary.close).not.toHaveBeenCalled();
  expect(boundary.release).toHaveBeenCalledTimes(2);
  expect(boundary.resume).toHaveBeenCalledOnce();
  expect(boundary.complete).toHaveBeenCalledOnce();
  expect(boundary.restart).toHaveBeenCalledOnce();
  expect(boundary.release.mock.invocationCallOrder[1]).toBeLessThan(
    boundary.resume.mock.invocationCallOrder[0]!,
  );
  expect(boundary.complete.mock.invocationCallOrder[0]).toBeLessThan(
    boundary.restart.mock.invocationCallOrder[0]!,
  );

  const facts = collectUpdateDoctorFailureFacts(refusal);
  expect(facts).toEqual([{ check: "doctor", code: leaseCode, message: leaseGuidance }]);
  vi.stubEnv("OPENCLAW_TMP_DIR", tempDirs.make("openclaw-typed-refusal-"));
  const resultPath = createUpdatePostInstallDoctorResultPath();
  await writeUpdatePostInstallDoctorResult({
    resultPath,
    result: { status: "error", failureFacts: facts },
  });
  const result = await consumeUpdatePostInstallDoctorResult(resultPath);
  expect(result).toEqual({ status: "error", failureFacts: facts });
  if (!result?.failureFacts) {
    throw new Error("Missing Doctor refusal result");
  }
  // Model the existing parent conversion after reading the child's error result.
  const parentError = new UpdateDoctorError(leaseGuidance, result.failureFacts, { exitCode: 1 });
  vi.spyOn(defaultRuntime, "error").mockImplementation(() => {});
  const lifecycle = new UpdateFinalizationLifecycle(false, 5_000, () => {});
  lifecycle.attachLedger();
  await expect(
    lifecycle.run("doctor", async () => {
      throw parentError;
    }),
  ).rejects.toBe(parentError);
  lifecycle.fail();
  expect(boundary.finish).toHaveBeenCalledWith(
    "typed-refusal-run",
    { status: "failed" },
    expect.anything(),
  );
  const failed = boundary.step.mock.calls
    .map((call) => call[1])
    .find((step) => step.status === "failed");
  expect(failed).toMatchObject({
    step: "finalize:doctor",
    reason: leaseCode,
    exitCode: 1,
    failureFacts: facts,
  });
  const fact = failed?.failureFacts?.[0];
  if (!fact?.message) {
    throw new Error("Finalization lost the refusal fact");
  }
  const publicFact = {
    ...(await projectPublicUpdateFailureIdentifiers(fact)),
    message: redactPublicSupportDiagnosticLine(fact.message, {
      env: {},
      stateDir: "/synthetic/private-state",
    }),
  };
  expect(publicFact).toEqual({ check: "doctor", code: leaseCode, message: leaseGuidance });
  expect(JSON.stringify({ result, failed, publicFact })).not.toContain(privateCause);
});

it("retains the typed refusal and restoration failure in the aggregate", async () => {
  const cause = new OpenClawAgentDatabaseLeaseActiveError(privateCause);
  const restore = new Error("synthetic restoration failure");
  boundary.lease.mockImplementation(() => {
    throw cause;
  });
  boundary.resume.mockRejectedValue(restore);
  const refusal: unknown = await begin().catch((error: unknown) => error);
  expect(refusal).toBeInstanceOf(AggregateError);
  expect(refusal).toMatchObject({
    cause: restore,
    errors: [expect.any(UpdateDoctorError), restore],
  });
  expect(collectNestedErrorCandidates(refusal)).toContain(cause);
  expect(collectUpdateDoctorFailureFacts(refusal)).toEqual([
    { check: "doctor", code: leaseCode, message: leaseGuidance },
  ]);
  expect(boundary.release).toHaveBeenCalledTimes(2);
  expect(boundary.complete).toHaveBeenCalledOnce();
  expect(boundary.restart).not.toHaveBeenCalled();
});

it("does not settle a typed refusal while command cleanup remains uncertain", async () => {
  const barrier = cleanupBarrier();
  const cause = new OpenClawAgentDatabaseLeaseActiveError(privateCause);
  boundary.lease.mockImplementation(() => {
    barrier.retain();
    throw cause;
  });
  const work = begin().catch((error: unknown) => error);
  try {
    await Promise.race([
      barrier.joining,
      work.then(() => {
        throw new Error("Admission settled before command cleanup");
      }),
    ]);
    expect(boundary.release).not.toHaveBeenCalled();
  } finally {
    barrier.cleanup.resolve("uncertain");
    await work;
  }
  const refusal = await work;
  expect(hasCommandProcessCleanupError(refusal)).toBe(true);
  expect(collectNestedErrorCandidates(refusal)).toContain(cause);
  expect(collectUpdateDoctorFailureFacts(refusal)).toEqual([
    { check: "doctor", code: leaseCode, message: leaseGuidance },
  ]);
  expect(boundary.release).not.toHaveBeenCalled();
  expect(boundary.resume).not.toHaveBeenCalled();
  expect(boundary.complete).not.toHaveBeenCalled();
  expect(boundary.restart).not.toHaveBeenCalled();
});

it("does not classify a forged lease error name, code or message", async () => {
  const cause = Object.assign(new Error(privateCause), {
    name: "OpenClawAgentDatabaseLeaseActiveError",
    code: leaseCode,
  });
  boundary.lease.mockImplementation(() => {
    throw cause;
  });
  const refusal: unknown = await begin().catch((error: unknown) => error);
  expect(refusal).not.toBeInstanceOf(UpdateDoctorError);
  expect(collectUpdateDoctorFailureFacts(refusal)).toEqual([]);
  expect(
    redactPublicSupportDiagnosticLine(String(refusal), {
      env: {},
      stateDir: "/synthetic/private-state",
    }),
  ).toBe("Error: Doctor could not enter maintenance.");
});
