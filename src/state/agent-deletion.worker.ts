import { isDeepStrictEqual } from "node:util";
import { readClawInstallRecordFromDatabase } from "../claws/provenance-read.kernel.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import {
  deferSqliteWorkerCommitReceipt,
  requestSqliteWorkerOperationAdmission,
} from "../infra/sqlite-worker-operation-admission.js";
import {
  readAgentDeletionJournalAuthorityInDatabase,
  retireAgentDeletionJournalInDatabase,
} from "./agent-deletion-journal-authority.worker.js";
import {
  beginAgentDeletionJournalInDatabase,
  completeAgentDeletionJournalInDatabase,
  deleteAgentDeletionJournalInDatabase,
  handoffAgentDeletionJournalInDatabase,
  listPendingAgentDeletionJournalsInDatabase,
  readAgentDeletionJournalInDatabase,
  updateAgentDeletionJournalPathsInDatabase,
  type AgentDeletionJournalCleanupPath,
  type AgentDeletionJournalEntry,
} from "./agent-deletion-journal.js";
import type {
  AgentDeletionWorkerGuard,
  AgentDeletionWorkerPredicate,
} from "./agent-deletion-worker-contract.js";
import { ensureAgentProvenanceSchema } from "./agent-provenance.schema.js";
import { assertNoOpenClawAgentDatabaseLeases } from "./openclaw-agent-db-lease.js";
import { unregisterOpenClawAgentDatabases } from "./openclaw-agent-db-registry.js";
import type { OpenClawStateDatabase } from "./openclaw-state-db-contract.js";
import { tableExists } from "./openclaw-state-db-schema-helpers.js";
import type { DB } from "./openclaw-state-db.generated.js";
import { assertOpenClawStateLeaseWorkerOwnedInTransaction } from "./openclaw-state-lease-worker.js";
import type { OpenClawStateLeaseIdentity } from "./openclaw-state-lease.types.js";
import type {
  WorkerOperationHandlers,
  WorkerWriteOperationContext,
} from "./worker-operation-registry.js";

/** The caller holds the real lease grant and this transaction's shared-state snapshot. */
export function assertAgentDeletionWorkerPredicate(
  database: OpenClawStateDatabase,
  predicate: AgentDeletionWorkerPredicate,
  currentJournal?: Pick<
    AgentDeletionJournalEntry,
    "agentId" | "operationId" | "cleanupCompleted"
  > | null,
): void {
  const journal =
    currentJournal === undefined
      ? readAgentDeletionJournalAuthorityInDatabase(database.db, predicate.agentId)
      : currentJournal;
  if (
    !journal ||
    journal.agentId !== predicate.agentId ||
    journal.operationId !== predicate.operationId ||
    journal.cleanupCompleted
  ) {
    throw new Error(`Agent ${predicate.agentId} deletion no longer owns database cleanup.`);
  }
  assertClawInstall(database, predicate);
}

function assertClawInstall(
  database: OpenClawStateDatabase,
  predicate: Omit<AgentDeletionWorkerPredicate, "operationId">,
): void {
  if (
    predicate.expectedClawInstall !== undefined &&
    !isDeepStrictEqual(
      readClawInstallRecordFromDatabase(database.db, predicate.agentId) ?? null,
      predicate.expectedClawInstall,
    )
  ) {
    throw Object.assign(new Error(`Claw removal no longer owns agent ${predicate.agentId}.`), {
      code: "CLAW_INSTALL_CHANGED",
    });
  }
}

function assertLease(
  database: OpenClawStateDatabase,
  lease: OpenClawStateLeaseIdentity,
  agentId: string,
  stage: "transaction" | "commit" = "transaction",
): void {
  if (lease.scope !== "core:agent-deletion" || lease.key !== agentId) {
    throw new Error("Agent deletion requires its original target lease");
  }
  assertOpenClawStateLeaseWorkerOwnedInTransaction(database.db, lease, "write", stage);
}

function guarded<T>(
  guard: AgentDeletionWorkerGuard,
  context: WorkerWriteOperationContext,
  mutate: (database: OpenClawStateDatabase) => T,
  publication?: { journalChanged?: true; unregisterDatabases?: boolean },
): T {
  return context.write(
    (database) => {
      assertLease(database, guard.lease, guard.predicate.agentId);
      assertAgentDeletionWorkerPredicate(database, guard.predicate);
      const result = mutate(database);
      assertLease(database, guard.lease, guard.predicate.agentId, "commit");
      if (publication?.journalChanged) {
        deferSqliteWorkerCommitReceipt(database.db, {
          kind: "agent-deletion-mutated",
          agentId: guard.predicate.agentId,
          operationId: guard.predicate.operationId,
          unregisterDatabases: publication.unregisterDatabases === true,
        });
      }
      return result;
    },
    { operationLabel: "agent.deletion" },
  );
}

export const agentDeletionOperations = {
  "agentDeletion.claimCompleted": (
    input: { agentId: string; operationId: string },
    context: WorkerWriteOperationContext,
  ) =>
    context.write(
      (database) => {
        requestSqliteWorkerOperationAdmission({ stage: "transaction", facts: undefined });
        const claimed = deleteAgentDeletionJournalInDatabase(
          database,
          input.agentId,
          input.operationId,
          true,
        );
        requestSqliteWorkerOperationAdmission({ stage: "commit", facts: undefined });
        deferSqliteWorkerCommitReceipt(database.db, {
          kind: "agent-deletion-claimed",
          agentId: input.agentId,
          operationId: input.operationId,
          claimed,
        });
        return claimed;
      },
      { operationLabel: "agent.deletion.claim" },
    ),
  "agentDeletion.read": (input: { agentId: string }, { open }: WorkerWriteOperationContext) =>
    readAgentDeletionJournalInDatabase(open(), input.agentId),
  "agentDeletion.listPending": (_input: undefined, { open }: WorkerWriteOperationContext) =>
    listPendingAgentDeletionJournalsInDatabase(open()),
  "agentDeletion.begin": (
    input: {
      entry: Parameters<typeof beginAgentDeletionJournalInDatabase>[1];
      lease: OpenClawStateLeaseIdentity;
      expectedClawInstall?: AgentDeletionWorkerPredicate["expectedClawInstall"];
      preserveDeleteFiles?: boolean;
      recoveryOperationId?: string;
    },
    context: WorkerWriteOperationContext,
  ) =>
    context.write(
      (database) => {
        assertLease(database, input.lease, input.entry.agentId);
        assertClawInstall(database, {
          agentId: input.entry.agentId,
          expectedClawInstall: input.expectedClawInstall,
        });
        ensureAgentProvenanceSchema({ database, ...context.stateOptions() });
        const result = beginAgentDeletionJournalInDatabase(
          database,
          input.entry,
          input.preserveDeleteFiles,
          input.recoveryOperationId,
        );
        assertLease(database, input.lease, input.entry.agentId, "commit");
        deferSqliteWorkerCommitReceipt(database.db, {
          kind: "agent-deletion-began",
          agentId: input.entry.agentId,
          operationId: input.entry.operationId,
        });
        return result;
      },
      { operationLabel: "agent.deletion.begin" },
    ),
  "agentDeletion.assertCurrent": (
    input: { guard: AgentDeletionWorkerGuard },
    context: WorkerWriteOperationContext,
  ) => guarded(input.guard, context, () => undefined),
  "agentDeletion.retire": (
    input: { guard: AgentDeletionWorkerGuard },
    context: WorkerWriteOperationContext,
  ) =>
    guarded(
      input.guard,
      context,
      (database) => {
        const { agentId, operationId } = input.guard.predicate;
        if (!retireAgentDeletionJournalInDatabase(database, agentId, operationId)) {
          throw new Error(`Failed to retire deletion journal for agent ${agentId}.`);
        }
      },
      { journalChanged: true },
    ),
  "agentDeletion.assertNoDatabaseLeasesUnowned": (
    input: { agentId: string },
    context: WorkerWriteOperationContext,
  ) =>
    assertNoOpenClawAgentDatabaseLeases(input.agentId, {
      database: context.open(),
      ...context.stateOptions(),
    }),
  "agentDeletion.assertNoDatabaseLeases": (
    input: { guard: AgentDeletionWorkerGuard },
    context: WorkerWriteOperationContext,
  ) =>
    guarded(input.guard, context, (database) =>
      assertNoOpenClawAgentDatabaseLeases(input.guard.predicate.agentId, {
        database,
        ...context.stateOptions(),
      }),
    ),
  "agentDeletion.fencePaths": (
    input: {
      guard: AgentDeletionWorkerGuard;
      paths:
        | { kind: "database"; paths: string[] }
        | { kind: "cleanup"; paths: AgentDeletionJournalCleanupPath[] };
    },
    context: WorkerWriteOperationContext,
  ) =>
    guarded(
      input.guard,
      context,
      (database) => {
        const { agentId, operationId } = input.guard.predicate;
        if (
          !updateAgentDeletionJournalPathsInDatabase(
            database,
            agentId,
            operationId,
            input.paths.kind === "database" ? "database_paths_json" : "cleanup_paths_json",
            input.paths.paths,
          )
        ) {
          throw new Error(`Failed to fence cleanup paths for agent ${agentId}.`);
        }
      },
      { journalChanged: true },
    ),
  "agentDeletion.finish": (
    input: { guard: AgentDeletionWorkerGuard; unregisterDatabases?: boolean },
    context: WorkerWriteOperationContext,
  ) =>
    guarded(
      input.guard,
      context,
      (database) => {
        const { agentId, operationId } = input.guard.predicate;
        if (input.unregisterDatabases) {
          unregisterOpenClawAgentDatabases({ agentId, database, env: context.stateOptions().env });
        }
        if (!completeAgentDeletionJournalInDatabase(database, agentId, operationId)) {
          throw new Error(`Failed to complete deletion journal for agent ${agentId}.`);
        }
      },
      { journalChanged: true, unregisterDatabases: input.unregisterDatabases },
    ),
  "agentDeletion.rollback": (
    input: { guard: AgentDeletionWorkerGuard },
    context: WorkerWriteOperationContext,
  ) =>
    guarded(
      input.guard,
      context,
      (database) => {
        const { agentId, operationId } = input.guard.predicate;
        if (!deleteAgentDeletionJournalInDatabase(database, agentId, operationId, false)) {
          throw new Error(`Failed to roll back deletion journal for agent ${agentId}.`);
        }
      },
      { journalChanged: true },
    ),
  "agentDeletion.releaseClawRows": (
    input: {
      guard: AgentDeletionWorkerGuard;
      files: Array<{ path: string; action: string }>;
      complete: boolean;
    },
    context: WorkerWriteOperationContext,
  ) =>
    guarded(
      input.guard,
      context,
      (database) => {
        const { agentId, operationId } = input.guard.predicate;
        if (input.complete) {
          unregisterOpenClawAgentDatabases({ agentId, database, env: context.stateOptions().env });
        }
        const query = getNodeSqliteKysely<DB>(database.db);
        const paths = [
          ...new Set(
            input.files.filter((file) => file.action !== "error").map((file) => file.path),
          ),
        ];
        if (paths.length && tableExists(database.db, "claw_workspace_files")) {
          executeSqliteQuerySync(
            database.db,
            query
              .deleteFrom("claw_workspace_files")
              .where("agent_id", "=", agentId)
              .where("target_path", "in", paths),
          );
        }
        if (!input.complete) {
          return false;
        }
        if (tableExists(database.db, "claw_package_refs")) {
          executeSqliteQuerySync(
            database.db,
            query.deleteFrom("claw_package_refs").where("agent_id", "=", agentId),
          );
        }
        if (tableExists(database.db, "claw_installs")) {
          executeSqliteQuerySync(
            database.db,
            query.deleteFrom("claw_installs").where("agent_id", "=", agentId),
          );
        }
        if (!completeAgentDeletionJournalInDatabase(database, agentId, operationId)) {
          throw new Error(`Failed to complete deletion journal for agent ${agentId}.`);
        }
        return true;
      },
      { journalChanged: true, unregisterDatabases: input.complete },
    ),
  "agentDeletion.handoffClawRetry": (
    input: { guard: AgentDeletionWorkerGuard; retryOperationId: string; nowMs: number },
    context: WorkerWriteOperationContext,
  ) =>
    context.write(
      (database) => {
        const { agentId, operationId } = input.guard.predicate;
        assertLease(database, input.guard.lease, agentId);
        const journal = readAgentDeletionJournalInDatabase(database, agentId);
        if (
          !journal ||
          journal.operationId !== operationId ||
          journal.cleanupCompleted ||
          (input.guard.predicate.expectedClawInstall !== undefined &&
            !isDeepStrictEqual(
              readClawInstallRecordFromDatabase(database.db, agentId) ?? null,
              input.guard.predicate.expectedClawInstall,
            ))
        ) {
          assertLease(database, input.guard.lease, agentId, "commit");
          return false;
        }
        const result = executeSqliteQuerySync(
          database.db,
          getNodeSqliteKysely<DB>(database.db)
            .updateTable("claw_installs")
            .set({ status: "partial", updated_at_ms: input.nowMs })
            .where("agent_id", "=", agentId),
        );
        if (
          result.numAffectedRows !== 1n ||
          !handoffAgentDeletionJournalInDatabase(
            database,
            agentId,
            operationId,
            input.retryOperationId,
          )
        ) {
          throw new Error(`Failed to hand off deletion journal for agent ${agentId}.`);
        }
        assertLease(database, input.guard.lease, agentId, "commit");
        deferSqliteWorkerCommitReceipt(database.db, {
          kind: "agent-deletion-mutated",
          agentId,
          operationId,
          unregisterDatabases: false,
        });
        return true;
      },
      { operationLabel: "agent.deletion.handoff" },
    ),
} satisfies WorkerOperationHandlers<WorkerWriteOperationContext>;
