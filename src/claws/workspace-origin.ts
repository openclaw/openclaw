// Durable record of which Claw workspaces were adopted rather than created by the install.
import type { DatabaseSync } from "node:sqlite";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import {
  openOpenClawStateDatabase,
  type OpenClawStateDatabaseOptions,
} from "../state/openclaw-state-db.js";
import type { ClawAddPlan } from "./types.js";

type AdoptedWorkspaceDatabase = Pick<OpenClawStateKyselyDatabase, "claw_adopted_workspaces">;

// Lazy additive table: absent on databases written before adoption shipped, where every workspace
// was created by its install. Fold into the next natural state schema-version bump.
const CLAW_ADOPTED_WORKSPACES_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS claw_adopted_workspaces (
  agent_id TEXT NOT NULL PRIMARY KEY,
  workspace TEXT NOT NULL,
  adopted_at_ms INTEGER NOT NULL
) STRICT;
`;

// Local probe rather than the sibling helper in lifecycle-delete-support: that module imports this
// one, so reaching back for it would close an import cycle.
function adoptedWorkspacesTableExists(db: DatabaseSync): boolean {
  return Boolean(
    db /* sqlite-allow-raw: schema probe for the optional adopted-workspace table. */
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get("claw_adopted_workspaces"),
  );
}

function kyselyFor(db: DatabaseSync) {
  return getNodeSqliteKysely<AdoptedWorkspaceDatabase>(db);
}

/** True when the consented plan adopts an existing directory instead of creating one. */
export function planAdoptsWorkspace(plan: ClawAddPlan): boolean {
  return plan.actions.some((action) => action.kind === "workspace" && action.action === "adopt");
}

/**
 * Records an adopted workspace inside the caller's open write transaction, so the origin lands
 * with the install record it belongs to rather than in a second, separately failable write.
 */
export function recordAdoptedWorkspaceRow(params: {
  db: DatabaseSync;
  agentId: string;
  workspace: string;
  nowMs: number;
}): void {
  // sqlite-allow-raw -- feature-local additive schema DDL; rows use Kysely below. This is the only
  // path allowed to create the table: reads and deletes probe instead, so a preview never writes.
  params.db.exec(CLAW_ADOPTED_WORKSPACES_SCHEMA_SQL);
  executeSqliteQuerySync(
    params.db,
    kyselyFor(params.db)
      .insertInto("claw_adopted_workspaces")
      .values({
        agent_id: params.agentId,
        workspace: params.workspace,
        adopted_at_ms: params.nowMs,
      })
      .onConflict((conflict) =>
        conflict.column("agent_id").doUpdateSet({
          workspace: params.workspace,
          adopted_at_ms: params.nowMs,
        }),
      ),
  );
}

/** Drops the adopted-workspace row inside the caller's open write transaction. */
export function deleteAdoptedWorkspaceRow(db: DatabaseSync, agentId: string): void {
  if (!adoptedWorkspacesTableExists(db)) {
    return;
  }
  executeSqliteQuerySync(
    db,
    kyselyFor(db).deleteFrom("claw_adopted_workspaces").where("agent_id", "=", agentId),
  );
}

/**
 * True when this agent's current workspace directory existed before the Claw adopted it. The
 * workspace is part of the match because a downgrade can delete an install record while leaving
 * this optional table behind, and a later install reusing the agent id owns a different directory.
 */
export function clawWorkspaceWasAdopted(
  agentId: string,
  workspace: string,
  options: OpenClawStateDatabaseOptions = {},
): boolean {
  const { db } = openOpenClawStateDatabase(options);
  if (!adoptedWorkspacesTableExists(db)) {
    return false;
  }
  return (
    executeSqliteQuerySync(
      db,
      kyselyFor(db)
        .selectFrom("claw_adopted_workspaces")
        .select("agent_id")
        .where("agent_id", "=", agentId)
        .where("workspace", "=", workspace),
    ).rows.length > 0
  );
}
