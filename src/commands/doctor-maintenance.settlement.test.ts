import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type {
  maybeStopManagedServiceBeforeMutableUpdate,
  PreManagedServiceStop,
  revalidateManagedGatewayServiceAfterUpdate,
} from "../cli/update-cli/update-command-service-maintenance.js";
import { UpdateFinalizationLifecycle } from "../cli/update-cli/update-finalization-lifecycle.js";
import { GatewayServiceStopUnsafeError } from "../daemon/service-inspection-error.js";
import type { GatewayService, readGatewayServiceState } from "../daemon/service.js";
import { collectNestedErrorCandidates } from "../infra/error-graph-internal.js";
import { GATEWAY_SERVICE_STOP_TIMEOUT_MS } from "../infra/gateway-shutdown-budget.js";
import { StateDatabaseCoordinatorContentionError } from "../infra/state-database-coordinator.js";
import { DoctorUnreadableStateDatabaseError } from "../infra/state-repair-message.js";
import {
  collectUpdateDoctorFailureFacts,
  consumeUpdatePostInstallDoctorResult,
  createUpdatePostInstallDoctorResultPath,
  DoctorMaintenanceRefusalError,
  UpdateDoctorError,
  writeUpdatePostInstallDoctorResult,
} from "../infra/update-doctor-result.js";
import { projectPublicUpdateFailureIdentifiers } from "../infra/update-failure-public-identifiers.js";
import type { recordUpdateRunStep, finishUpdateRun } from "../infra/update-run-ledger.js";
import { redactPublicSupportDiagnosticLine } from "../logging/diagnostic-support-redaction.js";
import { hasCommandProcessCleanupError } from "../process/exec-result.js";
import {
  resolveCommandProcessSignal,
  retainCommandProcessCleanup,
  withCommandProcessScope,
} from "../process/exec-spawn.js";
import { defaultRuntime } from "../runtime.js";
import { createDeferredCore } from "../shared/deferred.js";
import {
  OpenClawAgentDatabaseLeaseActiveError,
  type readActiveOpenClawAgentDatabaseLeasesReadOnly,
} from "../state/openclaw-agent-db-lease.js";
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

it.each([false, true])(
  "checks same-installation policy before restoring Doctor's Gateway (repair activated=%s)",
  async (activated) => {
    const events: string[] = [];
    const read = boundary.read.getMockImplementation()!;
    boundary.repair.mockImplementation(async () => {
      expect(boundary.release).toHaveBeenCalled();
      events.push("repair");
      boundary.read.mockImplementation(async (...args) => ({
        ...(await read(...args)),
        running: activated,
        runtime: { status: activated ? "running" : "stopped" },
      }));
      return {};
    });
    boundary.restart.mockImplementation(async () => events.push("restart"));
    const maintenance = await begin();
    await maintenance!.finish({}, async (config) => config);
    expect(events).toEqual(activated ? ["repair"] : ["repair", "restart"]);
    expect(boundary.health).toHaveBeenCalledOnce();
  },
);

it("does not suggest an unsafe manual stop after a reported write-custody refusal", async () => {
  const refusal = new GatewayServiceStopUnsafeError(
    "Gateway maintenance stop refused: data at risk in owner phase migration (1).",
  );
  boundary.stop.mockImplementation(async (params) => {
    if (params.phase === "inspect") {
      return { ...stopped, stopped: false, running: true, offline: false };
    }
    throw refusal;
  });
  const error = await begin().catch((reason: unknown) => reason);
  expect(error).toBeInstanceOf(Error);
  expect(String(error)).toContain(refusal.message);
  expect(String(error)).not.toContain("Stop the Gateway service and other OpenClaw processes");
  expect(boundary.restart).not.toHaveBeenCalled();
});

it("releases its acquired coordinator without deferring a one-shot authority refusal", async () => {
  const refused = new Error("Synthetic revoked update authority");
  let revoked = false;
  const assertCurrent = vi.fn(() => {
    if (!revoked && boundary.gatewayAcquire.mock.calls.length) {
      revoked = true;
      throw refused;
    }
  });
  await expect(begin(assertCurrent)).rejects.toBe(refused);
  expect(boundary.release).toHaveBeenCalledOnce();
  expect(boundary.stateAcquire).not.toHaveBeenCalled();
  expect(boundary.restart).not.toHaveBeenCalled();
  expect(boundary.stop).toHaveBeenCalledOnce();
});

it("preserves caller cancellation after a settled maintenance inspection", async () => {
  const controller = new AbortController();
  const cancelled = new Error("Synthetic update cancellation");
  boundary.stop.mockImplementation(async () => {
    controller.abort(cancelled);
    return {
      stopped: false,
      inspected: false,
      runtimeInspected: false,
      running: false,
      serviceUpdateVerdict: { kind: "unavailable", message: "Inspection was cancelled." },
    };
  });
  boundary.gatewayAcquire.mockImplementation(() => {
    throw new StateDatabaseCoordinatorContentionError("gateway-lifecycle");
  });
  await expect(withCommandProcessScope(() => begin(), controller.signal)).rejects.toBe(cancelled);
  expect(boundary.stop).toHaveBeenCalledOnce();
  expect(boundary.restart).not.toHaveBeenCalled();
});

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
  (["inspection", "autostart", "installation"] as const).flatMap((phase) =>
    (["forced", "uncertain"] as const).map((cleanup) => ({ phase, cleanup })),
  ),
)(
  "settles restoration $phase and retains unknown cleanup ($cleanup)",
  async ({ phase, cleanup }) => {
    if (phase === "installation") {
      stopped.serviceUpdateVerdict = {
        kind: "owned",
        root: "/synthetic/service-install",
        fingerprint: "fixture",
        refreshDefinition: true,
        requiresInstallRootRefresh: true,
      };
      boundary.revalidate.mockResolvedValueOnce(stopped.serviceUpdateVerdict);
    }
    const maintenance = await begin();
    if (!maintenance) {
      throw new Error("The repair did not acquire maintenance");
    }
    boundary.unlock.mockClear();
    const barrier = cleanupBarrier();
    if (phase === "inspection") {
      const read = boundary.read.getMockImplementation()!;
      boundary.read.mockImplementation(async (...args) => {
        barrier.retain();
        return await read(...args);
      });
    } else if (phase === "autostart") {
      boundary.resume.mockImplementation(async () => barrier.retain());
    } else {
      boundary.repair.mockImplementation(async () => {
        barrier.retain();
        return {};
      });
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
      expect(boundary.unlock).not.toHaveBeenCalled();
      if (phase === "autostart") {
        expect(boundary.complete).not.toHaveBeenCalled();
        expect(boundary.read).not.toHaveBeenCalled();
      } else if (phase === "installation") {
        expect(boundary.read).toHaveBeenCalledOnce();
        expect(boundary.revalidate).toHaveBeenCalledOnce();
        expect(boundary.resume).not.toHaveBeenCalled();
        expect(boundary.complete).toHaveBeenCalledExactlyOnceWith(false);
      }
    } finally {
      barrier.cleanup.resolve(cleanup);
      await work;
    }
    const error = await work;
    if (cleanup === "forced") {
      expect(error).toBeUndefined();
      expect(boundary.restart).toHaveBeenCalledTimes(phase === "installation" ? 0 : 1);
      expect(boundary.health).toHaveBeenCalledOnce();
      if (phase === "installation") {
        expect(boundary.read).toHaveBeenCalledTimes(2);
        expect(boundary.revalidate).toHaveBeenCalledTimes(2);
        expect(boundary.repair).toHaveBeenCalledOnce();
      }
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

it("refuses an external active agent lease before serving-Gateway coordinator contention", async () => {
  boundary.external.mockReturnValue(true);
  boundary.readLeases.mockReturnValue([
    {
      agent_id: "private-agent",
      lease_id: "private-lease",
      owner_pid: 4242,
      owner_start_time: 123,
      path: "/synthetic/private-state/private.db",
    },
  ]);
  boundary.gatewayAcquire.mockImplementation(() => {
    throw new Error("another OpenClaw process owns gateway-lifecycle");
  });
  const refusal: unknown = await begin().catch((error: unknown) => error);
  expect(refusal).toBeInstanceOf(UpdateDoctorError);
  expect(refusal).toMatchObject({ message: leaseGuidance });
  const facts = collectUpdateDoctorFailureFacts(refusal);
  expect(facts).toEqual([{ check: "doctor", code: leaseCode, message: leaseGuidance }]);
  expect(await projectPublicUpdateFailureIdentifiers(facts[0]!)).toEqual({
    check: "doctor",
    code: leaseCode,
  });
  expect(JSON.stringify(facts)).not.toContain("private");
  expect(boundary.readLeases).toHaveBeenCalledOnce();
  expect(boundary.gatewayAcquire).not.toHaveBeenCalled();
  expect(boundary.stateAcquire).not.toHaveBeenCalled();
  expect(boundary.lease).not.toHaveBeenCalled();
  expect(boundary.stop).not.toHaveBeenCalled();
  expect(boundary.restart).not.toHaveBeenCalled();
  expect(boundary.close).not.toHaveBeenCalled();
  expect(boundary.release).not.toHaveBeenCalled();
});

it("does not use an empty external lease observation to bypass coordinator contention", async () => {
  boundary.external.mockReturnValue(true);
  const contention = new Error("another OpenClaw process owns gateway-lifecycle");
  boundary.gatewayAcquire.mockImplementation(() => {
    throw contention;
  });
  const refusal: unknown = await begin().catch((error: unknown) => error);
  expect(refusal).toMatchObject({ cause: contention });
  expect(collectUpdateDoctorFailureFacts(refusal)).toEqual([]);
  expect(boundary.readLeases).toHaveBeenCalledOnce();
  expect(boundary.gatewayAcquire).toHaveBeenCalledOnce();
  expect(boundary.stateAcquire).not.toHaveBeenCalled();
  expect(boundary.lease).not.toHaveBeenCalled();
  expect(boundary.stop).not.toHaveBeenCalled();
  expect(boundary.close).not.toHaveBeenCalled();
});

it("rechecks external leases under both coordinators after an empty observation", async () => {
  boundary.external.mockReturnValue(true);
  boundary.lease.mockImplementation(() => {
    throw new OpenClawAgentDatabaseLeaseActiveError(privateCause);
  });
  const refusal: unknown = await begin().catch((error: unknown) => error);
  expect(collectUpdateDoctorFailureFacts(refusal)).toEqual([
    { check: "doctor", code: leaseCode, message: leaseGuidance },
  ]);
  expect(boundary.readLeases).toHaveBeenCalledOnce();
  expect(boundary.gatewayAcquire).toHaveBeenCalledOnce();
  expect(boundary.stateAcquire).toHaveBeenCalledOnce();
  expect(boundary.readLeases.mock.invocationCallOrder[0]!).toBeLessThan(
    boundary.gatewayAcquire.mock.invocationCallOrder[0]!,
  );
  expect(boundary.stateAcquire.mock.invocationCallOrder[0]!).toBeLessThan(
    boundary.lease.mock.invocationCallOrder[0]!,
  );
  expect(boundary.release).toHaveBeenCalledTimes(2);
  expect(boundary.stop).not.toHaveBeenCalled();
  expect(boundary.close).not.toHaveBeenCalled();
});

it("fails closed on an unknown external lease observation without exposing private details", async () => {
  boundary.external.mockReturnValue(true);
  const cause = Object.assign(new Error(privateCause), {
    name: "OpenClawAgentDatabaseLeaseActiveError",
    code: leaseCode,
  });
  boundary.readLeases.mockImplementation(() => {
    throw cause;
  });
  boundary.lease.mockImplementation(() => {
    throw cause;
  });
  const refusal: unknown = await begin().catch((error: unknown) => error);
  expect(refusal).toMatchObject({ cause });
  expect(refusal).toBeInstanceOf(DoctorMaintenanceRefusalError);
  expect(refusal).toMatchObject({ refusal: { kind: "deferred", reason: "admission-unavailable" } });
  expect(collectUpdateDoctorFailureFacts(refusal)).toEqual([]);
  expect(
    redactPublicSupportDiagnosticLine(String(refusal), {
      env: {},
      stateDir: "/synthetic/private-state",
    }),
  ).toBe("DoctorMaintenanceRefusalError: Doctor could not enter maintenance.");
  expect(boundary.gatewayAcquire).toHaveBeenCalledOnce();
  expect(boundary.stateAcquire).toHaveBeenCalledOnce();
  expect(boundary.lease).toHaveBeenCalledOnce();
  expect(boundary.release).toHaveBeenCalledTimes(2);
  expect(boundary.stop).not.toHaveBeenCalled();
  expect(boundary.close).not.toHaveBeenCalled();
});

it("grants external maintenance only after the unchanged held-owner checks", async () => {
  boundary.external.mockReturnValue(true);
  const maintenance = await begin();
  expect(maintenance).toBeDefined();
  expect(boundary.readLeases).toHaveBeenCalledOnce();
  expect(boundary.gatewayAcquire).toHaveBeenCalledOnce();
  expect(boundary.stateAcquire).toHaveBeenCalledOnce();
  expect(boundary.lease).toHaveBeenCalledOnce();
  expect(boundary.stateAcquire.mock.invocationCallOrder[0]!).toBeLessThan(
    boundary.lease.mock.invocationCallOrder[0]!,
  );
  expect(boundary.stop).not.toHaveBeenCalled();
  await maintenance!.release();
  expect(boundary.close).toHaveBeenCalledOnce();
  expect(boundary.release).toHaveBeenCalledTimes(2);
});

it("preserves held-owner unreadable-state guidance after an external diagnostic read fails", async () => {
  boundary.external.mockReturnValue(true);
  const failure = new Error("synthetic unreadable schema");
  boundary.readLeases.mockImplementation(() => {
    throw failure;
  });
  boundary.lease.mockImplementation(() => {
    throw failure;
  });
  boundary.schemas.mockResolvedValue({
    indeterminate: [
      {
        kind: "state",
        path: "/synthetic/doctor-state/state/openclaw.sqlite",
        reason: "not a database",
      },
    ],
  });
  const refusal: unknown = await begin().catch((error: unknown) => error);
  expect(refusal).toBeInstanceOf(DoctorUnreadableStateDatabaseError);
  expect(String(refusal)).toContain("restore this file from a verified backup");
  expect(boundary.gatewayAcquire).toHaveBeenCalledOnce();
  expect(boundary.stateAcquire).toHaveBeenCalledOnce();
  expect(boundary.lease).toHaveBeenCalledOnce();
  expect(boundary.release).toHaveBeenCalledTimes(2);
  expect(boundary.close).not.toHaveBeenCalled();
  expect(boundary.stop).not.toHaveBeenCalled();
});

it("carries an actual typed lease refusal through Doctor IPC, finalization and public projection", async () => {
  const cause = new OpenClawAgentDatabaseLeaseActiveError(privateCause);
  boundary.lease.mockImplementation(() => {
    throw cause;
  });
  const refusal: unknown = await begin().catch((error: unknown) => error);
  expect(refusal).toBeInstanceOf(UpdateDoctorError);
  expect(refusal).toMatchObject({ cause, message: leaseGuidance });
  expect(boundary.readLeases).not.toHaveBeenCalled();
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
  expect(refusal).toBeInstanceOf(DoctorMaintenanceRefusalError);
  expect(refusal).toMatchObject({ refusal: { kind: "deferred", reason: "admission-unavailable" } });
  expect(collectUpdateDoctorFailureFacts(refusal)).toEqual([]);
  expect(
    redactPublicSupportDiagnosticLine(String(refusal), {
      env: {},
      stateDir: "/synthetic/private-state",
    }),
  ).toBe("DoctorMaintenanceRefusalError: Doctor could not enter maintenance.");
});

it.each([false, true])(
  "waits for the stopped Gateway's lifecycle ownership (expires=%s)",
  async (expires) => {
    let elapsed = 0;
    let ticks = 0;
    let loaded = true;
    vi.spyOn(performance, "now").mockImplementation(() => elapsed);
    boundary.owner.mockReturnValue({ state: "live", mode: "supervised" });
    const acquire = boundary.gatewayAcquire.getMockImplementation()!;
    boundary.gatewayAcquire.mockImplementation(() => {
      if (expires || ticks < 3) {
        throw new StateDatabaseCoordinatorContentionError("gateway-lifecycle");
      }
      return acquire();
    });
    boundary.sleep.mockImplementation(async (ms: number) => {
      expect(loaded).toBe(false);
      expect(boundary.restart).not.toHaveBeenCalled();
      elapsed += ms;
      ticks++;
    });
    const stop = boundary.stop.getMockImplementation()!;
    boundary.stop.mockImplementation(async (params) => {
      const result = await stop(params);
      if (params.phase !== "inspect") {
        loaded = false;
      }
      return result;
    });
    boundary.restart.mockImplementation(async () => {
      loaded = true;
    });

    if (expires) {
      await expect(begin()).rejects.toThrow(/gateway-lifecycle/);
      expect(elapsed).toBe(GATEWAY_SERVICE_STOP_TIMEOUT_MS);
      expect(boundary.log).toHaveBeenCalledWith(
        expect.stringMatching(/Warning:.*gateway-lifecycle.*openclaw doctor --fix/),
      );
    } else {
      const maintenance = await begin();
      expect(ticks).toBe(3);
      expect(boundary.restart).not.toHaveBeenCalled();
      await maintenance!.finish({});
    }
    expect(loaded).toBe(true);
    expect(boundary.restart).toHaveBeenCalledOnce();
  },
);

it("restores a service after state ownership fails without retaining a partial maintenance scope", async () => {
  boundary.owner.mockReturnValue({ state: "live", mode: "supervised" });
  let heldLeases = 0;
  boundary.gatewayAcquire
    .mockImplementation(() => {
      heldLeases++;
      return {
        release: () => {
          heldLeases--;
        },
        createSchemaFenceDelegate: vi.fn(),
      };
    })
    .mockImplementationOnce(() => {
      throw new StateDatabaseCoordinatorContentionError("gateway-lifecycle");
    });
  boundary.stateAcquire.mockImplementation(() => {
    throw new StateDatabaseCoordinatorContentionError("state-lifecycle");
  });
  await expect(begin()).rejects.toThrow(/state-lifecycle/);
  expect(boundary.restart).toHaveBeenCalledOnce();
  expect(heldLeases).toBe(0);
  expect(boundary.sleep).not.toHaveBeenCalled();
});

it.each(["drain", "acquired", "native-revoked", "install-drift"] as const)(
  "refuses changed repair admission and compensates under original service custody (%s)",
  async (phase) => {
    if (phase === "install-drift") {
      stopped.serviceUpdateVerdict = {
        kind: "owned",
        root,
        fingerprint: "fixture",
        refreshDefinition: true,
        requiresInstallRootRefresh: true,
      };
      boundary.revalidate.mockResolvedValue(stopped.serviceUpdateVerdict);
    }
    let ticks = 0;
    let gatewayHeld = false;
    let stateHeld = false;
    let conflict = false;
    let checkedUnderBoth = false;
    let stopCustody: (() => void) | undefined;
    let capturedStopAdmission: (() => void) | undefined;
    boundary.owner.mockReturnValue({ state: "live", mode: "supervised" });
    boundary.gatewayAcquire.mockImplementation(() => {
      if (ticks < 2) {
        throw new StateDatabaseCoordinatorContentionError("gateway-lifecycle");
      }
      gatewayHeld = true;
      return {
        release: () => {
          gatewayHeld = false;
        },
        createSchemaFenceDelegate: vi.fn(),
      };
    });
    boundary.stateAcquire.mockImplementation(() => {
      stateHeld = true;
      conflict = true;
      return {
        release: () => {
          stateHeld = false;
        },
      };
    });
    boundary.sleep.mockImplementation(async () => {
      ticks++;
      if (phase === "drain") {
        conflict = true;
      }
    });
    boundary.admission.mockImplementation(() => {
      checkedUnderBoth ||= gatewayHeld && stateHeld;
      return conflict
        ? { kind: "conflict", message: "repair admission conflict" }
        : { kind: "recovery", runs: [] };
    });
    const stop = boundary.stop.getMockImplementation()!;
    boundary.stop.mockImplementation(async (params) => {
      if (params.phase !== "inspect") {
        stopCustody = boundary.scopeAssert;
        capturedStopAdmission = params.assertCurrent;
      }
      return await stop(params);
    });
    boundary.resume.mockImplementation(async () => {
      // Windows autostart recovery retains the caller assertion supplied at stop.
      capturedStopAdmission?.();
    });
    boundary.authority.mockImplementation(() => {
      if (phase === "native-revoked" && conflict) {
        throw new Error("native operation custody retired");
      }
    });
    boundary.restart.mockImplementation(async () => {
      expect(stopCustody).toBeTypeOf("function");
      stopCustody!();
      expect(gatewayHeld || stateHeld).toBe(false);
    });
    const refusal = await begin().catch((error: unknown) => error);
    expect(String(refusal)).toMatch(/repair admission conflict|native operation custody retired/);
    expect(refusal).not.toBeInstanceOf(DoctorMaintenanceRefusalError);
    expect(checkedUnderBoth).toBe(true);
    expect(boundary.restart).toHaveBeenCalledTimes(
      phase === "native-revoked" || phase === "install-drift" ? 0 : 1,
    );
    expect(boundary.repair).not.toHaveBeenCalled();
    expect(boundary.complete).toHaveBeenCalled();
    expect(boundary.close).not.toHaveBeenCalled();
    expect(gatewayHeld || stateHeld).toBe(false);
  },
);

it.each([false, true])(
  "restores within the shared stop budget when ownerless cleanup persists (stopFailed=%s)",
  async (stopFailed) => {
    vi.stubEnv("OPENCLAW_UPDATE_IN_PROGRESS", "1");
    let elapsed = 0;
    let parked = false;
    vi.spyOn(performance, "now").mockImplementation(() => elapsed);
    boundary.owner.mockImplementation(() =>
      parked ? undefined : { state: "live", mode: "supervised" },
    );
    boundary.gatewayAcquire.mockImplementation(() => {
      throw new StateDatabaseCoordinatorContentionError("gateway-lifecycle");
    });
    boundary.sleep.mockImplementation(async (ms: number) => {
      expect(parked).toBe(true);
      expect(boundary.restart).not.toHaveBeenCalled();
      elapsed += ms;
    });
    const stop = boundary.stop.getMockImplementation()!;
    const stopError = new Error("service stop failed after parking");
    boundary.stop.mockImplementation(async (params) => {
      const result = await stop(params);
      if (params.phase !== "inspect") {
        parked = true;
        elapsed = GATEWAY_SERVICE_STOP_TIMEOUT_MS - 1_250;
        if (stopFailed) {
          throw stopError;
        }
      }
      return result;
    });
    const refusal = await begin(() => {}).catch((error: unknown) => error);

    expect(refusal).toBeInstanceOf(Error);
    if (stopFailed) {
      expect(collectNestedErrorCandidates(refusal)).toContain(stopError);
    } else {
      expect(String(refusal)).toContain("gateway-lifecycle");
    }
    expect(elapsed).toBe(GATEWAY_SERVICE_STOP_TIMEOUT_MS);
    expect(boundary.stateAcquire).not.toHaveBeenCalled();
    expect(boundary.lease).not.toHaveBeenCalled();
    expect(boundary.close).not.toHaveBeenCalled();
    expect(boundary.restart).toHaveBeenCalledOnce();
    expect(boundary.health).toHaveBeenCalledOnce();
    expect(boundary.log).toHaveBeenCalledWith(
      expect.stringMatching(/Warning:.*gateway-lifecycle.*Restoring its service/),
    );
  },
);
