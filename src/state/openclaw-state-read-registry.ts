import {
  readSandboxBrowserRegistryInDatabase,
  readSandboxRegistryEntryInDatabase,
  readSandboxRegistryInDatabase,
  readSandboxRuntimeIdsInDatabase,
} from "../agents/sandbox/registry.kernel.js";
import { listRegistryWorktreesInDatabase } from "../agents/worktrees/registry-read.kernel.js";
import { readWorktreeRunLeaseStateInDatabase } from "../agents/worktrees/run-lease-owner.js";
import { readPreparedPoolPresenceDemandInDatabase } from "../gateway/worker-environments/prepared-pool-presence-store.worker.js";
import {
  readWorkerEnvironmentFacts,
  readWorkerEnvironmentPrunePage,
} from "../gateway/worker-environments/store-row-codec.js";
import type { EngineConnection } from "../infra/sql-connection.js";
import { runSqliteDeferredTransactionSync } from "../infra/sqlite-transaction.js";
import { readAgentDeletionJournalStatusInDatabase } from "./agent-deletion-journal.read.js";
import type { OpenClawStateReadCommand } from "./openclaw-state-read.types.js";

export function readStateRegistryCommand(
  db: EngineConnection,
  command: Extract<
    OpenClawStateReadCommand,
    {
      type:
        | "preparedPoolPresence.read"
        | "workerEnvironments.snapshot"
        | "workerEnvironments.pruneCandidates"
        | "agentDeletionJournal.status"
        | "worktrees.cleanupState"
        | "sandboxRegistry.list"
        | "sandboxRegistry.get"
        | "sandboxRegistry.runtimeIds"
        | "sandboxRegistry.browsers";
    }
  >,
) {
  if (command.type === "preparedPoolPresence.read") {
    return { type: command.type, demand: readPreparedPoolPresenceDemandInDatabase(db) };
  }
  if (command.type === "workerEnvironments.snapshot") {
    return {
      type: command.type,
      facts: runSqliteDeferredTransactionSync(db, () =>
        readWorkerEnvironmentFacts(db, command.ids),
      ),
    };
  }
  if (command.type === "workerEnvironments.pruneCandidates") {
    return {
      type: command.type,
      page: readWorkerEnvironmentPrunePage(db, command.input),
    };
  }
  if (command.type === "agentDeletionJournal.status") {
    return {
      type: command.type,
      status: readAgentDeletionJournalStatusInDatabase(db, command.agentId),
    };
  }
  if (command.type === "sandboxRegistry.list") {
    return { type: command.type, entries: readSandboxRegistryInDatabase(db) };
  }
  if (command.type === "sandboxRegistry.get") {
    return {
      type: command.type,
      entry: readSandboxRegistryEntryInDatabase(db, command.containerName),
    };
  }
  if (command.type === "sandboxRegistry.runtimeIds") {
    return {
      type: command.type,
      runtimeIds: readSandboxRuntimeIdsInDatabase(db, command),
    };
  }
  if (command.type === "sandboxRegistry.browsers") {
    return { type: command.type, entries: readSandboxBrowserRegistryInDatabase(db) };
  }
  return {
    type: command.type,
    records: listRegistryWorktreesInDatabase(db),
    leases: readWorktreeRunLeaseStateInDatabase(db),
  };
}
