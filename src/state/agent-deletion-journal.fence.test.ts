import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  beginAgentDeletionJournal,
  readAgentDeletionJournal,
  removeAgentDeletionJournal,
} from "./agent-deletion-journal.js";
import * as agentDeletionJournal from "./agent-deletion-journal.js";
import {
  assertNoOpenClawAgentDatabaseLeases,
  claimOpenClawAgentDatabaseLease,
  releaseOpenClawAgentDatabaseLease,
} from "./openclaw-agent-db-lease.js";
import { registerOpenClawAgentDatabase } from "./openclaw-agent-db-registry.js";
import { closeOpenClawStateDatabaseForTest } from "./openclaw-state-db-cache.js";
import { resolveOpenClawStateSqlitePath } from "./openclaw-state-db.paths.js";

afterEach(() => {
  closeOpenClawStateDatabaseForTest();
});
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe.each(["registration", "lease claim", "lease drain"] as const)(
  "deletion journal fencing at %s",
  (caller) => {
    it.each([
      {
        column: "database_paths_json",
        value: "[1]",
        afterPrepare: false,
        error: "Invalid agent deletion database path journal.",
      },
      {
        column: "cleanup_paths_json",
        value: "[1]",
        afterPrepare: false,
        error: "Invalid agent deletion cleanup path journal.",
      },
      {
        column: "operation_id",
        value: "replacement",
        afterPrepare: true,
        error: "deletion journal changed",
      },
      {
        column: "cleanup_completed",
        value: 1,
        afterPrepare: true,
        error: "deletion journal changed",
      },
    ])("classifies a changed $column (after preparation: $afterPrepare)", (change) => {
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
      const mutate = () =>
        writer
          .prepare(`UPDATE agent_deletion_journal SET ${change.column} = ? WHERE agent_id = ?`)
          .run(change.value, deletion.agentId);
      const prepare = agentDeletionJournal.prepareAgentDeletionPathFence;
      const preparation = change.afterPrepare
        ? vi
            .spyOn(agentDeletionJournal, "prepareAgentDeletionPathFence")
            .mockImplementationOnce((...args) => {
              const fence = prepare(...args);
              // Commit through another connection after preparation releases its transaction.
              mutate();
              return fence;
            })
        : undefined;
      try {
        if (!change.afterPrepare) {
          mutate();
          expect(readAgentDeletionJournal(claim.agentId, { env })).toBeUndefined();
        }
        const operate = () => {
          if (caller === "registration") {
            registerOpenClawAgentDatabase(claim);
          } else if (caller === "lease claim") {
            leaseId = claimOpenClawAgentDatabaseLease(claim);
          } else {
            assertNoOpenClawAgentDatabaseLeases(deletion.agentId, { env });
          }
        };
        const refuses = change.afterPrepare || caller === "lease drain";
        if (refuses) {
          expect(operate).toThrow(change.error);
        } else {
          expect(operate).not.toThrow();
          expect(prepare(claim, { env }).journal).toBe("unknown");
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
            .prepare(`SELECT ${change.column} FROM agent_deletion_journal WHERE agent_id = ?`)
            .get(deletion.agentId),
        ).toEqual({ [change.column]: change.value });
      } finally {
        preparation?.mockRestore();
        writer.close();
        if (leaseId) {
          releaseOpenClawAgentDatabaseLease(leaseId, { env });
        }
        removeAgentDeletionJournal(
          deletion.agentId,
          change.column === "operation_id" ? "replacement" : deletion.operationId,
          { env },
        );
      }
    });
  },
);

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
    expect(agentDeletionJournal.prepareAgentDeletionPathFence(claim, { env }).journal).toBe(
      "unknown",
    );
    expect(() =>
      caller === "registration"
        ? registerOpenClawAgentDatabase(claim)
        : claimOpenClawAgentDatabaseLease(claim),
    ).toThrow("while agent deleted is deleted");
    expect(writer.prepare("SELECT * FROM agent_databases").all()).toEqual([]);
    expect(writer.prepare("SELECT * FROM agent_database_leases").all()).toEqual([]);
  },
);
