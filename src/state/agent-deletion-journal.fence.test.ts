import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  beginAgentDeletionJournal,
  readAgentDeletionJournal,
  removeAgentDeletionJournal,
} from "../test-utils/agent-deletion-journal.js";
import { retireAgentDeletionJournalInDatabase } from "./agent-deletion-journal-authority.worker.js";
import * as agentDeletionJournal from "./agent-deletion-journal.js";
import {
  assertNoOpenClawAgentDatabaseLeases,
  claimOpenClawAgentDatabaseLease,
  releaseOpenClawAgentDatabaseLease,
} from "./openclaw-agent-db-lease.js";
import { registerOpenClawAgentDatabase } from "./openclaw-agent-db-registry.js";
import { closeOpenClawStateDatabaseForTest } from "./openclaw-state-db-cache.js";
import { runOpenClawStateWriteTransaction } from "./openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "./openclaw-state-db.paths.js";

afterEach(() => {
  closeOpenClawStateDatabaseForTest();
});
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

it.each([
  ["unrelated", undefined],
  ["same identity", "while agent deleted is deleted"],
  ["overlapping path", "deletion owns"],
] as const)("checks current deletion ownership for %s registration", (relationship, error) => {
  const stateDir = tempDirs.make("agent-deletion-current-fence-");
  const env = { OPENCLAW_STATE_DIR: stateDir };
  const claim = {
    agentId: relationship === "same identity" ? "deleted" : "survivor",
    path: path.join(stateDir, "survivor.sqlite"),
    env,
  };
  const register = () =>
    registerOpenClawAgentDatabase(claim, {
      starting: () => {
        // Start deletion after claim preparation but before its registration transaction.
        beginAgentDeletionJournal(
          {
            agentId: "deleted",
            operationId: "deletion",
            agentDir: path.join(stateDir, "agents/deleted/agent"),
            workspaceDir: path.join(stateDir, "workspace-deleted"),
            sessionsDir: path.join(stateDir, "sessions-deleted"),
            databasePaths: relationship === "overlapping path" ? [claim.path] : [],
            deleteFiles: true,
          },
          { env },
        );
      },
    });
  if (error) {
    expect(register).toThrow(error);
  } else {
    expect(register).not.toThrow();
  }
  using reader = new DatabaseSync(resolveOpenClawStateSqlitePath(env));
  expect(reader.prepare("SELECT agent_id, path FROM agent_databases").all()).toEqual(
    error ? [] : [{ agent_id: claim.agentId, path: "survivor.sqlite" }],
  );
});

it("admits settlement leases while draining and fences them once retirement begins", () => {
  const stateDir = tempDirs.make("agent-deletion-draining-fence-");
  const env = { OPENCLAW_STATE_DIR: stateDir };
  const claim = { agentId: "deleted", path: path.join(stateDir, "deleted.sqlite"), env };
  const deletion = beginAgentDeletionJournal(
    {
      agentId: claim.agentId,
      operationId: "draining-deletion",
      agentDir: path.join(stateDir, "agents/deleted/agent"),
      workspaceDir: path.join(stateDir, "workspace-deleted"),
      sessionsDir: path.join(stateDir, "sessions-deleted"),
      databasePaths: [claim.path],
      deleteFiles: true,
      phase: "draining",
    },
    { env },
  );
  const lease = claimOpenClawAgentDatabaseLease(claim);
  try {
    expect(() => claimOpenClawAgentDatabaseLease({ ...claim, agentId: "survivor" })).toThrow(
      "deletion owns",
    );
    runOpenClawStateWriteTransaction(
      (database) => {
        expect(
          agentDeletionJournal.completeAgentDeletionJournalInDatabase(
            database,
            deletion.agentId,
            deletion.operationId,
          ),
        ).toBe(false);
        expect(
          retireAgentDeletionJournalInDatabase(database, deletion.agentId, deletion.operationId),
        ).toBe(true);
      },
      { env },
    );
    expect(() => claimOpenClawAgentDatabaseLease(claim)).toThrow("while agent deleted is deleted");
  } finally {
    releaseOpenClawAgentDatabaseLease(lease, { env });
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
  const stateDir = tempDirs.make("agent-deletion-journal-fence-");
  const env = { OPENCLAW_STATE_DIR: stateDir };
  const claim = { agentId: "survivor", path: path.join(stateDir, "survivor.sqlite"), env };
  let leaseId = caller === "lease drain" ? claimOpenClawAgentDatabaseLease(claim) : undefined;
  const deletion = beginAgentDeletionJournal(
    {
      operationId: "deletion",
      deleteFiles: true,
      agentId: "deleted",
      agentDir: path.join(stateDir, "agents", "deleted", "agent"),
      workspaceDir: path.join(stateDir, "workspace-deleted"),
      sessionsDir: path.join(stateDir, "sessions-deleted"),
    },
    { env },
  );
  const writer = new DatabaseSync(resolveOpenClawStateSqlitePath(env));
  const registrations = writer.prepare("SELECT * FROM agent_databases ORDER BY agent_id, path");
  const leases = writer.prepare("SELECT * FROM agent_database_leases ORDER BY lease_id");
  const beforeRegistrations = registrations.all();
  const beforeLeases = leases.all();
  try {
    writer
      .prepare(`UPDATE agent_deletion_journal SET ${column} = ? WHERE agent_id = ?`)
      .run(value, deletion.agentId);
    expect(readAgentDeletionJournal(claim.agentId, { env })).toBeUndefined();
    const operate = () => {
      if (caller === "registration") {
        registerOpenClawAgentDatabase(claim);
      } else if (caller === "lease claim") {
        leaseId = claimOpenClawAgentDatabaseLease(claim);
      } else {
        assertNoOpenClawAgentDatabaseLeases(deletion.agentId, { env });
      }
    };
    const refuses = caller === "lease drain";
    if (refuses) {
      expect(operate).toThrow(error);
    } else {
      expect(operate).not.toThrow();
    }
    expect(registrations.all()).toEqual(
      !refuses && caller === "registration"
        ? [expect.objectContaining({ agent_id: claim.agentId, path: "survivor.sqlite" })]
        : beforeRegistrations,
    );
    expect(leases.all()).toEqual(
      !refuses && caller === "lease claim"
        ? [
            expect.objectContaining({
              lease_id: leaseId,
              agent_id: claim.agentId,
              path: claim.path,
            }),
          ]
        : beforeLeases,
    );
    expect(
      writer
        .prepare(`SELECT ${column} FROM agent_deletion_journal WHERE agent_id = ?`)
        .get(deletion.agentId),
    ).toEqual({ [column]: value });
  } finally {
    writer.close();
    if (leaseId) {
      releaseOpenClawAgentDatabaseLease(leaseId, { env });
    }
    removeAgentDeletionJournal(deletion.agentId, deletion.operationId, { env });
  }
});

it.each(["registration", "lease claim"])(
  "preserves a recorded deletion identity during %s with unreadable path history",
  (caller) => {
    const stateDir = tempDirs.make("agent-deletion-known-identity-");
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const claim = { agentId: "deleted", path: path.join(stateDir, "deleted.sqlite"), env };
    beginAgentDeletionJournal(
      {
        agentId: claim.agentId,
        operationId: "known-deletion",
        agentDir: path.join(stateDir, "agents/deleted/agent"),
        workspaceDir: path.join(stateDir, "workspace-deleted"),
        sessionsDir: path.join(stateDir, "sessions-deleted"),
        deleteFiles: false,
      },
      { env },
    );
    using writer = new DatabaseSync(resolveOpenClawStateSqlitePath(env));
    writer.exec("UPDATE agent_deletion_journal SET database_paths_json = '[1]'");
    expect(() =>
      caller === "registration"
        ? registerOpenClawAgentDatabase(claim)
        : claimOpenClawAgentDatabaseLease(claim),
    ).toThrow("while agent deleted is deleted");
    expect(writer.prepare("SELECT * FROM agent_databases").all()).toEqual([]);
    expect(writer.prepare("SELECT * FROM agent_database_leases").all()).toEqual([]);
  },
);
