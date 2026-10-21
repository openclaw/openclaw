import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { closeStateDatabaseForTest } from "../test-utils/database-cleanup.js";
import { retireAgentDeletionJournalInDatabase as retire } from "./agent-deletion-journal-authority.worker.js";
import {
  beginAgentDeletionJournalInDatabase as begin,
  completeAgentDeletionJournalInDatabase as complete,
  listPendingAgentDeletionJournalsInDatabase as pending,
  readAgentDeletionJournalInDatabase as read,
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

function fixture(input: Partial<Parameters<typeof begin>[1]>) {
  const stateDir = tempDirs.make("agent-deletion-phase-");
  const options = { env: { OPENCLAW_STATE_DIR: stateDir } };
  const entry = {
    agentId: "delete-me",
    operationId: "first-attempt",
    agentDir: path.join(stateDir, "agent"),
    workspaceDir: path.join(stateDir, "workspace"),
    sessionsDir: path.join(stateDir, "sessions"),
    deleteFiles: true,
    ...input,
  };
  const write = <T>(run: Parameters<typeof runOpenClawStateWriteTransaction<T>>[0]) =>
    runOpenClawStateWriteTransaction(run, options);
  const restart = () => write((database) => begin(database, entry));
  restart();
  return { input: entry, open: () => openOpenClawStateDatabase(options), write, restart };
}

it.each(["draining", "legacy-null"] as const)(
  "recovers %s without reopening retired drains",
  async (format) => {
    const { input, open, write, restart } = fixture({ phase: "draining" });
    const original = open();
    const version = original.db.prepare("PRAGMA user_version").get();
    if (format === "legacy-null") {
      original.db.exec("UPDATE agent_deletion_journal SET phase = NULL");
    }
    await closeStateDatabaseForTest();
    const recovered = open();
    const phase = format === "draining" ? "draining" : "retiring";
    expect(read(recovered, input.agentId)?.phase).toBe(phase);
    expect(pending(recovered).entries).toEqual([
      expect.objectContaining({ agentId: input.agentId, phase }),
    ]);

    write((database) => {
      const retry = begin(database, {
        ...input,
        operationId: "recovery-attempt",
      });
      expect(retry.entry.phase).toBe(phase);
      if (format === "draining") {
        expect(complete(database, input.agentId, "recovery-attempt")).toBe(false);
      }
      expect(retire(database, input.agentId, input.operationId)).toBe(false);
      expect(retire(database, input.agentId, "recovery-attempt")).toBe(true);
    });
    await closeStateDatabaseForTest();

    expect(restart().entry.phase).toBe("retiring");
    expect(open().db.prepare("PRAGMA user_version").get()).toEqual(version);
  },
);

it.each([false, true])("preserves Claw cleanup custody: gateway=%s", (gatewayOwned) => {
  const { input, open, write } = fixture({
    agentId: "claw-worker",
    operationId: "interrupted",
    deleteFiles: false,
    ...(gatewayOwned ? { phase: "draining" as const } : {}),
  });
  const database = open();
  expect(pending(database).entries).toHaveLength(1);
  database.db
    .prepare(
      `INSERT INTO claw_workspace_files
          (agent_id, target_path, schema_version, workspace, source_path,
           content_digest, status, created_at_ms, updated_at_ms)
         VALUES (?, ?, '1', ?, 'AGENTS.md', 'sha256:fixture', 'modified', 1, 1)`,
    )
    .run(input.agentId, path.join(input.workspaceDir, "AGENTS.md"), input.workspaceDir);
  expect(pending(database)).toMatchObject({
    entries: gatewayOwned ? [expect.objectContaining({ agentId: input.agentId })] : [],
    manualClawAgentIds: gatewayOwned ? [] : [input.agentId],
  });
  const facts = readRetainedAgentDeletionsFromDatabase(database.db, database.path);
  expect(facts).toMatchObject({
    status: "present",
    entries: [{ agentId: input.agentId, cleanupCompleted: false }],
  });
  expect(facts.status === "present" && facts.entries[0]?.manualClawRemoval).toBe(
    gatewayOwned ? undefined : true,
  );
  const recover = (operationId: string) =>
    write((current) => begin(current, { ...input, operationId: "successor" }, false, operationId));
  expect(() => recover("stale-attempt")).toThrow("changed before recovery");
  if (gatewayOwned) {
    expect(recover(input.operationId).entry.phase).toBe("draining");
  } else {
    expect(() => recover(input.operationId)).toThrow("Claw removal owner");
    expect(read(database, input.agentId)?.operationId).toBe(input.operationId);
  }
});
