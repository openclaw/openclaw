import type { DatabaseSync } from "node:sqlite";
import {
  readAgentDeletionJournalInDatabase,
  type AgentDeletionJournalEntry,
} from "../state/agent-deletion-journal.js";
import type { OpenClawAgentDatabaseOwnerInspection } from "../state/openclaw-agent-db-contract.js";
import { inspectOpenClawAgentDatabaseOwner } from "../state/openclaw-agent-db-lifecycle.js";
import { readOpenClawStateLease } from "../state/openclaw-state-lease-store.js";
import { readClawCronRefsInDatabase, type PersistedClawCronRef } from "./cron.js";
import {
  readAttachedCronJobsInDatabase,
  type AttachedCronJob,
} from "./lifecycle-delete-support.js";
import { readClawInstallRecordFromDatabase, type PersistedClawInstall } from "./provenance.js";

export type ClawRemoveFacts = {
  attachedJobs: AttachedCronJob[];
  cronRefs: PersistedClawCronRef[];
  install: PersistedClawInstall | null;
  journal: Pick<AgentDeletionJournalEntry, "operationId" | "cleanupCompleted" | "agentDir"> | null;
  deletionLease: { owner: string; expiresAt: number | null } | null;
  sessionStoreOwners: Array<{
    path: string;
    owner: OpenClawAgentDatabaseOwnerInspection;
  }>;
};

export function readClawRemoveFactsInDatabase(
  db: DatabaseSync,
  agentId: string,
  sessionStorePaths: readonly string[],
): ClawRemoveFacts {
  const journal = readAgentDeletionJournalInDatabase({ db }, agentId);
  const deletionLease = journal
    ? readOpenClawStateLease(db, { scope: "core:agent-deletion", key: agentId })
    : null;
  return {
    attachedJobs: readAttachedCronJobsInDatabase(db, agentId),
    cronRefs: readClawCronRefsInDatabase(db, agentId, true),
    install: readClawInstallRecordFromDatabase(db, agentId) ?? null,
    journal: journal
      ? {
          operationId: journal.operationId,
          cleanupCompleted: journal.cleanupCompleted,
          agentDir: journal.agentDir,
        }
      : null,
    deletionLease: deletionLease
      ? { owner: deletionLease.owner, expiresAt: deletionLease.expiresAt }
      : null,
    sessionStoreOwners: [...new Set(sessionStorePaths)].map((path) => ({
      path,
      owner: inspectOpenClawAgentDatabaseOwner(path),
    })),
  };
}
