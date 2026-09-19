import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { note } from "../../packages/terminal-core/src/note.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { noteStaleUpdateRuns } from "../commands/doctor-update-run.js";
import {
  createUpdateRun,
  finishUpdateRun,
  getUpdateRun,
  reconcileAbandonedUpdateRuns,
  recordUpdateRunPhase,
  recordUpdateRunRepairAttempt,
  recordUpdateRunStep,
} from "../infra/update-run-ledger.js";
import { renderUpdateRunReport } from "../infra/update-run-report.js";
import { createDeferredCore } from "../shared/deferred.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { startUpdateRunWatcher } from "./update-run-watcher.js";

const observation = vi.hoisted(() => ({
  installedBuild: "candidate-build",
  servingBuild: "candidate-build",
  driver: "dead" as "dead" | "alive" | "unknown",
  previousDriver: "dead" as "dead" | "alive",
  inspect: vi.fn(),
  settle: vi.fn(),
}));
vi.mock("../infra/update-run-driver.js", async (original) => ({
  ...(await original<typeof import("../infra/update-run-driver.js")>()),
  inspectUpdateRunDriver: (driver: { pid: number }) =>
    driver.pid === 23457 ? observation.previousDriver : observation.driver,
}));
vi.mock("../infra/openclaw-root.js", () => ({
  resolveOpenClawPackageRoot: async () => "/synthetic/openclaw",
}));
vi.mock("../infra/package-json.js", () => ({ readPackageVersion: async () => "2026.9.4" }));
vi.mock("../infra/update-git-runtime.js", () => ({
  readBuiltGatewayBuildId: async () => observation.installedBuild,
}));

vi.mock("../cli/daemon-cli/restart-health-probe.js", () => ({
  resolveGatewayRestartProbeContext: async () => ({ config: { gateway: { port: 18789 } } }),
  waitForGatewayHttpReadiness: async () => ({ healthz: 200, readyz: 200 }),
}));
vi.mock("../cli/daemon-cli/restart-health.js", () => ({
  inspectGatewayRestart: observation.inspect,
  waitForGatewayHealthyRestart: observation.settle,
  isSameGatewayRestartGeneration: (
    left: { gatewayBootId: string },
    right: { gatewayBootId: string },
  ) => left.gatewayBootId === right.gatewayBootId,
}));
vi.mock("./update-run-notice.runtime.js", () => ({ notifyUpdateRunPhase: vi.fn() }));
vi.mock("../../packages/terminal-core/src/note.js", () => ({ note: vi.fn() }));

const dirs = useAutoCleanupTempDirTracker(afterEach);
let watcher: ReturnType<typeof startUpdateRunWatcher> | undefined;
const now = Date.parse("2026-09-18T22:00:00Z");
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(now);
  vi.stubEnv("OPENCLAW_STATE_DIR", dirs.make("update-interruption-"));
  observation.installedBuild = "candidate-build";
  observation.servingBuild = "candidate-build";
  observation.driver = "dead";
  observation.previousDriver = "dead";
  observation.inspect.mockReset().mockImplementation(async () => health());
  observation.settle.mockReset().mockImplementation(async () => health());
  vi.mocked(note).mockClear();
});
function health() {
  return {
    healthy: true,
    runtime: { status: "running", pid: 12345 },
    gatewayVersion: "2026.9.4",
    gatewayBuildId: observation.servingBuild,
    gatewayBootId: "replacement-boot",
    staleGatewayPids: [],
  };
}
afterEach(async () => {
  await watcher?.stop();
  watcher = undefined;
  closeOpenClawStateDatabaseForTest();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

function interruptedRun(receipt = true) {
  const run = createUpdateRun({
    trigger: "cli",
    origin: { driver: { host: "synthetic-host", pid: 23456, startIdentity: "1" } },
    before: { version: "2026.9.4" },
    target: { kind: "package", tag: "/synthetic/candidate.tgz" },
  });
  if (receipt) {
    recordUpdateRunStep(run.runId, {
      step: "finalize:installed-candidate",
      status: "completed",
      detail: JSON.stringify({ version: "2026.9.4", buildId: "candidate-build" }),
      endedAtMs: now,
    });
  }
  recordUpdateRunStep(run.runId, { step: "post-update verification", status: "completed" });
  recordUpdateRunPhase(run.runId, "restarting");
  recordUpdateRunPhase(run.runId, "verifying");
  vi.setSystemTime(now + 31 * 60_000);
  return run.runId;
}

it.each([false, true])(
  "settles a verified interrupted CLI run (already abandoned: %s)",
  async (abandoned) => {
    const runId = interruptedRun();
    if (abandoned) {
      reconcileAbandonedUpdateRuns();
    }
    const broadcast = vi.fn();
    watcher = startUpdateRunWatcher({ broadcast, log: { warn: vi.fn() } });
    await vi.waitFor(() => expect(getUpdateRun(runId)?.status).toBe("succeeded"));
    expect(getUpdateRun(runId)).toMatchObject({
      reason: null,
      after: { version: "2026.9.4", buildId: "candidate-build" },
      verification: { versionMatch: true, readyz: true, runningBuildId: "candidate-build" },
    });
    expect(broadcast).toHaveBeenCalledWith(
      "update.run.changed",
      expect.objectContaining({ runId, status: "succeeded" }),
    );
    expect(renderUpdateRunReport(getUpdateRun(runId)!).markdown).toContain(
      "Updater exited before recording completion",
    );
  },
);

it("explains an older abandoned run whose target identity was never recorded", async () => {
  const runId = interruptedRun(false);
  reconcileAbandonedUpdateRuns();
  await noteStaleUpdateRuns({});
  expect(note).toHaveBeenCalledWith(expect.stringContaining(runId), "Update history");
  expect(note).toHaveBeenCalledWith(
    expect.stringContaining("target build was not recorded"),
    "Update history",
  );
  expect(getUpdateRun(runId)?.reason).toBe("abandoned");
  expect(observation.inspect).not.toHaveBeenCalled();
});

it.each([
  "installed",
  "serving",
  "alive",
  "unknown",
  "failure",
  "previous-driver",
  "identity-unavailable",
  "rollback",
  "recovery",
  "unsettled",
])("preserves interrupted evidence when %s does not permit settlement", async (boundary) => {
  const runId = interruptedRun();
  if (boundary === "installed") {
    observation.installedBuild = "another-build";
  }
  if (boundary === "serving") {
    observation.servingBuild = "another-build";
  }
  if (boundary === "alive" || boundary === "unknown") {
    observation.driver = boundary;
  }
  if (boundary === "failure") {
    finishUpdateRun(runId, { status: "failed", reason: "post-update-failed" });
  }
  if (boundary === "previous-driver") {
    recordUpdateRunPhase(runId, "verifying", {
      origin: {
        previousDrivers: [{ host: "synthetic-host", pid: 23457, startIdentity: "2" }],
      },
    });
    observation.previousDriver = "alive";
  }
  if (boundary === "identity-unavailable" || boundary === "rollback") {
    recordUpdateRunStep(runId, {
      step: boundary === "rollback" ? "package rollback" : "driver:identity-unavailable",
      status: "completed",
    });
  }
  if (boundary === "recovery") {
    openOpenClawStateDatabase()
      .db.prepare(
        "INSERT INTO config_machine_state(state_key,value_json,updated_at_ms) VALUES(?,?,?)",
      )
      .run(`update.recovery.${runId}`, "{}", now);
  }
  if (boundary === "unsettled") {
    observation.settle.mockResolvedValue({ ...health(), healthy: false });
  }
  watcher = startUpdateRunWatcher({ broadcast: vi.fn(), log: { warn: vi.fn() } });
  await vi.advanceTimersByTimeAsync(0);
  await watcher.stop();
  expect(getUpdateRun(runId)?.status).not.toBe("succeeded");
});

it.each(["driver-revived", "newer-completed-run"])(
  "rechecks %s after awaited health probes",
  async (race) => {
    const runId = interruptedRun();
    observation.inspect.mockImplementationOnce(async () => {
      if (race === "driver-revived") {
        observation.driver = "alive";
      } else {
        const newer = createUpdateRun({ trigger: "cli" });
        finishUpdateRun(newer.runId, { status: "succeeded" });
      }
      return health();
    });
    watcher = startUpdateRunWatcher({ broadcast: vi.fn(), log: { warn: vi.fn() } });
    await vi.waitFor(() => expect(observation.inspect).toHaveBeenCalledTimes(2));
    await vi.advanceTimersByTimeAsync(0);
    await watcher.stop();
    expect(getUpdateRun(runId)?.status).not.toBe("succeeded");
  },
);

it("joins pending verification at watcher shutdown without publishing a late success", async () => {
  const runId = interruptedRun();
  const probe = createDeferredCore<ReturnType<typeof health>>();
  observation.settle.mockReturnValue(probe.promise);
  watcher = startUpdateRunWatcher({ broadcast: vi.fn(), log: { warn: vi.fn() } });
  await vi.waitFor(() => expect(observation.settle).toHaveBeenCalledOnce());
  let stopped = false;
  const stop = watcher.stop().then(() => {
    stopped = true;
  });
  await Promise.resolve();
  expect(stopped).toBe(false);
  probe.resolve(health());
  await stop;
  expect(getUpdateRun(runId)?.status).toBe("running");
});

it.each([false, true])("Doctor respects read-only preflight: %s", async (readOnly) => {
  const runId = interruptedRun();
  reconcileAbandonedUpdateRuns();
  await noteStaleUpdateRuns({ migrateState: !readOnly });
  expect(getUpdateRun(runId)?.status).toBe(readOnly ? "failed" : "succeeded");
  if (readOnly) {
    expect(observation.settle).not.toHaveBeenCalled();
  } else {
    expect(note).toHaveBeenCalledWith(
      expect.stringContaining("recorded succeeded"),
      "Update history",
    );
  }
});

it.each(["repair", "acknowledgement"])(
  "does not attribute a later %s to the interrupted updater",
  async (evidence) => {
    const runId = interruptedRun();
    if (evidence === "repair") {
      recordUpdateRunRepairAttempt(runId, {
        attempt: 1,
        status: "succeeded",
        startedAtMs: Date.now(),
      });
    } else {
      recordUpdateRunStep(runId, { step: "reconcile:acknowledged", status: "completed" });
    }
    vi.setSystemTime(Date.now() + 31 * 60_000);
    reconcileAbandonedUpdateRuns();
    await noteStaleUpdateRuns({});
    expect(getUpdateRun(runId)).toMatchObject({ status: "failed", reason: "abandoned" });
    expect(observation.settle).not.toHaveBeenCalled();
  },
);

it("retries settlement after settle-budget-exceeded when the gateway recovers", async () => {
  // Regression for ClawSweeper P1 finding: a run with reconcile:settle-budget-exceeded
  // must remain eligible for automatic reconciliation. The first call fails to settle
  // (writes settle-budget-exceeded); the second call succeeds after the gateway recovers.
  const { reconcileInterruptedUpdateRuns } = await import("../infra/update-run-interruption.js");
  const runId = interruptedRun();
  let settleAttempt = 0;
  observation.settle.mockImplementation(async () => {
    settleAttempt++;
    if (settleAttempt === 1) {
      return { ...health(), healthy: false };
    }
    return health();
  });

  // First call: settle fails, writes reconcile:settle-budget-exceeded
  const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  const result1 = await reconcileInterruptedUpdateRuns();
  expect(result1).toEqual([]);
  const afterFirst = getUpdateRun(runId);
  expect(afterFirst?.steps.some((s) => s.step === "reconcile:settle-budget-exceeded")).toBe(true);
  expect(afterFirst?.status).toBe("running");
  expect(settleAttempt).toBe(1);
  warnSpy.mockRestore();

  // Second call: settle succeeds this time — run is still eligible
  const result2 = await reconcileInterruptedUpdateRuns();
  expect(settleAttempt).toBe(2);
  expect(result2).toHaveLength(1);
  const afterSecond = getUpdateRun(runId);
  expect(afterSecond?.status).toBe("succeeded");
  expect(afterSecond?.verification?.versionMatch).toBe(true);
});

it("does not renew abandonment activity on repeated settle-budget-exceeded", async () => {
  // Regression for ClawSweeper P2: repeated settle failures must not advance
  // updatedAtMs/endedAtMs, which feed the 30-min abandonment inactivity window.
  // The first failure writes settle-budget-exceeded; a second failure 31 min
  // later must NOT renew activity, so the run can still be abandoned.
  const { reconcileInterruptedUpdateRuns } = await import("../infra/update-run-interruption.js");
  const runId = interruptedRun();
  observation.settle.mockImplementation(async () => ({ ...health(), healthy: false }));

  // First failure: writes settle-budget-exceeded
  const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  await reconcileInterruptedUpdateRuns();
  const afterFirst = getUpdateRun(runId);
  const firstActivity = afterFirst!.updatedAtMs;
  expect(afterFirst?.steps.some((s) => s.step === "reconcile:settle-budget-exceeded")).toBe(true);

  // Advance past the abandonment window
  vi.setSystemTime(now + 31 * 60_000 + 31 * 60_000 + 1000);

  // Second failure: should NOT write (idempotent), should NOT advance updatedAtMs
  await reconcileInterruptedUpdateRuns();
  const afterSecond = getUpdateRun(runId);
  expect(afterSecond?.updatedAtMs).toBe(firstActivity);
  const settleSteps = afterSecond!.steps.filter(
    (s) => s.step === "reconcile:settle-budget-exceeded",
  );
  expect(settleSteps).toHaveLength(1);

  // The run should now be abandonable (inactivity window has elapsed)
  const { reconcileAbandonedUpdateRuns: reconcileAbandoned } =
    await import("../infra/update-run-ledger.js");
  const abandoned = reconcileAbandoned();
  expect(
    abandoned.some((r) => r.runId === runId && r.status === "failed" && r.reason === "abandoned"),
  ).toBe(true);
  warnSpy.mockRestore();
});
