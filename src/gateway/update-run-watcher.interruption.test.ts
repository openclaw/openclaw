import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { note } from "../../packages/terminal-core/src/note.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { INTERRUPTED_UPDATE_SETTLE_TIMEOUT_MS } from "../cli/daemon-cli/restart-health.constants.js";
import { noteStaleUpdateRuns } from "../commands/doctor-update-run.js";
import type { InterruptedUpdateSettlement } from "../infra/update-run-interruption-contract.js";
import { persistInterruptedUpdateObservation } from "../infra/update-run-interruption-store.js";
import { reconcileInterruptedUpdateRuns } from "../infra/update-run-interruption.js";
import {
  createUpdateRun,
  finishUpdateRun,
  getUpdateRun,
  reconcileAbandonedUpdateRuns,
  recordUpdateRunPhase,
  recordUpdateRunRepairAttempt,
  recordUpdateRunStep,
} from "../infra/update-run-ledger.js";
import { readInterruptedUpdateCandidate } from "../infra/update-run-read.kernel.js";
import { renderUpdateRunReport } from "../infra/update-run-report.js";
import { CommandProcessCleanupError } from "../process/exec-result.js";
import { retainCommandProcessCleanup } from "../process/exec-spawn.js";
import { createDeferredCore } from "../shared/deferred.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import type { OpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.types.js";
import { startUpdateRunWatcher } from "./update-run-watcher.js";

const observation = vi.hoisted(() => ({
  installedBuild: "candidate-build",
  servingBuild: "candidate-build",
  driver: "dead" as "dead" | "alive" | "unknown",
  previousDriver: "dead" as "dead" | "alive",
  context: vi.fn(),
  http: vi.fn(),
  inspect: vi.fn(),
  settle: vi.fn(),
}));
// Keep the real ledger kernels; worker transport has separate boundary coverage.
vi.mock("../infra/update-run-interruption-worker.js", async () => {
  const { withExistingOpenClawStateDatabaseArtifactPreservingReadOnly } =
    await import("../state/openclaw-state-db-readonly.js");
  return {
    readInterruptedUpdateCandidateAsync: async (
      options: import("../infra/update-run-codec.js").UpdateRunLedgerOptions,
    ) =>
      withExistingOpenClawStateDatabaseArtifactPreservingReadOnly(
        ({ db }) => readInterruptedUpdateCandidate(db),
        options,
      ),
    persistInterruptedUpdateObservationAsync: async (
      context: OpenClawStateWorkerContext,
      input: InterruptedUpdateSettlement,
      signal?: AbortSignal,
    ) => {
      signal?.throwIfAborted();
      return persistInterruptedUpdateObservation(
        input,
        { path: context.admission.databasePath },
        () => signal?.throwIfAborted(),
      );
    },
  };
});
vi.mock("../infra/update-run-reader.js", async (original) => {
  const actual = await original<typeof import("../infra/update-run-reader.js")>();
  return {
    ...actual,
    listUpdateRunsAsync: async (...args: Parameters<typeof actual.listUpdateRuns>) =>
      actual.listUpdateRuns(...args),
  };
});
vi.mock("../infra/update-run-driver.js", async (original) => ({
  ...(await original<typeof import("../infra/update-run-driver.js")>()),
  inspectUpdateRunDriver: (driver: { pid: number }) =>
    driver.pid === 23457 ? observation.previousDriver : observation.driver,
}));
vi.mock("../infra/openclaw-root.js", async (original) => ({
  ...(await original<typeof import("../infra/openclaw-root.js")>()),
  resolveOpenClawPackageRoot: async () => "/synthetic/openclaw",
}));
vi.mock("../infra/package-json.js", () => ({ readPackageVersion: async () => "2026.9.4" }));
vi.mock("../infra/update-git-runtime.js", () => ({
  readBuiltGatewayBuildId: async () => observation.installedBuild,
}));

vi.mock("../cli/daemon-cli/restart-health-probe.js", () => ({
  resolveGatewayRestartProbeContext: observation.context,
  waitForGatewayHttpReadiness: observation.http,
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

// Share cold health-module preparation across cases instead of charging the first watcher wait.
await import("../infra/update-run-interruption-health.js");

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
  observation.context.mockReset().mockResolvedValue({ config: { gateway: { port: 18789 } } });
  observation.http.mockReset().mockResolvedValue({ healthz: 200, readyz: 200 });
  observation.inspect.mockReset().mockImplementation(async () => health());
  observation.settle.mockReset().mockImplementation(async () => health());
  vi.spyOn(console, "warn").mockImplementation(() => {});
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
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

function interruptedRun({ receipt = true, managed = true } = {}) {
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
  if (managed) {
    recordUpdateRunPhase(run.runId, "restarting");
  }
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
    expect(renderUpdateRunReport(getUpdateRun(runId)!).markdown).toContain("settle probe: settled");
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("settle probe: settled"));
  },
);

it("explains an older abandoned run whose target identity was never recorded", async () => {
  const runId = interruptedRun({ receipt: false });
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
    await reconcileInterruptedUpdateRuns();
    expect(getUpdateRun(runId)?.status).not.toBe("succeeded");
    expect(getUpdateRun(runId)?.steps.some((step) => step.step === "reconcile:settle")).toBe(false);
    expect(console.warn).not.toHaveBeenCalled();
  },
);

it("cancels pending verification at watcher shutdown without publishing a late success", async () => {
  const runId = interruptedRun();
  const probe = createDeferredCore<ReturnType<typeof health>>();
  const started = createDeferredCore();
  observation.settle.mockImplementation(() => {
    started.resolve();
    return probe.promise;
  });
  const broadcast = vi.fn();
  watcher = startUpdateRunWatcher({ broadcast, log: { warn: vi.fn() } });
  await started.promise;
  let stopped = false;
  const stop = watcher.stop().then(() => {
    stopped = true;
  });
  try {
    await vi.advanceTimersByTimeAsync(0);
    expect(stopped).toBe(true);
  } finally {
    probe.resolve(health());
    await stop;
  }
  await vi.advanceTimersByTimeAsync(0);
  expect(getUpdateRun(runId)?.status).toBe("running");
  expect(getUpdateRun(runId)?.steps.some((step) => step.step === "reconcile:settle")).toBe(false);
  expect(broadcast).not.toHaveBeenCalledWith(
    "update.run.changed",
    expect.objectContaining({ status: "succeeded" }),
  );
  expect(console.warn).not.toHaveBeenCalled();
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

it.each(["unverified", "timed-out"])(
  "retries a recorded %s probe when the gateway recovers",
  async (outcome) => {
    const runId = interruptedRun();
    const cleanupConfirmed = createDeferredCore();
    vi.mocked(console.warn).mockImplementation((message) => {
      if (String(message).includes("timed-out") && String(message).includes("will retry")) {
        cleanupConfirmed.resolve();
      }
    });
    observation.settle.mockImplementationOnce(async () => {
      if (outcome === "timed-out") {
        vi.advanceTimersByTime(INTERRUPTED_UPDATE_SETTLE_TIMEOUT_MS);
      }
      return { ...health(), healthy: false, waitOutcome: "timeout" };
    });
    expect(await reconcileInterruptedUpdateRuns()).toEqual([]);
    if (outcome === "timed-out") {
      await cleanupConfirmed.promise;
    }
    const pending = getUpdateRun(runId)!;
    const diagnostic = pending.steps.find((step) => step.step === "reconcile:settle");
    expect(diagnostic).toMatchObject({
      status: "completed",
      detail: expect.stringContaining(`settle probe: ${outcome}`),
    });
    expect(pending.status).toBe("running");
    expect(renderUpdateRunReport(pending).markdown).toContain(`settle probe: ${outcome}`);
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining(diagnostic!.detail!));
    if (outcome === "timed-out") {
      expect(diagnostic?.detail).toContain(
        `after ${INTERRUPTED_UPDATE_SETTLE_TIMEOUT_MS} ms during health-wait`,
      );
    }

    expect(await reconcileInterruptedUpdateRuns()).toHaveLength(1);
    const recovered = getUpdateRun(runId)!;
    expect(recovered).toMatchObject({ status: "succeeded", verification: { versionMatch: true } });
    expect(recovered.steps.filter((step) => step.step === "reconcile:settle")).toEqual([
      expect.objectContaining({ detail: expect.stringContaining("settle probe: settled") }),
    ]);
    expect(renderUpdateRunReport(recovered).markdown).not.toContain(`settle probe: ${outcome}`);
  },
);

it.each([true, false])(
  "does not renew abandonment activity after a recorded probe (managed: %s)",
  async (managed) => {
    const runId = interruptedRun({ managed });
    observation.settle.mockResolvedValue({ ...health(), healthy: false });
    await reconcileInterruptedUpdateRuns();
    const first = getUpdateRun(runId)!;
    const diagnostic = first.steps.find((step) => step.step === "reconcile:settle");
    expect(diagnostic).toBeDefined();
    vi.setSystemTime(Date.now() + 31 * 60_000);
    await reconcileInterruptedUpdateRuns();
    const second = getUpdateRun(runId)!;
    expect(second.updatedAtMs).toBe(first.updatedAtMs);
    expect(second.steps.filter((step) => step.step === "reconcile:settle")).toEqual([diagnostic]);
    expect(reconcileAbandonedUpdateRuns()).toEqual([
      expect.objectContaining({ runId, status: "failed", reason: "abandoned" }),
    ]);
  },
);

it.each(["absent", "skipped"])(
  "records an unmanaged skip when the restart step is %s",
  async (restart) => {
    const runId = interruptedRun({ managed: false });
    if (restart === "skipped") {
      recordUpdateRunStep(runId, { step: "restarting", status: "skipped" });
    }
    expect(await reconcileInterruptedUpdateRuns()).toEqual([]);
    const run = getUpdateRun(runId)!;
    expect(run.status).toBe("running");
    expect(run.steps.find((step) => step.step === "reconcile:settle")).toMatchObject({
      status: "completed",
      detail: expect.stringContaining("skipped-unmanaged after 0 ms during ownership"),
    });
    expect(renderUpdateRunReport(run).markdown).toContain("skipped-unmanaged");
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("skipped-unmanaged"));
    expect(observation.context).not.toHaveBeenCalled();
    expect(observation.settle).not.toHaveBeenCalled();
    expect(observation.http).not.toHaveBeenCalled();
    expect(observation.inspect).not.toHaveBeenCalled();
  },
);

it("records cleanup uncertainty instead of settling an interrupted update", async () => {
  const runId = interruptedRun();
  observation.settle.mockRejectedValue(new CommandProcessCleanupError());
  expect(await reconcileInterruptedUpdateRuns()).toEqual([]);
  const run = getUpdateRun(runId)!;
  expect(run.status).toBe("running");
  expect(run.steps.find((step) => step.step === "reconcile:settle")).toMatchObject({
    status: "failed",
    detail: expect.stringContaining("cleanup-unknown"),
  });
  expect(renderUpdateRunReport(run).markdown).toContain("Command cleanup failed");
  expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("cleanup outcome unknown"));
  observation.settle.mockResolvedValue(health());
  expect(await reconcileInterruptedUpdateRuns()).toEqual([]);
  expect(observation.settle).toHaveBeenCalledTimes(1);
  expect(getUpdateRun(runId)?.status).toBe("running");
});

it.each(["uncertain", "forced"] as const)(
  "retains a deadline timeout and the later %s cleanup outcome",
  async (outcome) => {
    const runId = interruptedRun();
    const started = createDeferredCore();
    const cleanup = createDeferredCore<"uncertain" | "forced">();
    observation.settle.mockImplementationOnce(async () => {
      retainCommandProcessCleanup(cleanup.promise);
      started.resolve();
      return health();
    });
    let completed = false;
    const pending = reconcileInterruptedUpdateRuns().then((value) => {
      completed = true;
      return value;
    });
    await started.promise;
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(completed).toBe(false);
      await vi.advanceTimersByTimeAsync(INTERRUPTED_UPDATE_SETTLE_TIMEOUT_MS);
      expect(completed).toBe(true);
      expect(await pending).toEqual([]);
      const timedOut = getUpdateRun(runId)!;
      const diagnostic = timedOut.steps.find((step) => step.step === "reconcile:settle")!;
      expect(diagnostic).toMatchObject({ status: "failed" });
      expect(diagnostic.detail).toContain("Command cleanup is still pending");
      expect(diagnostic.detail).toContain(
        `timed-out after ${INTERRUPTED_UPDATE_SETTLE_TIMEOUT_MS} ms`,
      );
      expect(await reconcileInterruptedUpdateRuns()).toEqual([]);
      expect(observation.settle).toHaveBeenCalledTimes(1);
      cleanup.resolve(outcome);
      await vi.advanceTimersByTimeAsync(0);
      const recorded = getUpdateRun(runId)!;
      const terminal = recorded.steps.find((step) => step.step === "reconcile:settle")!;
      expect(recorded.updatedAtMs).toBe(timedOut.updatedAtMs);
      expect(terminal.endedAtMs).toBe(diagnostic.endedAtMs);
      expect(terminal.detail).toContain(
        `timed-out after ${INTERRUPTED_UPDATE_SETTLE_TIMEOUT_MS} ms`,
      );
      if (outcome === "uncertain") {
        expect(terminal.status).toBe("failed");
        expect(terminal.detail).toContain("cleanup-unknown");
        expect(renderUpdateRunReport(recorded).markdown).toContain("Command cleanup failed");
        expect(console.warn).toHaveBeenCalledWith(
          expect.stringContaining("Command cleanup failed"),
        );
        expect(await reconcileInterruptedUpdateRuns()).toEqual([]);
        expect(getUpdateRun(runId)?.status).toBe("running");
      } else {
        expect(terminal.status).toBe("completed");
        expect(terminal.detail).not.toContain("cleanup outcome unknown");
        expect(await reconcileInterruptedUpdateRuns()).toHaveLength(1);
        expect(getUpdateRun(runId)?.status).toBe("succeeded");
      }
    } finally {
      cleanup.resolve("forced");
      await pending;
    }
  },
);
