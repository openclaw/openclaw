import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { closeStateDatabaseForTest } from "../test-utils/database-cleanup.js";
import { retireAgentDeletionJournalInDatabase } from "./agent-deletion-journal-authority.worker.js";
import {
  beginAgentDeletionJournalInDatabase,
  completeAgentDeletionJournalInDatabase,
  listPendingAgentDeletionJournalsInDatabase,
  readAgentDeletionJournalInDatabase,
} from "./agent-deletion-journal.js";
import { readRetainedAgentDeletionsFromDatabase } from "./agent-deletion-journal.read.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "./openclaw-state-db.js";

const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    await closeStateDatabaseForTest();
    cleanup();
  }),
);

it.each(["draining", "legacy-null"] as const)(
  "recovers %s journals without reopening a retired drain",
  async (format) => {
    const stateDir = tempDirs.make("agent-deletion-phase-");
    const options = { env: { OPENCLAW_STATE_DIR: stateDir } };
    const input = {
      agentId: "delete-me",
      operationId: "first-attempt",
      agentDir: path.join(stateDir, "agents/delete-me/agent"),
      workspaceDir: path.join(stateDir, "workspace-delete-me"),
      sessionsDir: path.join(stateDir, "agents/delete-me/sessions"),
      deleteFiles: true,
      phase: "draining" as const,
    };
    runOpenClawStateWriteTransaction(
      (database) => beginAgentDeletionJournalInDatabase(database, input),
      options,
    );
    const original = openOpenClawStateDatabase(options);
    const version = original.db.prepare("PRAGMA user_version").get();
    if (format === "legacy-null") {
      original.db.exec("UPDATE agent_deletion_journal SET phase = NULL");
    }
    await closeStateDatabaseForTest();
    const recovered = openOpenClawStateDatabase(options);
    const phase = format === "draining" ? "draining" : "retiring";
    expect(readAgentDeletionJournalInDatabase(recovered, input.agentId)?.phase).toBe(phase);
    expect(listPendingAgentDeletionJournalsInDatabase(recovered).entries).toEqual([
      expect.objectContaining({ agentId: input.agentId, phase }),
    ]);

    runOpenClawStateWriteTransaction((database) => {
      const retry = beginAgentDeletionJournalInDatabase(database, {
        ...input,
        operationId: "recovery-attempt",
      });
      expect(retry.entry.phase).toBe(phase);
      if (format === "draining") {
        expect(
          completeAgentDeletionJournalInDatabase(database, input.agentId, "recovery-attempt"),
        ).toBe(false);
      }
      expect(retireAgentDeletionJournalInDatabase(database, input.agentId, input.operationId)).toBe(
        false,
      );
      expect(
        retireAgentDeletionJournalInDatabase(database, input.agentId, "recovery-attempt"),
      ).toBe(true);
    }, options);
    await closeStateDatabaseForTest();

    const final = runOpenClawStateWriteTransaction(
      (database) => beginAgentDeletionJournalInDatabase(database, input),
      options,
    );
    expect(final.entry.phase).toBe("retiring");
    expect(openOpenClawStateDatabase(options).db.prepare("PRAGMA user_version").get()).toEqual(
      version,
    );
  },
);

it.each([false, true])(
  "retains Claw cleanup custody unless Gateway draining was recorded: %s",
  (gatewayOwned) => {
    const stateDir = tempDirs.make("agent-deletion-recovery-owner-");
    const options = { env: { OPENCLAW_STATE_DIR: stateDir } };
    const input = {
      agentId: "claw-worker",
      operationId: "interrupted",
      agentDir: path.join(stateDir, "agent"),
      workspaceDir: path.join(stateDir, "workspace"),
      sessionsDir: path.join(stateDir, "sessions"),
      deleteFiles: false,
      ...(gatewayOwned ? { phase: "draining" as const } : {}),
    };
    runOpenClawStateWriteTransaction(
      (database) => beginAgentDeletionJournalInDatabase(database, input),
      options,
    );
    const database = openOpenClawStateDatabase(options);
    expect(listPendingAgentDeletionJournalsInDatabase(database).entries).toHaveLength(1);
    database.db
      .prepare(
        `INSERT INTO claw_workspace_files
          (agent_id, target_path, schema_version, workspace, source_path,
           content_digest, status, created_at_ms, updated_at_ms)
         VALUES (?, ?, '1', ?, 'AGENTS.md', 'sha256:fixture', 'modified', 1, 1)`,
      )
      .run(input.agentId, path.join(input.workspaceDir, "AGENTS.md"), input.workspaceDir);
    const pending = listPendingAgentDeletionJournalsInDatabase(database);
    expect(pending.entries).toHaveLength(gatewayOwned ? 1 : 0);
    expect(pending.manualClawAgentIds).toEqual(gatewayOwned ? [] : [input.agentId]);
    const facts = readRetainedAgentDeletionsFromDatabase(database.db, database.path);
    expect(facts).toMatchObject({
      status: "present",
      entries: [{ agentId: input.agentId, cleanupCompleted: false }],
    });
    expect(facts.status === "present" && facts.entries[0]?.manualClawRemoval).toBe(
      gatewayOwned ? undefined : true,
    );
    const recover = (operationId: string) =>
      runOpenClawStateWriteTransaction(
        (current) =>
          beginAgentDeletionJournalInDatabase(
            current,
            { ...input, operationId: "successor" },
            false,
            operationId,
          ),
        options,
      );
    expect(() => recover("stale-attempt")).toThrow("changed before recovery");
    if (gatewayOwned) {
      expect(recover(input.operationId).entry.phase).toBe("draining");
    } else {
      expect(() => recover(input.operationId)).toThrow("Claw removal owner");
      expect(readAgentDeletionJournalInDatabase(database, input.agentId)?.operationId).toBe(
        input.operationId,
      );
    }
  },
);
