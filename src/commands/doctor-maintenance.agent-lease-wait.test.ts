import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { readGatewayLockProcessNamespace } from "../infra/gateway-lock-payload.js";
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

function holdForeignLease(options: { update: boolean; externalPolicy?: boolean; own?: boolean }) {
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

function holdState(databasePath: string, gateway = false) {
  const stateDir = path.dirname(path.dirname(databasePath));
  return acquireGatewayStateOwner({
    databasePath,
    payload: {
      pid: gateway ? process.pid : process.ppid,
      processNamespace: readGatewayLockProcessNamespace(),
      role: gateway ? "gateway" : "agent-embedded",
      createdAt: new Date().toISOString(),
      configPath: path.join(stateDir, "openclaw.json"),
      stateDir,
    },
  });
}

function startDoctor(waitForMaintenance = false) {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] });
  let now = 0;
  vi.spyOn(performance, "now").mockImplementation(() => now);
  const listeners = new Set<(message: string) => void>();
  const log = vi.fn((message: unknown) =>
    listeners.forEach((listener) => listener(String(message))),
  );
  let settled = false;
  const result = beginDoctorMaintenance({
    options: { repair: true, nonInteractive: true },
    waitForMaintenance,
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
    advanceTo: async (ms: number) => {
      now = ms;
      await vi.advanceTimersToNextTimerAsync();
    },
    logged,
    firstWait: logged("Waiting up to"),
    isSettled: () => settled,
  };
}

async function reachDeadline(doctor: ReturnType<typeof startDoctor>) {
  await doctor.advanceTo(FALLBACK_DEADLINE_MS - 1);
  expect(doctor.isSettled()).toBe(false);
  await doctor.advanceTo(FALLBACK_DEADLINE_MS);
  return doctor.result;
}

const failureFacts = (message: string) => [
  { check: "doctor", code: "agent-database-lease-active", message },
];
const refusalMessage = (detail = "An agent database is in use.") =>
  `Doctor could not enter maintenance. ${detail} Stop the Gateway and other OpenClaw processes or reboot, then rerun openclaw doctor --fix.`;

it.each([
  { name: "update Doctor", update: true, externalPolicy: false, waitForMaintenance: false },
  {
    name: "a published updater's activation Doctor",
    update: true,
    externalPolicy: true,
    waitForMaintenance: false,
  },
  {
    name: "startup credential preparation",
    update: false,
    externalPolicy: false,
    waitForMaintenance: true,
  },
  {
    name: "externally managed startup credential preparation",
    update: false,
    externalPolicy: true,
    waitForMaintenance: true,
  },
])(
  "$name waits, holding no state ownership, for another process to close its agent database",
  async ({ update, externalPolicy, waitForMaintenance }) => {
    const holder = holdForeignLease({ update, externalPolicy });
    const doctor = startDoctor(waitForMaintenance);
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

it.each([false, true])(
  "shares the state/agent wait deadline (state wait=%s)",
  async (stateWait) => {
    const holder = holdForeignLease({ update: true });
    const stateHolder = stateWait ? holdState(holder.databasePath) : undefined;
    try {
      const doctor = startDoctor();
      if (stateHolder) {
        await doctor.logged("Waiting up to 1200 s for the OpenClaw agent-embedded process");
        stateHolder.release();
        await doctor.advanceTo(900_000);
        await doctor.logged("to close an agent database");
        expect(doctor.log).toHaveBeenCalledWith(
          `Waiting up to 300 s for OpenClaw process ${holder.holderPid} to close an agent database before Doctor maintenance. Let it finish, or stop it to continue sooner.`,
        );
      } else {
        await doctor.firstWait;
      }
      const completed = await reachDeadline(doctor);
      const error = "error" in completed ? completed.error : undefined;
      expect(error).toBeInstanceOf(DoctorMaintenanceRefusalError);
      const message = refusalMessage(`Waited 1200 s; database held by PID ${holder.holderPid}.`);
      expect(error).toMatchObject({ message });
      expect((error as DoctorMaintenanceRefusalError).refusal).toEqual({
        kind: "deferred",
        reason: "agent-database-in-use",
      });
      expect(collectUpdateDoctorFailureFacts(error)).toEqual(failureFacts(message));
      // A failed admission releases ownership for the holder and the next Doctor.
      expect(fs.existsSync(holder.ownerPath)).toBe(false);
    } finally {
      stateHolder?.release();
    }
  },
);

it.each([
  { name: "manual doctor --fix", update: false },
  { name: "a lease held by Doctor's own process", update: true, own: true },
  { name: "a live Gateway under the external policy", update: true, gateway: true },
  {
    name: "startup with a live Gateway under the external policy",
    update: false,
    gateway: true,
    waitForMaintenance: true,
  },
])(
  "refuses active agent leases immediately ($name)",
  async ({ update, own, gateway, waitForMaintenance }) => {
    const holder = holdForeignLease({ update, own, externalPolicy: gateway });
    // The serving Gateway may own the lease; its lifecycle lock would mask the refusal.
    const serving = gateway ? holdState(holder.databasePath, true) : undefined;
    try {
      const doctor = startDoctor(waitForMaintenance);
      const completed = await doctor.result;
      expect(
        collectUpdateDoctorFailureFacts("error" in completed ? completed.error : undefined),
      ).toEqual(failureFacts(refusalMessage()));
      expect(doctor.log).not.toHaveBeenCalledWith(expect.stringContaining("Waiting up to"));
    } finally {
      serving?.release();
    }
  },
);
