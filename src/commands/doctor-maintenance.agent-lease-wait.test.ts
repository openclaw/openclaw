import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { resolveGatewayStateOwnerPath } from "../infra/gateway-state-owner.js";
import {
  collectUpdateDoctorFailureFacts,
  DoctorMaintenanceRefusalError,
} from "../infra/update-doctor-result.js";
import { createDeferredCore } from "../shared/deferred.js";
import { getFileLockProcessStartTime } from "../shared/pid-alive.js";
import { claimOpenClawAgentDatabaseLease } from "../state/openclaw-agent-db-lease.js";
import {
  closeOpenClawStateDatabaseForTest,
  withOpenClawStateStartupMigrationCheckpointDatabase,
} from "../state/openclaw-state-db.js";
import { DOCTOR_MAINTENANCE_CONTENTION_WAIT_MS } from "./doctor-maintenance-foreground.js";
import { beginDoctorMaintenance } from "./doctor-maintenance.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  closeOpenClawStateDatabaseForTest();
});

/** Another live OpenClaw process (the test runner's parent) holds an agent database lease. */
function holdForeignLease(options: { update: boolean; external?: boolean; own?: boolean }) {
  const stateDir = dirs.make("doctor-agent-lease-wait-");
  vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
  vi.stubEnv("OPENCLAW_CONFIG_PATH", path.join(stateDir, "openclaw.json"));
  vi.stubEnv("OPENCLAW_UPDATE_IN_PROGRESS", options.update ? "1" : "");
  vi.stubEnv("OPENCLAW_SUPERVISOR_MODE", options.external ? "external" : "");
  withOpenClawStateStartupMigrationCheckpointDatabase(() => {});
  const leaseId = claimOpenClawAgentDatabaseLease({
    agentId: "main",
    path: path.join(stateDir, "agents/main/agent/openclaw-agent.sqlite"),
  });
  closeOpenClawStateDatabaseForTest();
  const databasePath = path.join(stateDir, "state", "openclaw.sqlite");
  // Doctor and its worker threads share process.pid; a lease there is Doctor's own.
  const holderPid = options.own ? process.pid : process.ppid;
  // The claim API records the caller; rewrite it as the other process's row.
  const raw = new DatabaseSync(databasePath);
  raw
    .prepare(
      "UPDATE agent_database_leases SET owner_pid = ?, owner_start_time = ? WHERE lease_id = ?",
    )
    .run(holderPid, getFileLockProcessStartTime(holderPid), leaseId);
  raw.close();
  return {
    databasePath,
    holderPid,
    ownerPath: resolveGatewayStateOwnerPath(databasePath),
    // The holder records its close through its own shared-state connection.
    release() {
      const holder = new DatabaseSync(databasePath);
      holder.prepare("DELETE FROM agent_database_leases WHERE lease_id = ?").run(leaseId);
      holder.close();
    },
  };
}

function startDoctor() {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] });
  const clock = { ms: 0 };
  vi.spyOn(performance, "now").mockImplementation(() => clock.ms);
  const firstLog = createDeferredCore();
  const log = vi.fn((..._args: unknown[]) => firstLog.resolve());
  let settled = false;
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
  return {
    log,
    result,
    advanceTo,
    firstWait: Promise.race([firstLog.promise, result]),
    isSettled: () => settled,
  };
}

it("waits, holding no state ownership, for another process to close its agent database", async () => {
  const holder = holdForeignLease({ update: true });
  const doctor = startDoctor();
  await doctor.firstWait;
  expect(doctor.log).toHaveBeenCalledWith(
    `Waiting up to 660 s for OpenClaw process ${holder.holderPid} to close an agent database before Doctor maintenance. Let it finish, or stop it to continue sooner.`,
  );
  // The holder must write shared state to close; Doctor's ownership would refuse it.
  expect(fs.existsSync(holder.ownerPath)).toBe(false);
  await doctor.advanceTo(45_000);
  expect(doctor.log).toHaveBeenCalledWith(
    `Still waiting for OpenClaw process ${holder.holderPid} to close an agent database (45 s of 660 s).`,
  );
  await doctor.advanceTo(DOCTOR_MAINTENANCE_CONTENTION_WAIT_MS - 10_000);
  expect(doctor.isSettled()).toBe(false);
  expect(fs.existsSync(holder.ownerPath)).toBe(false);
  holder.release();
  await doctor.advanceTo(DOCTOR_MAINTENANCE_CONTENTION_WAIT_MS - 8_000);
  const completed = await doctor.result;
  expect(completed).toHaveProperty("maintenance");
  expect(doctor.log).toHaveBeenCalledWith(
    "Agent databases closed after 652 s; continuing Doctor maintenance.",
  );
  await ("maintenance" in completed ? completed.maintenance?.finish({}) : undefined);
});

it("fails update Doctor admission after the wait budget, naming the lease holder", async () => {
  const holder = holdForeignLease({ update: true });
  const doctor = startDoctor();
  await doctor.firstWait;
  await doctor.advanceTo(DOCTOR_MAINTENANCE_CONTENTION_WAIT_MS - 1);
  expect(doctor.isSettled()).toBe(false);
  await doctor.advanceTo(DOCTOR_MAINTENANCE_CONTENTION_WAIT_MS);
  const completed = await doctor.result;
  const error = "error" in completed ? completed.error : undefined;
  expect(error).toBeInstanceOf(DoctorMaintenanceRefusalError);
  expect((error as DoctorMaintenanceRefusalError).refusal).toEqual({
    kind: "deferred",
    reason: "agent-database-in-use",
  });
  const message = `Doctor could not enter maintenance. Waited 660 s; OpenClaw process ${holder.holderPid} still has an agent database open. Stop other OpenClaw processes using this state, then retry the update.`;
  expect((error as Error).message).toBe(message);
  expect(collectUpdateDoctorFailureFacts(error)).toEqual([
    { check: "doctor", code: "agent-database-lease-active", message },
  ]);
  // A failed admission releases ownership for the holder and the next Doctor.
  expect(fs.existsSync(holder.ownerPath)).toBe(false);
});

it.each([
  { name: "manual doctor --fix", update: false, external: false },
  { name: "a lease held by Doctor's own process", update: true, external: false, own: true },
  {
    name: "an externally supervised Gateway that may hold the lease",
    update: true,
    external: true,
  },
])("keeps the immediate agent lease refusal for $name", async ({ update, external, own }) => {
  holdForeignLease({ update, external, own });
  const doctor = startDoctor();
  const completed = await doctor.result;
  expect(
    collectUpdateDoctorFailureFacts("error" in completed ? completed.error : undefined),
  ).toEqual([
    {
      check: "doctor",
      code: "agent-database-lease-active",
      message:
        "Doctor could not enter maintenance. An agent database is in use. Stop other OpenClaw processes using this state, then retry the update.",
    },
  ]);
  expect(doctor.log).not.toHaveBeenCalledWith(expect.stringContaining("Waiting up to"));
});
