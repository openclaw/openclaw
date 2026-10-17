import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  acquireGatewayStateOwner,
  resolveGatewayStateOwnerPath,
} from "../infra/gateway-state-owner.js";
import {
  collectUpdateDoctorFailureFacts,
  DoctorMaintenanceRefusalError,
} from "../infra/update-doctor-result.js";
import { getFileLockProcessStartTime } from "../shared/pid-alive.js";
import { claimOpenClawAgentDatabaseLease } from "../state/openclaw-agent-db-lease.js";
import {
  closeOpenClawStateDatabaseForTest,
  withOpenClawStateStartupMigrationCheckpointDatabase,
} from "../state/openclaw-state-db.js";
import { beginDoctorMaintenance } from "./doctor-maintenance.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
// With no recorded rehearsal, waits end 30 min after Doctor started, less the 10 min floor.
const FALLBACK_DEADLINE_MS = 1_200_000;

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  closeOpenClawStateDatabaseForTest();
});

/** Another live OpenClaw process (the test runner's parent) holds an agent database lease. */
function holdForeignLease(options: {
  update: boolean;
  /** Published updaters run activation Doctor with the external service policy. */
  externalPolicy?: boolean;
  own?: boolean;
}) {
  const stateDir = dirs.make("doctor-agent-lease-wait-");
  vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
  vi.stubEnv("OPENCLAW_CONFIG_PATH", path.join(stateDir, "openclaw.json"));
  vi.stubEnv("OPENCLAW_UPDATE_IN_PROGRESS", options.update ? "1" : "");
  vi.stubEnv("OPENCLAW_SERVICE_REPAIR_POLICY", options.externalPolicy ? "external" : "");
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
  const listeners = new Set<(message: string) => void>();
  const log = vi.fn((message: unknown) =>
    listeners.forEach((listener) => listener(String(message))),
  );
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
  // Settles once Doctor logs a matching line, or once admission settles without one.
  const logged = (fragment: string) =>
    Promise.race([
      new Promise<void>((resolve) => {
        listeners.add((message) => message.includes(fragment) && resolve());
      }),
      result,
    ]);
  return {
    log,
    result,
    advanceTo,
    logged,
    firstWait: logged("Waiting up to"),
    isSettled: () => settled,
  };
}

it.each([
  { name: "update Doctor", externalPolicy: false },
  { name: "a published updater's activation Doctor", externalPolicy: true },
])(
  "$name waits, holding no state ownership, for another process to close its agent database",
  async ({ externalPolicy }) => {
    const holder = holdForeignLease({ update: true, externalPolicy });
    const doctor = startDoctor();
    await doctor.firstWait;
    expect(doctor.log).toHaveBeenCalledWith(
      `Waiting up to 1200 s for OpenClaw process ${holder.holderPid} to close an agent database before Doctor maintenance. Let it finish, or stop it to continue sooner.`,
    );
    // The holder must write shared state to close; Doctor's ownership would refuse it.
    expect(fs.existsSync(holder.ownerPath)).toBe(false);
    await doctor.advanceTo(45_000);
    expect(doctor.log).toHaveBeenCalledWith(
      `Still waiting for OpenClaw process ${holder.holderPid} to close an agent database (45 s of 1200 s).`,
    );
    await doctor.advanceTo(FALLBACK_DEADLINE_MS - 10_000);
    expect(doctor.isSettled()).toBe(false);
    expect(fs.existsSync(holder.ownerPath)).toBe(false);
    holder.release();
    await doctor.advanceTo(FALLBACK_DEADLINE_MS - 8_000);
    const completed = await doctor.result;
    expect(completed).toHaveProperty("maintenance");
    expect(doctor.log).toHaveBeenCalledWith(
      "Agent databases closed after 1192 s; continuing Doctor maintenance.",
    );
    await ("maintenance" in completed ? completed.maintenance?.finish({}) : undefined);
  },
);

it("fails update Doctor admission at the wait deadline, naming the lease holder", async () => {
  const holder = holdForeignLease({ update: true });
  const doctor = startDoctor();
  await doctor.firstWait;
  await doctor.advanceTo(FALLBACK_DEADLINE_MS - 1);
  expect(doctor.isSettled()).toBe(false);
  await doctor.advanceTo(FALLBACK_DEADLINE_MS);
  const completed = await doctor.result;
  const error = "error" in completed ? completed.error : undefined;
  expect(error).toBeInstanceOf(DoctorMaintenanceRefusalError);
  expect((error as DoctorMaintenanceRefusalError).refusal).toEqual({
    kind: "deferred",
    reason: "agent-database-in-use",
  });
  const message = `Doctor could not enter maintenance. Waited 1200 s; OpenClaw process ${holder.holderPid} still has an agent database open. Stop other OpenClaw processes using this state, then retry the update.`;
  expect((error as Error).message).toBe(message);
  expect(collectUpdateDoctorFailureFacts(error)).toEqual([
    { check: "doctor", code: "agent-database-lease-active", message },
  ]);
  // A failed admission releases ownership for the holder and the next Doctor.
  expect(fs.existsSync(holder.ownerPath)).toBe(false);
});

it("shares one deadline with the state wait, so a long first wait shortens the lease wait", async () => {
  const lease = holdForeignLease({ update: true });
  const stateDir = path.dirname(path.dirname(lease.databasePath));
  const stateHolder = acquireGatewayStateOwner({
    databasePath: lease.databasePath,
    payload: {
      pid: process.ppid,
      role: "agent-embedded",
      createdAt: new Date().toISOString(),
      configPath: path.join(stateDir, "openclaw.json"),
      stateDir,
    },
  });
  try {
    const doctor = startDoctor();
    await doctor.logged(`Waiting up to 1200 s for the OpenClaw agent-embedded process`);
    stateHolder.release();
    await doctor.advanceTo(900_000);
    // The lease wait gets only what the state wait left of the same deadline.
    await doctor.logged("to close an agent database");
    expect(doctor.log).toHaveBeenCalledWith(
      `Waiting up to 300 s for OpenClaw process ${lease.holderPid} to close an agent database before Doctor maintenance. Let it finish, or stop it to continue sooner.`,
    );
    await doctor.advanceTo(FALLBACK_DEADLINE_MS - 1);
    expect(doctor.isSettled()).toBe(false);
    await doctor.advanceTo(FALLBACK_DEADLINE_MS);
    const completed = await doctor.result;
    expect((completed as { error?: Error }).error?.message).toContain(
      `Waited 1200 s; OpenClaw process ${lease.holderPid} still has an agent database open.`,
    );
  } finally {
    stateHolder.release();
  }
});

it.each([
  { name: "manual doctor --fix", update: false },
  { name: "a lease held by Doctor's own process", update: true, own: true },
  { name: "a live Gateway under the external policy", update: true, gateway: true },
])("keeps the immediate agent lease refusal for $name", async ({ update, own, gateway }) => {
  const holder = holdForeignLease({ update, own, externalPolicy: gateway });
  // The serving Gateway may own the lease; its lifecycle lock would mask the refusal.
  const serving = gateway
    ? acquireGatewayStateOwner({
        databasePath: holder.databasePath,
        payload: {
          pid: process.pid,
          role: "gateway",
          createdAt: new Date().toISOString(),
          configPath: path.join(path.dirname(path.dirname(holder.databasePath)), "openclaw.json"),
          stateDir: path.dirname(path.dirname(holder.databasePath)),
        },
      })
    : undefined;
  try {
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
  } finally {
    serving?.release();
  }
});
