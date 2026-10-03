import type { DatabaseSync } from "node:sqlite";
import {
  readSandboxBrowserRegistryInDatabase,
  readSandboxRegistryEntryInDatabase,
  readSandboxRegistryInDatabase,
  readSandboxRuntimeIdsInDatabase,
} from "../agents/sandbox/registry.kernel.js";
import { listRegistryWorktreesInDatabase } from "../agents/worktrees/registry-read.kernel.js";
import { readWorktreeRunLeaseStateInDatabase } from "../agents/worktrees/run-lease-owner.js";
import { getFleetCellInDatabase, listFleetCellsInDatabase } from "../fleet/registry.kernel.js";
import { readAgentDeletionJournalAuthorityInDatabase } from "./agent-deletion-journal-authority.worker.js";
import { readAgentDeletionJournalStatusInDatabase } from "./agent-deletion-journal.read.js";
import type {
  OpenClawStateReadCommand,
  OpenClawStateReadResult,
} from "./openclaw-state-read.types.js";

export function readStateRegistryCommand(
  db: DatabaseSync,
  command: Extract<
    OpenClawStateReadCommand,
    {
      type:
        | "agentDeletionJournal.status"
        | "agentDeletionJournal.authority"
        | "worktrees.cleanupState"
        | "fleet.list"
        | "fleet.get"
        | "sandboxRegistry.list"
        | "sandboxRegistry.get"
        | "sandboxRegistry.runtimeIds"
        | "sandboxRegistry.browsers";
    }
  >,
): OpenClawStateReadResult {
  if (command.type === "agentDeletionJournal.status") {
    return {
      type: command.type,
      status: readAgentDeletionJournalStatusInDatabase(db, command.agentId),
    };
  }
  if (command.type === "agentDeletionJournal.authority") {
    return {
      type: command.type,
      authority: readAgentDeletionJournalAuthorityInDatabase(db, command.agentId),
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
  if (command.type === "worktrees.cleanupState") {
    return {
      type: command.type,
      records: listRegistryWorktreesInDatabase(db),
      leases: readWorktreeRunLeaseStateInDatabase(db),
    };
  }
  return command.type === "fleet.list"
    ? { type: command.type, cells: listFleetCellsInDatabase(db) }
    : { type: command.type, cell: getFleetCellInDatabase(db, command.tenantId) };
}
