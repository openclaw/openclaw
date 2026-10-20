import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
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

  expect(verification).toHaveBeenLastCalledWith(false, true, "predecessor-admission-incomplete");
  expect(
    state.db.prepare("SELECT lease_id FROM agent_database_leases ORDER BY lease_id").all(),
  ).toEqual([{ lease_id: "first" }, { lease_id: "unknown-peer" }]);

  releaseOpenClawAgentDatabaseLease("unknown-peer", { env: params.env }, "read-only");
  releaseOpenClawAgentDatabaseLease("first", { env: params.env }, "read-only");
  claimOpenClawAgentDatabaseLease(params, "second", verification);

  expect(verification).toHaveBeenLastCalledWith(true, false, undefined);
  expect(state.db.prepare("SELECT lease_id FROM agent_database_leases").all()).toEqual([
    { lease_id: "second" },
  ]);
  releaseOpenClawAgentDatabaseLease("second", { env: params.env }, "read-only");
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
