import type { DatabaseSync } from "node:sqlite";
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
    { type: "worktrees.cleanupState" | "fleet.list" | "fleet.get" }
  >,
): OpenClawStateReadReply {
  const admitted = { ok: true, sourceAdmitted: true } as const;
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
