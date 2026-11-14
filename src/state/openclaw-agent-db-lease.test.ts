import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createTempDirTracker } from "../../test/helpers/temp-dir.js";
import * as bootReader from "../infra/update-managed-service-handoff-boot.js";
import { getFileLockProcessStartTime } from "../shared/pid-alive.js";
import { assertNoOpenClawAgentDatabaseLeasesReadOnly } from "./openclaw-agent-db-lease-inspection.js";
import * as provenance from "./openclaw-agent-db-lease-provenance.js";
import {
  assertNoOpenClawAgentDatabaseLeases,
  claimOpenClawAgentDatabaseLease,
  recordOpenClawAgentDatabaseAdmission,
  releaseOpenClawAgentDatabaseLease,
} from "./openclaw-agent-db-lease.js";
import { closeOpenClawAgentDatabaseByPathAsync } from "./openclaw-agent-db-lifecycle.js";
import { registerOpenClawAgentDatabaseAsyncResource } from "./openclaw-agent-db-resources.js";
import { openOpenClawAgentDatabase } from "./openclaw-agent-db.js";
import { expectRows } from "./openclaw-state-db-fixtures.test-support.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "./openclaw-state-db.js";

const logger = vi.hoisted(() => ({ info: vi.fn() }));
vi.mock("../logging/subsystem.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../logging/subsystem.js")>();
  return {
    ...actual,
    createSubsystemLogger: (name: string) => {
      const original = actual.createSubsystemLogger(name);
      return name === "state/agent-db" ? { ...original, info: logger.info } : original;
    },
  };
});

const tempDirs = createTempDirTracker();
afterEach(() => {
  vi.restoreAllMocks();
  logger.info.mockClear();
  closeOpenClawStateDatabaseForTest();
  tempDirs.cleanup();
});

function createLeaseOwner() {
  const stateDir = tempDirs.make("agent-lease-bookkeeping-");
  const env = { OPENCLAW_STATE_DIR: stateDir };
  const params = { agentId: "main", path: path.join(stateDir, "agent.sqlite"), env };
  const state = openOpenClawStateDatabase({ env });
  return { params, state };
}

it.each([499, 500])(
  "adds native close phases only at the 500 ms threshold (%i ms)",
  async (totalMs) => {
    const { params, state } = createLeaseOwner();
    const database = openOpenClawAgentDatabase(params);
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const stop = database.walMaintenance.stop.bind(database.walMaintenance);
    vi.spyOn(database.walMaintenance, "stop").mockImplementation(async () => {
      await stop();
      now += totalMs - 205;
    });
    const checkpoint = database.walMaintenance.close.bind(database.walMaintenance);
    vi.spyOn(database.walMaintenance, "close").mockImplementation((options) => {
      now += 120;
      return checkpoint(options);
    });
    const close = database.db.close.bind(database.db);
    vi.spyOn(database.db, "close").mockImplementation(() => {
      now += 60;
      close();
    });
    const exec = state.db.exec.bind(state.db);
    vi.spyOn(state.db, "exec").mockImplementation((sql) => {
      exec(sql);
      if (sql === "COMMIT") {
        now += 25;
      }
    });
    await closeOpenClawAgentDatabaseByPathAsync(database.path);
    const slow = logger.info.mock.calls.filter(
      ([message]) =>
        String(message).includes("clean-close receipt:") && String(message).includes("; close="),
    );
    expect(slow).toHaveLength(totalMs >= 500 ? 1 : 0);
    if (totalMs >= 500) {
      expect(String(slow[0]?.[0])).toMatch(/agent=main.*db=[a-f0-9]{16}; thread=\d+; close=/);
      expect(JSON.parse(String(slow[0]?.[0]).split("; close=")[1] ?? "")).toEqual({
        totalMs,
        walStopMs: 295,
        checkpointMs: 120,
        nativeCloseMs: 60,
        leaseReleaseMs: 25,
      });
    }
    expect(database.db.isOpen).toBe(false);
    expectRows(state.db, "SELECT lease_id FROM agent_database_leases", []);
  },
);

it.each([
  ["prior boot", 699_999, true, true],
  ["boot safety margin", 700_000, true, false],
  ["same boot", 1_000_001, true, false],
  ["unreadable boot", 699_999, false, false],
  ["unfinished admission", 0, true, false],
] as const)(
  "handles a legacy null-identity lease from %s",
  async (_, openedAt, bootReadable, reclaimed) => {
    const { params, state } = createLeaseOwner();
    const leaseId = claimOpenClawAgentDatabaseLease(params);
    state.db
      .prepare(
        "UPDATE agent_database_leases SET owner_start_time = NULL, opened_at = ? WHERE lease_id = ?",
      )
      .run(openedAt, leaseId);
    vi.spyOn(bootReader, "createManagedHandoffBootIdentityReader").mockReturnValue(() => {
      if (!bootReadable) {
        throw new Error("OS boot time unavailable");
      }
      return { platform: "win32", identity: "1970-01-01T00:16:40.0000000Z" };
    });
    const inspect = () => assertNoOpenClawAgentDatabaseLeasesReadOnly({ env: params.env });
    const repair = () => assertNoOpenClawAgentDatabaseLeases("main", { env: params.env });
    if (reclaimed) {
      await expect(inspect()).resolves.toBeUndefined();
      expect(repair).not.toThrow();
    } else {
      await expect(inspect()).rejects.toThrow("database is still open");
      expect(repair).toThrow("database is still open");
    }
    expectRows(
      state.db,
      "SELECT lease_id FROM agent_database_leases",
      reclaimed ? [] : [{ lease_id: leaseId }],
    );
  },
);

it("excludes cleaned stale claims while retaining unknown peers until their release", () => {
  const { params, state } = createLeaseOwner();
  claimOpenClawAgentDatabaseLease(params, "dead");
  claimOpenClawAgentDatabaseLease(params, "unknown-peer");
  runOpenClawStateWriteTransaction(
    ({ db }) => {
      db.prepare("UPDATE agent_database_leases SET owner_pid = -1 WHERE lease_id = ?").run("dead");
      db.prepare("UPDATE agent_database_leases SET owner_start_time = NULL WHERE lease_id = ?").run(
        "unknown-peer",
      );
    },
    { env: params.env },
  );
  const verification = vi.fn();

  claimOpenClawAgentDatabaseLease(params, "first", verification);

  expect(verification).toHaveBeenLastCalledWith(false, undefined);
  expectRows(state.db, "SELECT lease_id FROM agent_database_leases ORDER BY lease_id", [
    { lease_id: "first" },
    { lease_id: "unknown-peer" },
  ]);

  releaseOpenClawAgentDatabaseLease("unknown-peer", { env: params.env }, "read-only");
  releaseOpenClawAgentDatabaseLease("first", { env: params.env }, "read-only");
  claimOpenClawAgentDatabaseLease(params, "second", verification);

  expect(verification).toHaveBeenLastCalledWith(true, undefined);
  expectRows(state.db, "SELECT lease_id FROM agent_database_leases", [{ lease_id: "second" }]);
  releaseOpenClawAgentDatabaseLease("second", { env: params.env }, "read-only");
});

it("reports a slow worker join when only asynchronous database resources remain", async () => {
  const { params } = createLeaseOwner();
  let now = 0;
  vi.spyOn(performance, "now").mockImplementation(() => now);
  registerOpenClawAgentDatabaseAsyncResource({
    agentId: params.agentId,
    path: params.path,
    revoke() {},
    retireAfterResources: true,
    async close() {
      now += 520;
    },
  });
  await closeOpenClawAgentDatabaseByPathAsync(params.path);
  const completed = logger.info.mock.calls.filter(([message]) =>
    String(message).includes("agent database close settled:"),
  );
  expect(completed).toHaveLength(1);
  expect(String(completed[0]?.[0])).toMatch(/agent=main; db=[a-f0-9]{16}; thread=\d+;/);
  expect(JSON.parse(String(completed[0]?.[0]).split("; close=")[1] ?? "")).toEqual({
    totalMs: 520,
    resourceJoinMs: 0,
    workerJoinMs: 520,
    nativeOwnerMs: 0,
  });
});

it.each([
  ["an admitted live peer", 1, false, "same", true],
  ["a peer with unfinished admission", 0, false, "same", false],
  ["a peer on an alias path", 1, true, "same", false],
  ["a peer that admitted a replaced file", 1, false, "other", false],
  ["a peer without provenance", 1, false, null, false],
] as const)("lends integrity only from %s", (_, openedAt, alias, peer, lends) => {
  const { params, state } = createLeaseOwner();
  vi.spyOn(provenance, "readAgentDatabaseLeaseProvenance").mockReturnValue("process-v1:same");
  const peerStartTime = getFileLockProcessStartTime(process.ppid);
  expect(peerStartTime).not.toBeNull();
  claimOpenClawAgentDatabaseLease(
    alias ? { ...params, path: `${params.path}.alias` } : params,
    "peer",
  );
  state.db
    .prepare(
      "UPDATE agent_database_leases SET owner_pid = ?, owner_start_time = ?, opened_at = ?, provenance = ? WHERE lease_id = 'peer'",
    )
    .run(process.ppid, peerStartTime, openedAt, peer && `process-v1:${peer}`);
  const verification = vi.fn();

  claimOpenClawAgentDatabaseLease(params, "borrower", verification);

  expect(verification).toHaveBeenCalledWith(false, lends ? "process-v1:same" : undefined);
});

it("records admission on its held claim and refuses to resurrect a released claim", () => {
  const { params, state } = createLeaseOwner();
  const leaseId = claimOpenClawAgentDatabaseLease(params);
  vi.spyOn(Date, "now").mockReturnValue(123_456);
  const controls = vi.spyOn(state.db, "exec");
  const openedAt = () =>
    state.db.prepare("SELECT opened_at FROM agent_database_leases WHERE lease_id = ?").get(leaseId);

  recordOpenClawAgentDatabaseAdmission(leaseId, params);

  expect(controls).not.toHaveBeenCalled();
  expect(openedAt()).toEqual({ opened_at: 123_456 });
  releaseOpenClawAgentDatabaseLease(leaseId, { env: params.env }, "read-only");
  controls.mockClear();

  expect(() => recordOpenClawAgentDatabaseAdmission(leaseId, params)).toThrow(
    `Agent database open lost its runtime lease: ${params.path}`,
  );
  expect(controls).not.toHaveBeenCalled();
  expectRows(state.db, "SELECT lease_id FROM agent_database_leases", []);
});

it("reports committed close-state transitions without repeating unchanged peer receipts", () => {
  const { params, state } = createLeaseOwner();
  claimOpenClawAgentDatabaseLease(params, "peer");
  claimOpenClawAgentDatabaseLease(params, "second-peer");
  const publishSeal = vi.fn(() => true);
  const close = (id: string, checkpoint = true) => {
    claimOpenClawAgentDatabaseLease(params, id);
    releaseOpenClawAgentDatabaseLease(
      id,
      { env: params.env },
      checkpoint ? { path: params.path, publishSeal } : "uncheckpointed",
    );
  };
  for (let iteration = 0; iteration < 3; iteration += 1) {
    close(`warm-${iteration}`);
  }
  expect(publishSeal).not.toHaveBeenCalled();
  expectRows(state.db, "SELECT lease_id FROM agent_database_leases ORDER BY lease_id", [
    { lease_id: "peer" },
    { lease_id: "second-peer" },
  ]);
  const sibling = { ...params, agentId: "sibling", path: `${params.path}.sibling` };
  claimOpenClawAgentDatabaseLease(sibling, "sibling");
  releaseOpenClawAgentDatabaseLease("sibling", { env: params.env }, "uncheckpointed");

  // A rolled-back result must not replace the last published diagnostic state.
  expect(() =>
    runOpenClawStateWriteTransaction(
      () => {
        close("rolled-back", false);
        throw new Error("synthetic rollback");
      },
      { env: params.env },
    ),
  ).toThrow("synthetic rollback");
  close("still-active");
  close("incomplete", false);
  close("incomplete-again", false);
  close("active-again");
  releaseOpenClawAgentDatabaseLease(
    "peer",
    { env: params.env },
    {
      path: params.path,
      publishSeal,
    },
  );
  expect(publishSeal).not.toHaveBeenCalled();
  releaseOpenClawAgentDatabaseLease(
    "second-peer",
    { env: params.env },
    {
      path: params.path,
      publishSeal,
    },
  );
  expect(publishSeal).toHaveBeenCalledOnce();
  expectRows(state.db, "SELECT lease_id FROM agent_database_leases", []);
  expect(
    logger.info.mock.calls
      .filter(([message]) => String(message).includes("clean-close receipt"))
      .map(([, detail]) => [detail.agentId, detail.receipt]),
  ).toEqual([
    ["main", "active-leases"],
    ["sibling", "checkpoint-incomplete"],
    ["main", "checkpoint-incomplete"],
    ["main", "active-leases"],
    ["main", "active-leases"],
    ["main", "written"],
  ]);
  const blocked = logger.info.mock.calls.filter(
    ([, detail]) => detail?.receipt === "active-leases",
  );
  expect(blocked.map(([, detail]) => detail.blockingLease.leaseId)).toEqual([
    "peer",
    "peer",
    "second-peer",
  ]);
  for (const [message, detail] of blocked) {
    expect(message).toContain(
      `blockingLeaseId=${detail.blockingLease.leaseId}; ownerPid=${process.pid}`,
    );
    expect(detail.blockingLease).toMatchObject({
      ownerPid: process.pid,
      ownerStartTime: getFileLockProcessStartTime(process.pid),
      path: params.path,
      openedAt: 0,
    });
  }
});
