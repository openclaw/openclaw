import { assertWorktreePersistentExecutionCurrentInDatabase } from "../../agents/worktrees/run-lease-store.kernel.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../../infra/kysely-sync.js";
import type { EngineConnection } from "../../infra/sql-connection.js";
import { getAdmittedSqlSchemaFacts } from "../../infra/sqlite-schema-facts.js";
import { tableExists } from "../../state/openclaw-state-db-schema-helpers.js";
import type { DB } from "../../state/openclaw-state-db.generated.js";
import { getOpenClawStateFeatureSchemaSql } from "../../state/openclaw-state-feature-schema.js";
import type {
  LocalWorkspaceMutation,
  LocalWorkspaceProjection,
} from "./local-workspace-store.types.js";

const table = "local_workspace_projections";
const nodes = "local_workspace_manifest_nodes";
const query = (db: EngineConnection) =>
  getNodeSqliteKysely<Pick<DB, typeof table | typeof nodes>>(db);

export function readLocalWorkspaceProjectionInDatabase(db: EngineConnection, id: string) {
  return tableExists(db, table)
    ? executeSqliteQueryTakeFirstSync(
        db,
        query(db).selectFrom(table).selectAll().where("worktree_id", "=", id),
      )
    : undefined;
}

export function hasLocalWorkspaceProjectionInDatabase(db: EngineConnection, id: string): boolean {
  return (
    tableExists(db, table) &&
    executeSqliteQueryTakeFirstSync(
      db,
      query(db).selectFrom(table).select("worktree_id").where("worktree_id", "=", id),
    ) !== undefined
  );
}

export function mutateLocalWorkspaceProjection(
  db: EngineConnection,
  id: string,
  mutation: LocalWorkspaceMutation,
) {
  // Mutation admission must not materialize manifests or recovery packs.
  const current = tableExists(db, table)
    ? executeSqliteQueryTakeFirstSync(
        db,
        query(db)
          .selectFrom(table)
          .select(["revision", "baseline_ref"])
          .$if(mutation.kind === "delete", (builder) =>
            builder.select((eb) =>
              eb
                .or([
                  eb(
                    eb.fn.coalesce(eb.fn<number>("octet_length", ["pending_ref"]), eb.val(0)),
                    ">",
                    0,
                  ),
                  eb(
                    eb.fn.coalesce(eb.fn<number>("octet_length", ["journal_json"]), eb.val(0)),
                    ">",
                    0,
                  ),
                ])
                .as("unsettled"),
            ),
          )
          .where("worktree_id", "=", id),
      )
    : undefined;
  if (mutation.kind === "create") {
    if (current || mutation.row.worktree_id !== id) {
      throw new Error("Local workspace binding already exists");
    }
    if (!tableExists(db, table)) {
      // First-use additive admission preserves the existing numeric schema version.
      db.exec(getOpenClawStateFeatureSchemaSql(table)); // sqlite-allow-raw -- Canonical first-use schema admission.
    }
    return executeSqliteQueryTakeFirstSync(
      db,
      query(db)
        .insertInto(table)
        .values({ ...mutation.row, revision: 0 })
        .returning(["worktree_id", "revision"]),
    );
  }
  if (!current || current.revision !== mutation.revision) {
    throw new Error("Local workspace binding changed");
  }
  if (mutation.kind === "delete") {
    if (current.unsettled) {
      throw new Error("Local workspace has unsettled edits");
    }
    executeSqliteQueryTakeFirstSync(
      db,
      query(db).deleteFrom(table).where("worktree_id", "=", id).returning("worktree_id"),
    );
    return undefined;
  }
  if (mutation.manifest) {
    const { records, removed, previousRoot, replace } = mutation.manifest;
    if (current.baseline_ref !== previousRoot) {
      throw new Error("Local workspace manifest baseline changed");
    }
    if (replace) {
      executeSqliteQuerySync(db, query(db).deleteFrom(nodes).where("worktree_id", "=", id));
    } else {
      for (let offset = 0; offset < removed.length; offset += 500) {
        executeSqliteQuerySync(
          db,
          query(db)
            .deleteFrom(nodes)
            .where("worktree_id", "=", id)
            .where("path", "in", removed.slice(offset, offset + 500)),
        );
      }
    }
    for (let offset = 0; offset < records.length; offset += 500) {
      executeSqliteQuerySync(
        db,
        query(db)
          .insertInto(nodes)
          .values(
            records.slice(offset, offset + 500).map((record) => ({
              worktree_id: id,
              path: record.node.path,
              node_json: JSON.stringify(record),
            })),
          )
          .onConflict((conflict) =>
            conflict.columns(["worktree_id", "path"]).doUpdateSet((eb) => ({
              node_json: eb.ref("excluded.node_json"),
            })),
          ),
      );
    }
  }
  return executeSqliteQueryTakeFirstSync(
    db,
    query(db)
      .updateTable(table)
      .set({
        ...mutation.patch,
        ...(mutation.manifest
          ? { baseline_ref: mutation.manifest.resultingRoot, baseline_json: null }
          : {}),
        worktree_id: id,
        revision: current.revision + 1,
      })
      .where("worktree_id", "=", id)
      .returning(["worktree_id", "revision"]),
  );
}

export function readLocalWorkspaceProjectionByPathInDatabase(
  db: EngineConnection,
  projectionPath: string,
): LocalWorkspaceProjection | null {
  if (!getAdmittedSqlSchemaFacts(db)) {
    throw new Error("Local workspace lookup requires admitted schema facts.");
  }
  if (!tableExists(db, table)) {
    return null;
  }
  return (
    executeSqliteQueryTakeFirstSync(
      db,
      query(db).selectFrom(table).selectAll().where("projection_path", "=", projectionPath),
    ) ?? null
  );
}

/** Called by execution admission inside the shared worker transaction, never a host-thread lookup. */
export function assertLocalWorkspacePersistentExecutionCurrentInDatabase(
  db: EngineConnection,
  expected: {
    workspaceDir: string;
    agentId: string;
    sessionKey: string;
    sessionId: string;
    lifecycleRevision?: string;
  },
): void {
  const row = readLocalWorkspaceProjectionByPathInDatabase(db, expected.workspaceDir);
  if (
    !row ||
    row.agent_id !== expected.agentId ||
    row.session_key !== expected.sessionKey ||
    row.session_id !== expected.sessionId ||
    row.lifecycle_revision !== (expected.lifecycleRevision ?? null)
  ) {
    throw new Error(
      "Managed sandbox projection ownership changed; persistent execution must stop.",
    );
  }
  assertWorktreePersistentExecutionCurrentInDatabase(db, row.worktree_id);
}

export const localWorkspaceReadOperations = {
  "localWorkspace.reviewBase": (input: { id: string }, db: EngineConnection) => ({
    type: "localWorkspace.reviewBase" as const,
    row: tableExists(db, table)
      ? executeSqliteQueryTakeFirstSync(
          db,
          query(db)
            .selectFrom(table)
            .select(["worktree_id", "agent_id", "session_key", "session_id", "base_commit"])
            .where("worktree_id", "=", input.id),
        )
      : undefined,
  }),
  "localWorkspace.byProjectionPath": (input: { projectionPath: string }, db: EngineConnection) => ({
    type: "localWorkspace.byProjectionPath" as const,
    projection: readLocalWorkspaceProjectionByPathInDatabase(db, input.projectionPath),
  }),
  "localWorkspace.exists": (input: { id: string }, db: EngineConnection) => ({
    type: "localWorkspace.exists" as const,
    exists: hasLocalWorkspaceProjectionInDatabase(db, input.id),
  }),
  "localWorkspace.get": (input: { id: string }, db: EngineConnection) => ({
    type: "localWorkspace.get" as const,
    row: readLocalWorkspaceProjectionInDatabase(db, input.id),
  }),
};
