import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  beginAgentDeletionJournal as beginJournal,
  readAgentDeletionJournal as readJournal,
  removeAgentDeletionJournal as removeJournal,
} from "../test-utils/agent-deletion-journal.js";
import { retireAgentDeletionJournalInDatabase as retireJournal } from "./agent-deletion-journal-authority.worker.js";
import { completeAgentDeletionJournalInDatabase } from "./agent-deletion-journal.js";
import type { AgentDeletionJournalInput } from "./agent-deletion-journal.types.js";
import {
  assertNoOpenClawAgentDatabaseLeases as assertDrained,
  claimOpenClawAgentDatabaseLease as claimLease,
  releaseOpenClawAgentDatabaseLease as releaseLease,
} from "./openclaw-agent-db-lease.js";
import { registerOpenClawAgentDatabase as registerDatabase } from "./openclaw-agent-db-registry.js";
import { closeOpenClawStateDatabaseForTest as closeStateDbForTest } from "./openclaw-state-db-cache.js";
import { runOpenClawStateWriteTransaction as writeState } from "./openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath as stateSqlitePath } from "./openclaw-state-db.paths.js";

afterEach(() => closeStateDbForTest());
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function fixture(agentId = "survivor") {
  const stateDir = tempDirs.make("agent-deletion-fence-");
  const env = { OPENCLAW_STATE_DIR: stateDir };
  return {
    env,
    claim: { agentId, path: path.join(stateDir, `${agentId}.sqlite`), env },
    begin: (overrides: Partial<AgentDeletionJournalInput> = {}) =>
      beginJournal(
        {
          agentId: "deleted",
          operationId: "deletion",
          agentDir: path.join(stateDir, "agents/deleted/agent"),
          workspaceDir: path.join(stateDir, "workspace-deleted"),
          sessionsDir: path.join(stateDir, "sessions-deleted"),
          deleteFiles: true,
          ...overrides,
        },
        { env },
      ),
  };
}

it.each([
  ["unrelated", undefined],
  ["same identity", "while agent deleted is deleted"],
  ["overlapping path", "deletion owns"],
] as const)("checks current deletion ownership for %s registration", (relationship, error) => {
  const { env, claim, begin } = fixture();
  if (relationship === "same identity") {
    claim.agentId = "deleted";
  }
  const register = () =>
    registerDatabase(claim, {
      starting: () => {
        // Start deletion after claim preparation but before its registration transaction.
        begin({ databasePaths: relationship === "overlapping path" ? [claim.path] : [] });
      },
    });
  if (error) {
    expect(register).toThrow(error);
  } else {
    expect(register).not.toThrow();
  }
  using reader = new DatabaseSync(stateSqlitePath(env));
  expect(reader.prepare("SELECT agent_id, path FROM agent_databases").all()).toEqual(
    error ? [] : [{ agent_id: claim.agentId, path: "survivor.sqlite" }],
  );
});

it("admits settlement leases while draining and fences them once retirement begins", () => {
  const { env, claim, begin } = fixture("deleted");
  const { agentId, operationId } = begin({ databasePaths: [claim.path], phase: "draining" });
  const lease = claimLease(claim);
  try {
    expect(() => claimLease({ ...claim, agentId: "survivor" })).toThrow("deletion owns");
    expect(
      writeState((db) => completeAgentDeletionJournalInDatabase(db, agentId, operationId), { env }),
    ).toBe(false);
    expect(writeState((db) => retireJournal(db, agentId, operationId), { env })).toBe(true);
    expect(() => claimLease(claim)).toThrow("while agent deleted is deleted");
  } finally {
    releaseLease(lease, { env });
  }
});

it.each([
  ["registration", "database_paths_json", "[1]"],
  ["lease claim", "cleanup_paths_json", "[1]"],
  ["lease drain", "database_paths_json", "[1]"],
  ["lease drain", "cleanup_paths_json", "[1]"],
] as const)("%s classifies changed %s=%s", (caller, column, value) => {
  const error =
    column === "database_paths_json"
      ? "Invalid agent deletion database path journal."
      : "Invalid agent deletion cleanup path journal.";
  const { env, claim, begin } = fixture();
  let leaseId = caller === "lease drain" ? claimLease(claim) : undefined;
  const { agentId, operationId } = begin();
  const writer = new DatabaseSync(stateSqlitePath(env));
  const registrations = writer.prepare("SELECT * FROM agent_databases ORDER BY agent_id, path");
  const leases = writer.prepare("SELECT * FROM agent_database_leases ORDER BY lease_id");
  const beforeRegistrations = registrations.all();
  const beforeLeases = leases.all();
  try {
    writer
      .prepare(`UPDATE agent_deletion_journal SET ${column} = ? WHERE agent_id = ?`)
      .run(value, agentId);
    expect(readJournal(claim.agentId, { env })).toBeUndefined();
    const operate = () => {
      if (caller === "registration") {
        registerDatabase(claim);
      } else if (caller === "lease claim") {
        leaseId = claimLease(claim);
      } else {
        assertDrained(agentId, { env });
      }
    };
    const refuses = caller === "lease drain";
    if (refuses) {
      expect(operate).toThrow(error);
    } else {
      expect(operate).not.toThrow();
    }
    const claimedLease = { lease_id: leaseId, agent_id: claim.agentId, path: claim.path };
    const journal = writer.prepare(
      `SELECT ${column} FROM agent_deletion_journal WHERE agent_id = ?`,
    );
    expect({
      registrations: registrations.all(),
      leases: leases.all(),
      journal: journal.get(agentId),
    }).toEqual({
      registrations:
        !refuses && caller === "registration"
          ? [expect.objectContaining({ agent_id: claim.agentId, path: "survivor.sqlite" })]
          : beforeRegistrations,
      leases:
        !refuses && caller === "lease claim"
          ? [expect.objectContaining(claimedLease)]
          : beforeLeases,
      journal: { [column]: value },
    });
  } finally {
    writer.close();
    if (leaseId) {
      releaseLease(leaseId, { env });
    }
    removeJournal(agentId, operationId, { env });
  }
});

it.each(["registration", "lease claim"])(
  "preserves a recorded deletion identity during %s with unreadable path history",
  (caller) => {
    const { env, claim, begin } = fixture("deleted");
    begin({ deleteFiles: false });
    using writer = new DatabaseSync(stateSqlitePath(env));
    writer.exec("UPDATE agent_deletion_journal SET database_paths_json = '[1]'");
    expect(() => (caller === "registration" ? registerDatabase(claim) : claimLease(claim))).toThrow(
      "while agent deleted is deleted",
    );
    expect(writer.prepare("SELECT * FROM agent_databases").all()).toEqual([]);
    expect(writer.prepare("SELECT * FROM agent_database_leases").all()).toEqual([]);
  },
);
