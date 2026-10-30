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

it.each([
  ["prior boot", 699_999, true, true],
  ["boot safety margin", 700_000, true, false],
  ["same boot", 1_000_001, true, false],
  ["unreadable boot", 699_999, false, false],
  ["unfinished admission", 0, true, false],
] as const)(
  "handles a legacy null-identity lease from %s",
  (_, openedAt, bootReadable, reclaimed) => {
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

  expect(verification).toHaveBeenLastCalledWith(
    false,
    true,
    "predecessor-admission-incomplete",
    undefined,
  );
  expectRows(state.db, "SELECT lease_id FROM agent_database_leases ORDER BY lease_id", [
    { lease_id: "first" },
    { lease_id: "unknown-peer" },
  ]);

  releaseOpenClawAgentDatabaseLease("unknown-peer", { env: params.env }, "read-only");
  releaseOpenClawAgentDatabaseLease("first", { env: params.env }, "read-only");
  claimOpenClawAgentDatabaseLease(params, "second", verification);

  expect(verification).toHaveBeenLastCalledWith(true, false, undefined, undefined);
  expectRows(state.db, "SELECT lease_id FROM agent_database_leases", [{ lease_id: "second" }]);
  releaseOpenClawAgentDatabaseLease("second", { env: params.env }, "read-only");
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
  expectRows(state.db, "SELECT lease_id FROM agent_database_leases", []);
});

it("reports committed close-state transitions without repeating unchanged peer receipts", () => {
  const { params, state } = createLeaseOwner();
  claimOpenClawAgentDatabaseLease(params, "peer");
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
  expectRows(state.db, "SELECT lease_id FROM agent_database_leases", [{ lease_id: "peer" }]);
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
    ["main", "written"],
  ]);
});
