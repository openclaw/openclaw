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
import type {
  OpenClawStateReadCommand,
  OpenClawStateReadReply,
} from "./openclaw-state-read.types.js";

export function readStateRegistryCommand(
  db: DatabaseSync,
  command: Extract<
    OpenClawStateReadCommand,
    {
      type:
        | "worktrees.cleanupState"
        | "fleet.list"
        | "fleet.get"
        | "sandboxRegistry.list"
        | "sandboxRegistry.get"
        | "sandboxRegistry.runtimeIds"
        | "sandboxRegistry.browsers";
    }
  >,
): OpenClawStateReadReply {
  const admitted = { ok: true, sourceAdmitted: true } as const;
  if (command.type === "sandboxRegistry.list") {
    return { ...admitted, type: command.type, entries: readSandboxRegistryInDatabase(db) };
  }
  if (command.type === "sandboxRegistry.get") {
    return {
      ...admitted,
      type: command.type,
      entry: readSandboxRegistryEntryInDatabase(db, command.containerName),
    };
  }
  if (command.type === "sandboxRegistry.runtimeIds") {
    return {
      ...admitted,
      type: command.type,
      runtimeIds: readSandboxRuntimeIdsInDatabase(db, command),
    };
  }
  if (command.type === "sandboxRegistry.browsers") {
    return { ...admitted, type: command.type, entries: readSandboxBrowserRegistryInDatabase(db) };
  }
  if (command.type === "worktrees.cleanupState") {
    return {
      ...admitted,
      type: command.type,
      records: listRegistryWorktreesInDatabase(db),
      leases: readWorktreeRunLeaseStateInDatabase(db),
    };
  }
  return command.type === "fleet.list"
    ? { ...admitted, type: command.type, cells: listFleetCellsInDatabase(db) }
    : { ...admitted, type: command.type, cell: getFleetCellInDatabase(db, command.tenantId) };
}
