import type { DatabaseSync } from "node:sqlite";
import type { Selectable } from "kysely";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../infra/kysely-sync.js";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import { createOpenClawStateSchemaEnsurer } from "../state/openclaw-state-feature-schema.js";

export type ProjectRegistryIdentity = {
  id: string;
  repoRoot: string;
  originUrl?: string;
  source: "workspace" | "registered" | "cloned";
};

export type ProjectRegistryRecord = ProjectRegistryIdentity & {
  displayName: string;
  agentId?: string;
};

type ProjectsDatabase = Pick<OpenClawStateKyselyDatabase, "projects">;
type ProjectRow = Selectable<ProjectsDatabase["projects"]>;

export const ensureProjectRegistrySchema = createOpenClawStateSchemaEnsurer({
  table: "projects",
  operationLabel: "projects.registry.schema.ensure",
});

export function rowToProject(row: ProjectRow): ProjectRegistryRecord {
  return {
    id: row.id,
    displayName: row.display_name,
    repoRoot: row.repo_root,
    ...(row.origin_url ? { originUrl: row.origin_url } : {}),
    // SAFETY: The canonical projects.source CHECK permits these two stored values.
    source: row.source as "registered" | "cloned",
  };
}

export function listProjectRegistryInDatabase(database: DatabaseSync): ProjectRegistryRecord[] {
  const db = getNodeSqliteKysely<ProjectsDatabase>(database);
  return executeSqliteQuerySync(database, db.selectFrom("projects").selectAll()).rows.map(
    rowToProject,
  );
}

export function resolveRecordedProjectRootInDatabase(
  database: DatabaseSync,
  repoRoot: string,
): string | undefined {
  const db = getNodeSqliteKysely<ProjectsDatabase>(database);
  return executeSqliteQueryTakeFirstSync(
    database,
    db.selectFrom("projects").select("repo_root").where("repo_root", "=", repoRoot),
  )?.repo_root;
}

function matchesProjectRecord(row: ProjectRow, project: ProjectRegistryIdentity): boolean {
  return (
    row.id === project.id &&
    row.repo_root === project.repoRoot &&
    row.source === project.source &&
    (row.origin_url ?? undefined) === project.originUrl
  );
}

export function readMatchingProjectRow(
  database: DatabaseSync,
  project: ProjectRegistryIdentity,
): ProjectRow | undefined {
  const db = getNodeSqliteKysely<ProjectsDatabase>(database);
  const row = executeSqliteQueryTakeFirstSync(
    database,
    db.selectFrom("projects").selectAll().where("id", "=", project.id),
  );
  return row && matchesProjectRecord(row, project) ? row : undefined;
}

export function removeProjectRegistryInDatabase(
  database: DatabaseSync,
  project: ProjectRegistryIdentity,
): boolean {
  if (!readMatchingProjectRow(database, project)) {
    return false;
  }
  const db = getNodeSqliteKysely<ProjectsDatabase>(database);
  return (
    executeSqliteQuerySync(database, db.deleteFrom("projects").where("id", "=", project.id))
      .numAffectedRows === 1n
  );
}
