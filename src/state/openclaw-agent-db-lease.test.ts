import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createTempDirTracker } from "../../test/helpers/temp-dir.js";
import * as bootReader from "../infra/update-managed-service-handoff-boot.js";
import { getFileLockProcessStartTime } from "../shared/pid-alive.js";
import * as provenance from "./openclaw-agent-db-lease-provenance.js";
import {
  assertNoOpenClawAgentDatabaseLeases,
  assertNoOpenClawAgentDatabaseLeasesReadOnly,
  claimOpenClawAgentDatabaseLease,
  recordOpenClawAgentDatabaseAdmission,
  releaseOpenClawAgentDatabaseLease,
} from "./openclaw-agent-db-lease.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "./openclaw-state-db.js";

const tempDirs = createTempDirTracker();
afterEach(() => {
  vi.restoreAllMocks();
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

it.each([
  { name: "prior boot", openedAt: 699_999, bootReadable: true, reclaimed: true },
  { name: "boot safety margin", openedAt: 700_000, bootReadable: true, reclaimed: false },
  { name: "same boot", openedAt: 1_000_001, bootReadable: true, reclaimed: false },
  { name: "unreadable boot", openedAt: 699_999, bootReadable: false, reclaimed: false },
  { name: "unfinished admission", openedAt: 0, bootReadable: true, reclaimed: false },
])("handles a legacy null-identity lease from $name", ({ openedAt, bootReadable, reclaimed }) => {
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
    expect(inspect).not.toThrow();
    expect(repair).not.toThrow();
  } else {
    expect(inspect).toThrow("database is still open");
    expect(repair).toThrow("database is still open");
  }
  expect(state.db.prepare("SELECT lease_id FROM agent_database_leases").all()).toEqual(
    reclaimed ? [] : [{ lease_id: leaseId }],
  );
});

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

  expect(verification).toHaveBeenLastCalledWith(
    false,
    true,
    "predecessor-admission-incomplete",
    undefined,
  );
  expect(
    state.db.prepare("SELECT lease_id FROM agent_database_leases ORDER BY lease_id").all(),
  ).toEqual([{ lease_id: "first" }, { lease_id: "unknown-peer" }]);

  releaseOpenClawAgentDatabaseLease("unknown-peer", { env: params.env }, "read-only");
  releaseOpenClawAgentDatabaseLease("first", { env: params.env }, "read-only");
  claimOpenClawAgentDatabaseLease(params, "second", verification);

  expect(verification).toHaveBeenLastCalledWith(true, false, undefined, undefined);
  expect(state.db.prepare("SELECT lease_id FROM agent_database_leases").all()).toEqual([
    { lease_id: "second" },
  ]);
  releaseOpenClawAgentDatabaseLease("second", { env: params.env }, "read-only");
});

it.each([
  { name: "an admitted live peer", openedAt: 1, alias: false, peer: "same", lends: true },
  {
    name: "a peer with unfinished admission",
    openedAt: 0,
    alias: false,
    peer: "same",
    lends: false,
  },
  { name: "a peer on an alias path", openedAt: 1, alias: true, peer: "same", lends: false },
  {
    name: "a peer that admitted a replaced file",
    openedAt: 1,
    alias: false,
    peer: "other",
    lends: false,
  },
  { name: "a peer without provenance", openedAt: 1, alias: false, peer: null, lends: false },
])("lends integrity only from $name", ({ openedAt, alias, peer, lends }) => {
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

  expect(verification).toHaveBeenCalledWith(
    false,
    false,
    "live-or-unknown-owner",
    lends ? "process-v1:same" : undefined,
  );
});

it("records admission on its held claim and refuses to resurrect a released claim", () => {
  const { params, state } = createLeaseOwner();
  const leaseId = claimOpenClawAgentDatabaseLease(params);
  vi.spyOn(Date, "now").mockReturnValue(123_456);
  const controls = vi.spyOn(state.db, "exec");

  recordOpenClawAgentDatabaseAdmission(leaseId, params);

  expect(controls).not.toHaveBeenCalled();
  expect(
    state.db.prepare("SELECT opened_at FROM agent_database_leases WHERE lease_id = ?").get(leaseId),
  ).toEqual({ opened_at: 123_456 });
  releaseOpenClawAgentDatabaseLease(leaseId, { env: params.env }, "read-only");
  controls.mockClear();

  expect(() => recordOpenClawAgentDatabaseAdmission(leaseId, params)).toThrow(
    `Agent database open lost its runtime lease: ${params.path}`,
  );
  expect(controls).not.toHaveBeenCalled();
  expect(state.db.prepare("SELECT lease_id FROM agent_database_leases").all()).toEqual([]);
});
