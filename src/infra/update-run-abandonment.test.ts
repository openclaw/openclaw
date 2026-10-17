import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { UPDATE_RUN_DRIVER_LIMIT } from "../../packages/gateway-protocol/src/update-run-vocabulary.js";
import { createTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createUpdateCommandExecutionGuards } from "../cli/update-cli/update-command-execution-guards.js";
import { createUpdateRunProgress } from "../cli/update-cli/update-command-run.js";
import { createDeferredCore } from "../shared/deferred.js";
import * as pidAlive from "../shared/pid-alive.js";
import { getFileLockProcessStartTime } from "../shared/pid-alive.js";
import { closeStateDatabaseForTest } from "../test-utils/database-cleanup.js";
import { createRetainedUpdateRecovery } from "./update-retained-recovery.test-support.js";
import { inspectUpdateRunAbandonment } from "./update-run-activity.js";
import { readUpdateRunDriver, type UpdateRunDriver } from "./update-run-driver.js";
import {
  adoptUpdateRun,
  createUpdateRun,
  getUpdateRun,
  heartbeatUpdateRun,
  recordUpdateRunPhase,
  recordUpdateRunStep,
} from "./update-run-ledger.js";
import { reconcileUpdateRunsInNativeKernelForTest } from "./update-run-reconciliation.test-support.js";
import { loadUpdateRecovery } from "./update-run-recovery.js";
import { ABANDONED_UPDATE_RUN_MS, UPDATE_RUN_HEARTBEAT_MS } from "./update-run-timeouts.js";
import { runStep } from "./update-runner-command.js";
import type { CommandRunner } from "./update-runner-types.js";

const tempDirs = createTempDirTracker();

let options: { env: { OPENCLAW_STATE_DIR: string } };
const read = (run: { runId: string }) => getUpdateRun(run.runId, options);
const create = (input: Partial<Parameters<typeof createUpdateRun>[0]> = {}) =>
  createUpdateRun({ trigger: "cli", ...input }, options);
const reconcile = (input: Parameters<typeof reconcileUpdateRunsInNativeKernelForTest>[0] = {}) =>
  reconcileUpdateRunsInNativeKernelForTest(input, options);
const adopt = (run: { runId: string }) => adoptUpdateRun(run.runId, options);
const ageRuns = () => vi.advanceTimersByTime(ABANDONED_UPDATE_RUN_MS + 10);

function retain(run: { runId: string }, version = "1.0.0", nextVersion = "2.0.0") {
  const from = {
    root: options.env.OPENCLAW_STATE_DIR,
    nodePath: process.execPath,
    version,
    buildId: null,
  };
  return createRetainedUpdateRecovery(
    { runId: run.runId, from, to: { ...from, version: nextVersion } },
    options,
  );
}

function progressFor(run: { runId: string }) {
  const progressRun = { runId: run.runId, env: options.env };
  const guards = createUpdateCommandExecutionGuards(
    { run: progressRun },
    options.env.OPENCLAW_STATE_DIR,
  );
  return createUpdateRunProgress(progressRun, {}, guards.recordStep);
}

function currentDriver(): UpdateRunDriver {
  const driver = readUpdateRunDriver();
  if (!driver) {
    throw new Error("Test process identity is unavailable");
  }
  return driver;
}

function exitedDriver(): UpdateRunDriver {
  const driver = currentDriver();
  // The current PID belongs to a different generation than the recorded driver.
  return { ...driver, startIdentity: String(Number(driver.startIdentity) + 1) };
}

beforeEach(() => {
  options = { env: { OPENCLAW_STATE_DIR: tempDirs.make("openclaw-update-abandonment-") } };
  // Ledger receipts still need real worker scheduling and monotonic clocks.
  vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
  vi.setSystemTime(new Date("2026-09-07T12:00:00Z"));
});

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await closeStateDatabaseForTest();
  tempDirs.cleanup();
});

it.each(["young", "recovery", "live-driver", "legacy-only"] as const)(
  "keeps protected %s history read-only",
  (shape) => {
    const run = create(shape === "legacy-only" ? { origin: { driver: exitedDriver() } } : {});
    if (shape === "recovery") {
      retain(run, "2026.9.2", "2026.9.3");
    } else if (shape === "live-driver") {
      adopt(run);
    }
    const before = read(run);
    vi.advanceTimersByTime((shape === "young" ? 1 : 25) * 60 * 60_000);
    expect(
      reconcileUpdateRunsInNativeKernelForTest(
        { legacyOnly: shape === "legacy-only" },
        { ...options, readOnly: true },
      ),
    ).toEqual([]);
    expect(read(run)).toEqual(before);
  },
);

it.each([24 * 60 * 60_000, 24 * 60 * 60_000 + 1])(
  "expires untouched legacy admissions after 24h (age=%s)",
  (age) => {
    const run = create({ before: { version: "2026.9.2" } });
    vi.advanceTimersByTime(age);
    const reconciled = reconcile();
    if (age <= 24 * 60 * 60_000) {
      expect(reconciled).toEqual([]);
      expect(read(run)).toEqual(run);
    } else {
      expect(reconciled).toMatchObject([
        {
          runId: run.runId,
          phase: "finished",
          status: "failed",
          reason: "legacy-driver-expired",
        },
      ]);
      expect(read(run)?.steps).toContainEqual(
        expect.objectContaining({ step: "reconcile:abandoned", detail: "legacy-driver-expired" }),
      );
    }
  },
);

it.each([
  { first: "startup reconciliation", reason: "legacy-driver-expired" },
  { first: "new update admission", reason: "superseded" },
])("preserves the terminal reason from $first", ({ first, reason }) => {
  const old = create({ before: { version: "2026.9.2" } });
  vi.advanceTimersByTime(25 * 60 * 60_000);

  if (first === "startup reconciliation") {
    expect(reconcile()).toMatchObject([{ runId: old.runId, status: "failed", reason }]);
  }
  create({ origin: { driver: currentDriver() }, supersedeStaleIdentityless: true });
  const terminal = read(old);
  expect(terminal).toMatchObject({
    status: "failed",
    phase: "finished",
    reason,
    finishedAtMs: Date.now(),
  });
  expect(reconcile()).toEqual([]);
  expect(read(old)).toEqual(terminal);
});

it.each(["automatic", "explicit", "supersede"] as const)(
  "preserves durable recovery during %s cleanup",
  (mode) => {
    const run = create({ origin: mode === "supersede" ? {} : { driver: exitedDriver() } });
    const recovery = retain(run);
    ageRuns();
    if (mode === "supersede") {
      create({ supersedeStaleIdentityless: true });
    } else {
      expect(reconcile({ explicit: mode === "explicit" })).toEqual([]);
    }
    expect(read(run)).toEqual(run);
    expect(loadUpdateRecovery(run.runId, options)).toEqual(recovery);
  },
);

it("preserves unobservable adopters until the parent dies", () => {
  const parent = currentDriver();
  const created = create({ origin: { driver: parent } });
  const inspection = vi.spyOn(pidAlive, "getFileLockProcessStartTime").mockReturnValue(null);
  vi.spyOn(console, "warn").mockImplementation(() => {});
  adopt(created);
  for (let index = 0; index < 150; index++) {
    recordUpdateRunStep(
      created.runId,
      { step: `diagnostic:${index}`, status: "completed" },
      options,
    );
  }
  inspection.mockReturnValue(Number(parent.startIdentity) + 1);
  expect(reconcile({ explicit: true })).toEqual([]);
  vi.advanceTimersByTime(ABANDONED_UPDATE_RUN_MS + 1_000);
  inspection.mockReturnValue(Number(parent.startIdentity));
  expect(reconcile({ explicit: true })).toEqual([]);
  inspection.mockReturnValue(Number(parent.startIdentity) + 1);
  expect(reconcile()).toEqual([]);
  expect(reconcile({ explicit: true })).toMatchObject([
    { runId: created.runId, status: "failed", reason: "abandoned" },
  ]);
});

it("survives heartbeat errors and warns once across steps", async () => {
  const run = adopt(create());
  const progress = progressFor(run);
  progress.onHeartbeat = vi.fn(() => {
    throw new Error("SQLITE_BUSY: database is locked");
  });
  const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
  for (const name of ["install", "build"]) {
    const command = createDeferredCore<Awaited<ReturnType<CommandRunner>>>();
    const started = createDeferredCore();
    const aborted = vi.fn(() => command.reject(new Error("command aborted")));
    const pending = runStep({
      runCommand: (_argv, input) => {
        input.signal?.addEventListener("abort", aborted);
        started.resolve();
        return command.promise;
      },
      name,
      argv: ["pnpm", name],
      cwd: options.env.OPENCLAW_STATE_DIR,
      timeoutMs: ABANDONED_UPDATE_RUN_MS,
      progress,
      stepIndex: 0,
      totalSteps: 2,
    });
    const settled = pending.catch((error: unknown) => error);
    await Promise.race([started.promise, pending]);
    await vi.advanceTimersByTimeAsync(UPDATE_RUN_HEARTBEAT_MS * 2);
    expect(aborted).not.toHaveBeenCalled();
    command.resolve({ stdout: "", stderr: "", code: 0 });
    expect(await settled).toMatchObject({ exitCode: 0 });
    expect(read(run)?.steps).toContainEqual(
      expect.objectContaining({ step: name, status: "completed" }),
    );
  }
  expect(warning).toHaveBeenCalledTimes(1);
  expect(warning).toHaveBeenCalledWith(expect.stringContaining("SQLITE_BUSY"));
});

it("requires explicit recovery for a recent run whose driver exited", () => {
  const run = create({ origin: { driver: exitedDriver() } });
  vi.advanceTimersByTime(ABANDONED_UPDATE_RUN_MS - 1);

  expect(inspectUpdateRunAbandonment(run)).toBeUndefined();
  expect(reconcile()).toEqual([]);
  expect(read(run)).toEqual(run);
  expect(reconcile({ explicit: true })).toMatchObject([
    { runId: run.runId, phase: "finished", status: "failed", reason: "abandoned" },
  ]);
});

it("explicit admission supersedes one stale identityless staging run", () => {
  const old = create({ trigger: "control-ui", before: { version: "2026.9.2" } });
  recordUpdateRunPhase(old.runId, "staging", {}, options);
  ageRuns();

  const next = create({ origin: { driver: currentDriver() }, supersedeStaleIdentityless: true });

  expect(next).toMatchObject({ status: "running", origin: { driver: currentDriver() } });
  expect(read(old)).toMatchObject({
    status: "failed",
    phase: "finished",
    reason: "superseded",
    steps: expect.arrayContaining([
      expect.objectContaining({
        step: "reconcile:superseded",
        status: "failed",
        detail: "operator-started-update-supersedes-inactive-identityless-run",
      }),
    ]),
  });
});

it.each([
  "recent",
  "live",
  "previous-live",
  "multiple",
  "implicit",
  "inherited",
  "campaign",
] as const)("preserves protected rows on %s admission", (kind) => {
  const old = create({
    origin:
      kind === "live"
        ? { driver: currentDriver() }
        : kind === "previous-live"
          ? { previousDrivers: [currentDriver()] }
          : {},
  });
  if (kind !== "recent") {
    ageRuns();
  }
  if (kind === "multiple") {
    create();
  }
  create({
    trigger: kind === "campaign" ? "campaign" : "cli",
    runId: kind === "inherited" ? old.runId : undefined,
    supersedeStaleIdentityless: kind !== "implicit",
  });
  expect(read(old)).toEqual(old);
  if (kind === "recent") {
    expect(reconcile({ explicit: true, runIds: [old.runId] })).toEqual([]);
  }
});

it.each(["resumed", "all-eligible", "new-admission"] as const)(
  "reconciles the complete captured selection only when eligible (%s)",
  (scenario) => {
    const captured = scenario === "new-admission" ? [create()] : [create(), create()];
    const runIds = captured.map((run) => run.runId);
    ageRuns();
    const expected = [...captured];
    if (scenario === "resumed") {
      const updated = recordUpdateRunStep(
        captured[1]!.runId,
        { step: "build", status: "in_progress", startedAtMs: Date.now() },
        options,
      );
      if (!updated) {
        throw new Error("Expected the resumed update run");
      }
      expected[1] = updated;
    } else if (scenario === "new-admission") {
      expected.push(create());
    }
    const reconciled = reconcile({
      explicit: true,
      runIds,
      requireAllActive: scenario !== "resumed",
    });
    if (scenario === "all-eligible") {
      expect(reconciled.map((run) => run.runId).toSorted()).toEqual(runIds.toSorted());
      for (const run of captured) {
        expect(read(run)).toMatchObject({ status: "failed", reason: "abandoned" });
      }
    } else {
      expect(reconciled).toEqual([]);
      expect(expected.map(read)).toEqual(expected);
    }
  },
);

it("automatically reconciles only dead drivers", () => {
  const dead = create({ origin: { driver: exitedDriver() } });
  const live = create({ origin: { driver: currentDriver() } });
  const legacy = create();
  ageRuns();

  expect(reconcile()).toMatchObject([{ runId: dead.runId, status: "failed", reason: "abandoned" }]);
  expect(read(live)).toEqual(live);
  expect(read(legacy)).toEqual(legacy);
});

it("adoption rejects old heartbeats without refreshing activity", () => {
  const oldDriver = exitedDriver();
  const created = create({ origin: { driver: oldDriver } });
  const adopted = adopt(created);
  expect(adopted.origin.driver).toEqual(currentDriver());
  vi.advanceTimersByTime(UPDATE_RUN_HEARTBEAT_MS);

  heartbeatUpdateRun(created.runId, oldDriver, options);
  expect(read(created)).toEqual(adopted);
  expect(adopt(created)).toEqual(adopted);
  heartbeatUpdateRun(created.runId, adopted.origin.driver, options);
  expect(read(created)?.updatedAtMs).toBeGreaterThan(adopted.updatedAtMs);
});

it("cannot adopt a reconciled terminal run", () => {
  const created = create({ origin: { driver: exitedDriver() } });
  recordUpdateRunPhase(created.runId, "staging", {}, options);
  ageRuns();
  const [reconciled] = reconcile();
  expect(reconciled).toMatchObject({
    runId: created.runId,
    status: "failed",
    reason: "abandoned",
  });

  expect(() => adopt(created)).toThrow();
  expect(read(created)).toEqual(reconciled);
});

it("child adoption retains and renews the live parent", () => {
  const parentStart = getFileLockProcessStartTime(process.ppid);
  if (parentStart === null) {
    throw new Error("The test's controlling parent must have an observable start identity.");
  }
  const driver = { ...currentDriver(), pid: process.ppid, startIdentity: String(parentStart) };
  const created = create({ origin: { driver } });
  const run = recordUpdateRunPhase(created.runId, "verifying", {}, options);
  ageRuns();

  const adopted = adopt(run);
  expect(adopted.origin).toMatchObject({ driver: currentDriver(), previousDrivers: [driver] });
  vi.advanceTimersByTime(UPDATE_RUN_HEARTBEAT_MS);
  heartbeatUpdateRun(run.runId, driver, options);
  expect(read(run)?.updatedAtMs).toBeGreaterThan(adopted.updatedAtMs);
  expect(reconcile({ explicit: true })).toEqual([]);
});

it.each(["alive", "unknown", "dead"] as const)(
  "requires previous-driver death for recovery (%s)",
  (liveness) => {
    const previous =
      liveness === "alive"
        ? currentDriver()
        : liveness === "dead"
          ? exitedDriver()
          : { ...currentDriver(), host: "other-host.invalid" };
    const run = create({ origin: { driver: exitedDriver(), previousDrivers: [previous] } });
    vi.advanceTimersByTime(60_000);
    const reconciled = reconcile({ explicit: true });
    expect(reconciled).toHaveLength(liveness === "dead" ? 1 : 0);
    expect(read(run)?.status).toBe(liveness === "dead" ? "failed" : "running");
  },
);

it("adoption deduplicates drivers and removes only dead identities", () => {
  const retained = { ...currentDriver(), host: "other-host.invalid" };
  const run = create({
    origin: { driver: retained, previousDrivers: [retained, currentDriver(), exitedDriver()] },
  });
  const adopted = adopt(run);
  expect(adopted.origin).toMatchObject({ driver: currentDriver(), previousDrivers: [retained] });
  vi.advanceTimersByTime(100);
  expect(adopt(run)).toEqual(adopted);
});

it("refuses adoption at capacity without evicting unknown drivers", () => {
  const drivers = Array.from({ length: UPDATE_RUN_DRIVER_LIMIT }, (_, index) => ({
    ...currentDriver(),
    host: `other-host-${index}.invalid`,
  }));
  const run = create({ origin: { driver: drivers[0], previousDrivers: drivers.slice(1) } });
  expect(() => adopt(run)).toThrow("too many live or unobservable drivers");
  expect(read(run)).toEqual(run);
});

it.each([false, true])("renews slow steps until settlement (failure=%s)", async (fails) => {
  const run = adopt(create());
  const progress = progressFor(run);
  const heartbeat = vi.spyOn(progress, "onHeartbeat");
  const command = createDeferredCore<Awaited<ReturnType<CommandRunner>>>();
  const started = createDeferredCore();
  const pending = runStep({
    runCommand: () => {
      started.resolve();
      return command.promise;
    },
    name: "build",
    argv: ["pnpm", "build"],
    cwd: options.env.OPENCLAW_STATE_DIR,
    timeoutMs: ABANDONED_UPDATE_RUN_MS * 2,
    progress,
    stepIndex: 0,
    totalSteps: 1,
  });
  const settled = fails
    ? expect(pending).rejects.toThrow("build interrupted")
    : expect(pending).resolves.toMatchObject({ exitCode: 0 });
  await Promise.race([started.promise, pending]);
  const admitted = read(run);
  if (!admitted) {
    throw new Error("Started command has no admitted progress receipt");
  }
  // The worker uses its own clock; age the step from its committed admission.
  vi.setSystemTime(admitted.updatedAtMs);
  await vi.advanceTimersByTimeAsync(ABANDONED_UPDATE_RUN_MS + UPDATE_RUN_HEARTBEAT_MS);

  const active = read(run);
  expect(active?.updatedAtMs).toBeGreaterThan(admitted.updatedAtMs + ABANDONED_UPDATE_RUN_MS);
  expect(active?.steps).toContainEqual(
    expect.objectContaining({ step: "build", status: "in_progress" }),
  );
  expect(reconcile({ explicit: true })).toEqual([]);

  if (fails) {
    command.reject(new Error("build interrupted"));
  } else {
    command.resolve({ stdout: "", stderr: "", code: 0 });
  }
  await settled;
  expect(heartbeat).toHaveBeenCalled();
  heartbeat.mockClear();
  const finished = read(run);
  await vi.advanceTimersByTimeAsync(UPDATE_RUN_HEARTBEAT_MS * 2);
  expect(heartbeat).not.toHaveBeenCalled();
  expect(read(run)).toEqual(finished);
});
