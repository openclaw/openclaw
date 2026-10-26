import fs from "node:fs";
import { hostname } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { TICK_INTERVAL_MS } from "../gateway/server-constants.js";
import { readGatewayLockProcessNamespace } from "../infra/gateway-lock-payload.js";
import { acquireGatewayLock, resolveGatewayLockPaths } from "../infra/gateway-lock.js";
import {
  GATEWAY_SHUTDOWN_RESERVE_MS,
  GATEWAY_SHUTDOWN_TIMEOUT_MS,
} from "../infra/gateway-shutdown-budget.js";
import {
  acquireGatewayStateOwner,
  resolveGatewayStateOwnerPath,
} from "../infra/gateway-state-owner.js";
import { resolveGatewayRestartDeferralTimeoutMs } from "../infra/restart-budget.js";
import { DoctorMaintenanceRefusalError } from "../infra/update-doctor-result.js";
import { createDeferredCore } from "../shared/deferred.js";
import { getFileLockProcessStartTime } from "../shared/pid-alive.js";
import { claimOpenClawAgentDatabaseLease } from "../state/openclaw-agent-db-lease.js";
import { getOpenClawDatabaseMaintenanceScope } from "../state/openclaw-state-db-async-lifecycle.js";
import {
  closeOpenClawStateDatabaseForTest,
  withOpenClawStateStartupMigrationCheckpointDatabase,
} from "../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { beginDoctorRepair } from "./doctor-maintenance.admission.test-support.js";
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

function startDoctor(waitForMaintenance = false, assertCurrent?: () => void) {
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
    assertCurrent,
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
    advanceTo: async (ms = now) => {
      now = ms;
      await vi.advanceTimersToNextTimerAsync();
    },
    logged,
    firstWait: logged("Waiting"),
    isSettled: () => settled,
  };
}

async function reachDeadline(doctor: ReturnType<typeof startDoctor>) {
  await doctor.advanceTo(FALLBACK_DEADLINE_MS - 1);
  expect(doctor.isSettled()).toBe(false);
  await doctor.advanceTo(FALLBACK_DEADLINE_MS);
  return doctor.result;
}

it.each([
  ["update Doctor", true, false, false],
  ["a published updater's activation Doctor", true, true, false],
  ["startup credential preparation", false, false, true],
  ["externally managed startup credential preparation", false, true, true],
] as const)(
  "%s waits, holding no state ownership, for another process to close its agent database",
  async (_name, update, externalPolicy, waitForMaintenance) => {
    const holder = holdForeignLease({ update, externalPolicy });
    const doctor = startDoctor(waitForMaintenance);
    await doctor.firstWait;
    // The holder must write shared state to close; Doctor's ownership would refuse it.
    expect(fs.existsSync(holder.ownerPath)).toBe(false);
    await doctor.advanceTo(45_000);
    expect(doctor.log).toHaveBeenCalledWith(expect.stringContaining("Still waiting"));
    await doctor.advanceTo(FALLBACK_DEADLINE_MS - 10_000);
    expect(doctor.isSettled()).toBe(false);
    expect(fs.existsSync(holder.ownerPath)).toBe(false);
    holder.release();
    await doctor.advanceTo(FALLBACK_DEADLINE_MS - 8_000);
    const completed = await doctor.result;
    expect(completed).toHaveProperty("maintenance");
    await ("maintenance" in completed ? completed.maintenance?.finish({}) : undefined);
  },
);

it("keeps legacy startup excluded until Doctor's own resources drain", async () => {
  await withOpenClawTestState({ scenario: "external-service" }, async (state) => {
    const maintenance = expectDefined(await beginDoctorRepair(), "Doctor maintenance");
    const { stateLockPath } = resolveGatewayLockPaths(state.env);
    const claimLegacyLock = () => {
      fs.mkdirSync(path.dirname(stateLockPath), { recursive: true });
      fs.closeSync(fs.openSync(stateLockPath, "wx", 0o600));
      fs.unlinkSync(stateLockPath);
    };
    const closing = createDeferredCore();
    const settle = createDeferredCore();
    let releasing: Promise<void> | undefined;
    try {
      await maintenance.run(async () => {
        const child = expectDefined(
          await acquireGatewayLock({
            env: state.env,
            role: "sqlite-maintenance",
            allowInTests: true,
            timeoutMs: 0,
          }),
          "nested maintenance",
        );
        await child.release();
        expect(claimLegacyLock).toThrow(/EEXIST/);
        expectDefined(getOpenClawDatabaseMaintenanceScope(), "Doctor resource scope").own(
          {},
          "shared-resources",
          async () => {
            closing.resolve();
            await settle.promise;
          },
        );
      });
      releasing = maintenance.release();
      await awaitGateBeforeSettlement(
        closing.promise,
        releasing,
        "Doctor released before draining its resource",
      );
      expect(claimLegacyLock).toThrow(/EEXIST/);
      settle.resolve();
      await releasing;
      expect(claimLegacyLock).not.toThrow();
    } finally {
      settle.resolve();
      await releasing;
      await maintenance.release();
    }
  });
});

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
      } else {
        await doctor.firstWait;
      }
      const completed = await reachDeadline(doctor);
      const error = "error" in completed ? completed.error : undefined;
      expect(error).toBeInstanceOf(DoctorMaintenanceRefusalError);
      expect(error).toMatchObject({
        message: expect.stringContaining(`Waited 1200 s; database held by PID ${holder.holderPid}`),
        refusal: { kind: "deferred", reason: "agent-database-in-use" },
      });
      // A failed admission releases ownership for the holder and the next Doctor.
      expect(fs.existsSync(holder.ownerPath)).toBe(false);
    } finally {
      stateHolder?.release();
    }
  },
);

it.each([
  ["manual doctor --fix", false, false, false, false],
  ["a lease held by Doctor's own process", true, true, false, false],
  ["a live Gateway under the external policy", true, false, true, false],
  ["startup with a live Gateway under the external policy", false, false, true, true],
] as const)(
  "refuses active agent leases immediately (%s)",
  async (_name, update, own, gateway, waitForMaintenance) => {
    const holder = holdForeignLease({ update, own, externalPolicy: gateway });
    // The serving Gateway may own the lease; its lifecycle lock would mask the refusal.
    const serving = gateway ? holdState(holder.databasePath, true) : undefined;
    try {
      const doctor = startDoctor(waitForMaintenance);
      const completed = await doctor.result;
      expect(completed).toMatchObject({
        error: { refusal: { kind: "deferred", reason: "agent-database-in-use" } },
      });
      expect(doctor.log).not.toHaveBeenCalledWith(expect.stringContaining("Waiting up to"));
    } finally {
      serving?.release();
    }
  },
);

function holdForegroundState(published: boolean) {
  const stateDir = dirs.make("doctor-foreground-settlement-");
  vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
  vi.stubEnv("OPENCLAW_CONFIG_PATH", path.join(stateDir, "openclaw.json"));
  vi.stubEnv("OPENCLAW_UPDATE_IN_PROGRESS", "1");
  const owner = {
    pid: process.pid,
    host: hostname(),
    startedAt: getFileLockProcessStartTime(process.pid),
  };
  expect(owner.startedAt).not.toBeNull();
  withOpenClawStateStartupMigrationCheckpointDatabase((db) => {
    if (published) {
      db.prepare(
        `INSERT INTO state_leases
       (scope, lease_key, owner, expires_at, heartbeat_at, payload_json, created_at, updated_at)
       VALUES ('gateway-owner', 'global', 'previous-gateway', ?, ?, ?, ?, ?)`,
      ).run(
        Date.now() + 600_000,
        Date.now(),
        JSON.stringify({
          owner,
          port: 19483,
          mode: "foreground",
          supervisor: null,
        }),
        Date.now(),
        Date.now(),
      );
    }
  });
  closeOpenClawStateDatabaseForTest();
  const databasePath = path.join(stateDir, "state", "openclaw.sqlite");
  return { databasePath, predecessor: holdState(databasePath, true) };
}

it.each(["slow-released", "authority-lost", "rowless-released"] as const)(
  "settles the foreground state owner before update Doctor admission: %s",
  async (outcome) => {
    const { databasePath, predecessor } = holdForegroundState(outcome !== "rowless-released");
    const before = fs.readFileSync(databasePath);
    let authorized = true;
    const doctor = startDoctor(false, () => {
      if (!authorized) {
        throw new Error("update owner was revoked");
      }
    });
    try {
      await doctor.firstWait;
      expect(doctor.isSettled()).toBe(false);
      expect(fs.readFileSync(databasePath)).toEqual(before);
      if (outcome === "slow-released") {
        await doctor.advanceTo(
          TICK_INTERVAL_MS +
            resolveGatewayRestartDeferralTimeoutMs() +
            GATEWAY_SHUTDOWN_TIMEOUT_MS -
            1,
        );
        expect(doctor.isSettled()).toBe(false);
        expect(fs.readFileSync(databasePath)).toEqual(before);
      }
      if (outcome === "rowless-released") {
        await doctor.advanceTo(GATEWAY_SHUTDOWN_RESERVE_MS - 50);
        expect(doctor.isSettled()).toBe(false);
      }
      const released = outcome === "slow-released" || outcome === "rowless-released";
      if (outcome === "slow-released") {
        withOpenClawStateStartupMigrationCheckpointDatabase((db) => {
          db.prepare(
            "DELETE FROM state_leases WHERE scope = 'gateway-owner' AND lease_key = 'global' AND owner = 'previous-gateway'",
          ).run();
        });
      } else if (!released) {
        authorized = false;
      }
      predecessor?.release();
      await doctor.advanceTo(
        outcome === "rowless-released" ? GATEWAY_SHUTDOWN_RESERVE_MS : undefined,
      );
      const completed = await doctor.result;
      if (released) {
        expect(completed).toMatchObject({ maintenance: expect.anything() });
        await ("maintenance" in completed ? completed.maintenance?.finish({}) : undefined);
      } else {
        expect(completed).toMatchObject({
          error: { message: expect.stringContaining("update owner was revoked") },
        });
      }
    } finally {
      predecessor?.release();
      if (!doctor.isSettled()) {
        await vi.runOnlyPendingTimersAsync();
      }
      const completed = await doctor.result;
      await ("maintenance" in completed ? completed.maintenance?.release() : undefined);
      if (outcome === "rowless-released") {
        expect(vi.getTimerCount()).toBe(0);
      }
    }
  },
);
