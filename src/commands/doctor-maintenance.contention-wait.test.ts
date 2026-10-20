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
  return { databasePath, holder, before: fs.readFileSync(databasePath) };
}

/** The published driver recorded this update's rehearsal Doctor before activation. */
function recordRehearsalDoctor(durationMs: number) {
  const { runId } = createUpdateRun({ trigger: "cli" });
  recordUpdateRunStep(runId, {
    step: "candidate-doctor",
    status: "completed",
    startedAtMs: 1_000,
    endedAtMs: 1_000 + durationMs,
  });
  closeOpenClawStateDatabaseForTest();
}

/** `startMs` is how long this Doctor process ran before entering maintenance. */
function startDoctor(startMs = 0) {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] });
  const clock = { ms: startMs };
  vi.spyOn(performance, "now").mockImplementation(() => clock.ms);
  const firstLog = createDeferredCore();
  const log = vi.fn((..._args: unknown[]) => firstLog.resolve());
  let settled = false;
  // Published drivers can run the activation Doctor without an update authority callback.
  const result = beginDoctorMaintenance({
    options: { repair: true, nonInteractive: true },
    root: null,
    runtime: { log, error: vi.fn(), exit: vi.fn() },
  }).then(
    (maintenance) => {
      settled = true;
      return { maintenance };
    },
    (error: unknown) => {
      settled = true;
      return { error };
    },
  );
  const advanceTo = async (ms: number) => {
    clock.ms = ms;
    await vi.advanceTimersToNextTimerAsync();
  };
  // Without the wait, admission settles before logging anything.
  const firstWait = Promise.race([firstLog.promise, result]);
  return { log, result, advanceTo, firstWait, isSettled: () => settled };
}

it("waits for a transient OpenClaw command to release state before update Doctor maintenance", async () => {
  const { databasePath, holder, before } = holdState("agent-embedded", true);
  const doctor = startDoctor();
  try {
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
  } finally {
    holder.release();
  }
});

it("fails update Doctor admission at the wait deadline, naming the holder and next step", async () => {
  const { holder } = holdState("agent-embedded", true);
  // Time Doctor spent before maintenance comes out of the same step allowance.
  const doctor = startDoctor(100_000);
  try {
    await doctor.firstWait;
    expect(doctor.log).toHaveBeenCalledWith(expect.stringContaining("Waiting up to 1100 s"));
    await doctor.advanceTo(FALLBACK_DEADLINE_MS - 1);
    expect(doctor.isSettled()).toBe(false);
    await doctor.advanceTo(FALLBACK_DEADLINE_MS);
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
      `Doctor waited 1100 s for the OpenClaw agent-embedded process ${process.ppid} to finish;`,
    );
    expect(message).toContain(`The holder ${process.ppid} is alive on this host, stop it first.`);
    expect(message).toContain("then run openclaw doctor --fix from an independent shell.");
  } finally {
    holder.release();
  }
});

it("keeps twice this update's rehearsal Doctor time for Doctor's own work", async () => {
  const { holder } = holdState("agent-embedded", true);
  // A slow host: 30 min less 2 x 400 s leaves 1000 s for waiting.
  recordRehearsalDoctor(400_000);
  const doctor = startDoctor();
  try {
    await doctor.firstWait;
    expect(doctor.log).toHaveBeenCalledWith(expect.stringContaining("Waiting up to 1000 s"));
    await doctor.advanceTo(999_999);
    expect(doctor.isSettled()).toBe(false);
    await doctor.advanceTo(1_000_000);
    expect(await doctor.result).toMatchObject({
      error: expect.objectContaining({ message: expect.stringContaining("Doctor waited 1000 s") }),
    });
  } finally {
    holder.release();
  }
});

it.each([
  { name: "manual doctor --fix with a transient holder", role: "agent-embedded", update: false },
  { name: "update Doctor with a Gateway holder", role: "gateway", update: true },
  // This process's own owner cannot release while Doctor waits on it.
  {
    name: "update Doctor with its own process's owner",
    role: "sqlite-maintenance",
    update: true,
    own: true,
  },
] as const)("keeps immediate contention failure for $name", async (fixture) => {
  const { holder } = holdState(
    fixture.role,
    fixture.update,
    "own" in fixture ? process.pid : undefined,
  );
  const doctor = startDoctor();
  try {
    const completed = await doctor.result;
    expect(completed).toMatchObject({
      error: expect.objectContaining({
        message: expect.stringContaining("OpenClaw state database is busy at"),
      }),
    });
    expect(doctor.log).not.toHaveBeenCalledWith(expect.stringContaining("Waiting up to"));
  } finally {
    holder.release();
  }
});
