// Durable record of which Claw workspaces were adopted rather than created by the install.
import type { DatabaseSync } from "node:sqlite";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabaseOptions,
} from "../state/openclaw-state-db.js";
import type { ClawAddPlan } from "./types.js";

type AdoptedWorkspaceDatabase = Pick<OpenClawStateKyselyDatabase, "claw_adopted_workspaces">;

// Lazy additive table: absent on databases written before adoption shipped, where every workspace
// was created by its install. Fold into the next natural state schema-version bump.
const ensuredAdoptedWorkspaceDatabases = new WeakSet<DatabaseSync>();
const CLAW_ADOPTED_WORKSPACES_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS claw_adopted_workspaces (
  agent_id TEXT NOT NULL PRIMARY KEY,
  workspace TEXT NOT NULL,
  adopted_at_ms INTEGER NOT NULL
) STRICT;
`;

function ensureAdoptedWorkspacesSchema(options: OpenClawStateDatabaseOptions): void {
  const database = openOpenClawStateDatabase(options);
  if (ensuredAdoptedWorkspaceDatabases.has(database.db)) {
    return;
  }
  runOpenClawStateWriteTransaction(
    ({ db }) => {
      // sqlite-allow-raw -- feature-local additive schema DDL; rows use Kysely below.
      db.exec(CLAW_ADOPTED_WORKSPACES_SCHEMA_SQL);
    },
    options,
    { operationLabel: "claws.adopted-workspaces.schema.ensure" },
  );
  ensuredAdoptedWorkspaceDatabases.add(database.db);
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
  // sqlite-allow-raw -- feature-local additive schema DDL; rows use Kysely below.
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
  // sqlite-allow-raw -- feature-local additive schema DDL; rows use Kysely below.
  db.exec(CLAW_ADOPTED_WORKSPACES_SCHEMA_SQL);
  executeSqliteQuerySync(
    db,
    kyselyFor(db).deleteFrom("claw_adopted_workspaces").where("agent_id", "=", agentId),
  );
}

/** True when this agent's workspace directory existed before the Claw adopted it. */
export function clawWorkspaceWasAdopted(
  agentId: string,
  options: OpenClawStateDatabaseOptions = {},
): boolean {
  ensureAdoptedWorkspacesSchema(options);
  const { db } = openOpenClawStateDatabase(options);
  return (
    executeSqliteQuerySync(
      db,
      kyselyFor(db)
        .selectFrom("claw_adopted_workspaces")
        .select("agent_id")
        .where("agent_id", "=", agentId),
    ).rows.length > 0
  );
}
