import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createTempDirTracker } from "../../test/helpers/temp-dir.js";
import * as bootReader from "../infra/update-managed-service-handoff-boot.js";
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
