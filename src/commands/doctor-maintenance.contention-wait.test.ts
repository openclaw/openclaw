import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  readGatewayLockProcessNamespace,
  type GatewayLockRole,
} from "../infra/gateway-lock-payload.js";
import { acquireGatewayStateOwner } from "../infra/gateway-state-owner.js";
import { DoctorMaintenanceRefusalError } from "../infra/update-doctor-result.js";
import { createUpdateRun, recordUpdateRunStep } from "../infra/update-run-ledger.js";
import { createDeferredCore } from "../shared/deferred.js";
import {
  closeOpenClawStateDatabaseForTest,
  withOpenClawStateStartupMigrationCheckpointDatabase,
} from "../state/openclaw-state-db.js";
import { beginDoctorMaintenance } from "./doctor-maintenance.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  closeOpenClawStateDatabaseForTest();
});

// With no recorded rehearsal, waits end 30 min after Doctor started, less the 10 min floor.
const FALLBACK_DEADLINE_MS = 1_200_000;

function holdState(role: GatewayLockRole, update: boolean, pid = process.ppid) {
  const stateDir = dirs.make("doctor-contention-wait-");
  vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
  vi.stubEnv("OPENCLAW_CONFIG_PATH", path.join(stateDir, "openclaw.json"));
  vi.stubEnv("OPENCLAW_UPDATE_IN_PROGRESS", update ? "1" : "");
  withOpenClawStateStartupMigrationCheckpointDatabase(() => {});
  closeOpenClawStateDatabaseForTest();
  const databasePath = path.join(stateDir, "state", "openclaw.sqlite");
  // The in-process owner stands in for another OpenClaw process: Doctor never waits
  // on its own PID, so the recorded holder is this test's parent process.
  const holder = acquireGatewayStateOwner({
    databasePath,
    payload: {
      pid,
      processNamespace: readGatewayLockProcessNamespace(),
      role,
      createdAt: new Date().toISOString(),
      configPath: path.join(stateDir, "openclaw.json"),
      stateDir,
    },
  });
  return {
    databasePath,
    holder,
    before: fs.readFileSync(databasePath),
    startDoctor,
    [Symbol.dispose]: () => holder.release(),
  };
}

/** `startMs` is how long this Doctor process ran before entering maintenance. */
function startDoctor(startMs = 0) {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] });
  const clock = { ms: startMs };
  vi.spyOn(performance, "now").mockImplementation(() => clock.ms);
  const firstLog = createDeferredCore();
  const log = vi.fn((..._args: unknown[]) => firstLog.resolve());
  let settled = false;
  const result = beginDoctorMaintenance({
    options: { repair: true, nonInteractive: true },
    root: null,
    runtime: { log, error: vi.fn(), exit: vi.fn() },
  })
    .then(
      (maintenance) => ({ maintenance }),
      (error: unknown) => ({ error }),
    )
    .finally(() => {
      settled = true;
    });
  const advanceTo = async (ms: number) => {
    clock.ms = ms;
    await vi.advanceTimersToNextTimerAsync();
  };
  // Without the wait, admission settles before logging anything.
  const firstWait = Promise.race([firstLog.promise, result]);
  return { log, result, advanceTo, firstWait, isSettled: () => settled };
}

it("waits for a transient OpenClaw command to release state before update Doctor maintenance", async () => {
  using state = holdState("agent-embedded", true);
  const { databasePath, holder, before } = state;
  const doctor = state.startDoctor();
  await doctor.firstWait;
  expect(doctor.log).toHaveBeenCalledWith(
    `Waiting up to 1200 s for the OpenClaw agent-embedded process ${process.ppid} to release ${databasePath} before Doctor maintenance. Let it finish, or stop it to continue sooner.`,
  );
  await doctor.advanceTo(45_000);
  expect(doctor.log).toHaveBeenCalledWith(
    `Still waiting for the OpenClaw agent-embedded process ${process.ppid} to release ${databasePath} (45 s of 1200 s).`,
  );
  // Waiting holds no lock and writes nothing; the holder can finish and release.
  await doctor.advanceTo(FALLBACK_DEADLINE_MS - 1_000);
  expect(doctor.isSettled()).toBe(false);
  expect(fs.readFileSync(databasePath)).toEqual(before);
  holder.release();
  await doctor.advanceTo(FALLBACK_DEADLINE_MS - 500);
  const completed = await doctor.result;
  expect(completed).toHaveProperty("maintenance");
  expect(doctor.log).toHaveBeenCalledWith(
    "State ownership released after 1200 s; continuing Doctor maintenance.",
  );
  await ("maintenance" in completed ? completed.maintenance?.finish({}) : undefined);
});

it.each([
  ["elapsed startup time", 100_000, 0, FALLBACK_DEADLINE_MS, 1100],
  ["twice the rehearsal reserved for Doctor", 0, 400_000, 1_000_000, 1000],
] as const)(
  "enforces the wait deadline with %s",
  async (_name, startMs, rehearsalMs, deadline, seconds) => {
    using state = holdState("agent-embedded", true);
    if (rehearsalMs) {
      const { runId } = createUpdateRun({ trigger: "cli" });
      recordUpdateRunStep(runId, {
        step: "candidate-doctor",
        status: "completed",
        startedAtMs: 1_000,
        endedAtMs: 1_000 + rehearsalMs,
      });
      closeOpenClawStateDatabaseForTest();
    }
    const doctor = state.startDoctor(startMs);
    await doctor.firstWait;
    expect(doctor.log).toHaveBeenCalledWith(expect.stringContaining(`Waiting up to ${seconds} s`));
    await doctor.advanceTo(deadline - 1);
    expect(doctor.isSettled()).toBe(false);
    await doctor.advanceTo(deadline);
    const completed = await doctor.result;
    const error = "error" in completed ? completed.error : undefined;
    expect(error).toBeInstanceOf(DoctorMaintenanceRefusalError);
    // Contention stays a deferred refusal: no data is at risk.
    expect((error as DoctorMaintenanceRefusalError).refusal).toEqual({
      kind: "deferred",
      reason: "coordinator-contention",
    });
    const message = (error as Error).message;
    expect(message).toContain("Doctor could not enter maintenance.");
    expect(message).toContain(
      `Doctor waited ${seconds} s for the OpenClaw agent-embedded process ${process.ppid} to finish;`,
    );
    expect(message).toContain(`The holder ${process.ppid} is alive on this host, stop it first.`);
    expect(message).toContain("then run openclaw doctor --fix from an independent shell.");
  },
);

it.each([
  ["manual doctor --fix with a transient holder", "agent-embedded", false, process.ppid],
  ["update Doctor with a Gateway holder", "gateway", true, process.ppid],
  // This process's own owner cannot release while Doctor waits on it.
  ["update Doctor with its own process's owner", "sqlite-maintenance", true, process.pid],
] as const)("keeps immediate contention failure for %s", async (_name, role, update, pid) => {
  using state = holdState(role, update, pid);
  const doctor = state.startDoctor();
  const completed = await doctor.result;
  expect(completed).toMatchObject({
    error: { message: expect.stringContaining("OpenClaw state database is busy at") },
  });
  expect(doctor.log).not.toHaveBeenCalledWith(expect.stringContaining("Waiting up to"));
});
