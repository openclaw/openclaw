import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  beginAgentDeletionJournal as beginJournal,
  removeAgentDeletionJournal as removeJournal,
} from "../test-utils/agent-deletion-journal.js";
import { closeStateDatabaseForTest } from "../test-utils/database-cleanup.js";
import { retireAgentDeletionJournalInDatabase as retireJournal } from "./agent-deletion-journal-authority.worker.js";
import {
  beginAgentDeletionJournalInDatabase as beginInDatabase,
  completeAgentDeletionJournalInDatabase as complete,
  listPendingAgentDeletionJournalsInDatabase as pending,
  readAgentDeletionJournalInDatabase as read,
} from "./agent-deletion-journal.js";
import { readRetainedAgentDeletionsFromDatabase } from "./agent-deletion-journal.read.js";
import type { AgentDeletionJournalInput } from "./agent-deletion-journal.types.js";
import {
  assertNoOpenClawAgentDatabaseLeases as assertDrained,
  claimOpenClawAgentDatabaseLease as claimLease,
  releaseOpenClawAgentDatabaseLease as releaseLease,
} from "./openclaw-agent-db-lease.js";
import { registerOpenClawAgentDatabase as registerDatabase } from "./openclaw-agent-db-registry.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction as writeState,
} from "./openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath as stateSqlitePath } from "./openclaw-state-db.paths.js";

const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    await closeStateDatabaseForTest();
    cleanup();
  }),
);

function fixture(agentId = "survivor", input: Partial<AgentDeletionJournalInput> = {}) {
  const stateDir = tempDirs.make("agent-deletion-fence-");
  const env = { OPENCLAW_STATE_DIR: stateDir };
  const entry = {
    agentId: "deleted",
    operationId: "deletion",
    agentDir: path.join(stateDir, "agents/deleted/agent"),
    workspaceDir: path.join(stateDir, "workspace-deleted"),
    sessionsDir: path.join(stateDir, "sessions-deleted"),
    deleteFiles: true,
    ...input,
  };
  const write = <T>(run: Parameters<typeof writeState<T>>[0]) => writeState(run, { env });
  return {
    env,
    input: entry,
    claim: { agentId, path: path.join(stateDir, `${agentId}.sqlite`), env },
    begin: (overrides: Partial<AgentDeletionJournalInput> = {}) =>
      beginJournal({ ...entry, ...overrides }, { env }),
    open: () => openOpenClawStateDatabase({ env }),
    write,
    restart: () => write((database) => beginInDatabase(database, entry)),
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
    expect(writeState((db) => complete(db, agentId, operationId), { env })).toBe(false);
    expect(writeState((db) => retireJournal(db, agentId, operationId), { env })).toBe(true);
    expect(() => claimLease(claim)).toThrow("while agent deleted is deleted");
  } finally {
    releaseLease(lease, { env });
  }
});

it.each([
  ["registration", "database_paths_json", false],
  ["lease claim", "cleanup_paths_json", false],
  ["lease drain", "database_paths_json", false],
  ["lease drain", "cleanup_paths_json", false],
  ["registration", "database_paths_json", true],
  ["lease claim", "database_paths_json", true],
] as const)("%s classifies changed %s (deleted identity: %s)", (caller, column, deleted) => {
  const value = "[1]";
  const error = deleted
    ? "while agent deleted is deleted"
    : column === "database_paths_json"
      ? "Invalid agent deletion database path journal."
      : "Invalid agent deletion cleanup path journal.";
  const { env, claim, begin } = fixture(deleted ? "deleted" : "survivor");
  let leaseId = caller === "lease drain" ? claimLease(claim) : undefined;
  const { agentId, operationId } = begin({ deleteFiles: !deleted });
  const writer = new DatabaseSync(stateSqlitePath(env));
  const registrations = writer.prepare("SELECT * FROM agent_databases ORDER BY agent_id, path");
  const leases = writer.prepare("SELECT * FROM agent_database_leases ORDER BY lease_id");
  const beforeRegistrations = registrations.all();
  const beforeLeases = leases.all();
  try {
    writer
      .prepare(`UPDATE agent_deletion_journal SET ${column} = ? WHERE agent_id = ?`)
      .run(value, agentId);
    const operate = () => {
      if (caller === "registration") {
        registerDatabase(claim);
      } else if (caller === "lease claim") {
        leaseId = claimLease(claim);
      } else {
        assertDrained(agentId, { env });
      }
    };
    const refuses = deleted || caller === "lease drain";
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

function phaseFixture(input: Partial<Parameters<typeof beginInDatabase>[1]>) {
  const result = fixture("delete-me", {
    agentId: "delete-me",
    operationId: "first-attempt",
    ...input,
  });
  result.restart();
  return result;
}

it.each(["draining", "legacy-null"] as const)(
  "recovers %s without reopening retired drains",
  async (format) => {
    const { input, open, write, restart } = phaseFixture({ phase: "draining" });
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
      const retry = beginInDatabase(database, {
        ...input,
        operationId: "recovery-attempt",
      });
      expect(retry.entry.phase).toBe(phase);
      if (format === "draining") {
        expect(complete(database, input.agentId, "recovery-attempt")).toBe(false);
      }
      expect(retireJournal(database, input.agentId, input.operationId)).toBe(false);
      expect(retireJournal(database, input.agentId, "recovery-attempt")).toBe(true);
    });
    await closeStateDatabaseForTest();

    expect(restart().entry.phase).toBe("retiring");
    expect(open().db.prepare("PRAGMA user_version").get()).toEqual(version);
  },
);

it.each([false, true])("preserves Template cleanup custody: gateway=%s", (gatewayOwned) => {
  const { input, open, write } = phaseFixture({
    agentId: "claw-worker",
    operationId: "interrupted",
    deleteFiles: false,
    ...(gatewayOwned ? { phase: "draining" as const } : {}),
  });
  const database = open();
  expect(pending(database).entries).toHaveLength(1);
  database.db
    .prepare(
      `INSERT INTO template_workspace_files
          (agent_id, target_path, schema_version, workspace, source_path,
           content_digest, status, created_at_ms, updated_at_ms)
         VALUES (?, ?, '1', ?, 'AGENTS.md', 'sha256:fixture', 'modified', 1, 1)`,
    )
    .run(input.agentId, path.join(input.workspaceDir, "AGENTS.md"), input.workspaceDir);
  expect(pending(database)).toMatchObject({
    entries: gatewayOwned ? [expect.objectContaining({ agentId: input.agentId })] : [],
    manualTemplateAgentIds: gatewayOwned ? [] : [input.agentId],
  });
  const facts = readRetainedAgentDeletionsFromDatabase(database.db, database.path);
  expect(facts).toMatchObject({
    status: "present",
    entries: [{ agentId: input.agentId, cleanupCompleted: false }],
  });
  expect(facts.status === "present" && facts.entries[0]?.manualTemplateRemoval).toBe(
    gatewayOwned ? undefined : true,
  );
  const recover = (operationId: string) =>
    write((current) =>
      beginInDatabase(current, { ...input, operationId: "successor" }, false, operationId),
    );
  expect(() => recover("stale-attempt")).toThrow("changed before recovery");
  if (gatewayOwned) {
    expect(recover(input.operationId).entry.phase).toBe("draining");
  } else {
    expect(() => recover(input.operationId)).toThrow("Template removal owner");
    expect(read(database, input.agentId)?.operationId).toBe(input.operationId);
  }
});
