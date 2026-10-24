import { extractSqliteTableSchema } from "../infra/sqlite-schema-sql.js";
import {
  FIRST_USE_STATE_TABLES,
  LAZY_ADDITIVE_STATE_TABLES,
} from "./openclaw-state-db-contract.js";
import { OPENCLAW_STATE_SCHEMA_SQL } from "./openclaw-state-schema.js";

type SchemaOptions = Parameters<typeof extractSqliteTableSchema>[2];

// Feature-local DDL is relocated verbatim; callers retain their first-use timing.
const featureLocalSql: Record<string, string> = {
  local_workspace_projections: [
    extractSqliteTableSchema(OPENCLAW_STATE_SCHEMA_SQL, "local_workspace_projections"),
    extractSqliteTableSchema(OPENCLAW_STATE_SCHEMA_SQL, "local_workspace_manifest_nodes"),
  ].join("\n"),
  user_profiles: `
CREATE TABLE IF NOT EXISTS user_profiles (
  id TEXT NOT NULL PRIMARY KEY,
  display_name TEXT,
  primary_github_account_id INTEGER,
  avatar BLOB,
  avatar_mime TEXT,
  avatar_sha256 TEXT,
  merged_into TEXT,
  role TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS user_profile_emails (
  email TEXT NOT NULL PRIMARY KEY,
  profile_id TEXT NOT NULL,
  binding_id TEXT,
  created_at INTEGER NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS idx_user_profile_emails_profile_id
  ON user_profile_emails(profile_id);

${extractSqliteTableSchema(OPENCLAW_STATE_SCHEMA_SQL, "user_profile_identities")}
`,
  operator_approval_standing_grants: `
CREATE TABLE IF NOT EXISTS operator_approval_standing_grants (
  grant_id TEXT NOT NULL PRIMARY KEY CHECK (length(grant_id) > 0),
  minted_by_approval_id TEXT NOT NULL
    REFERENCES operator_approvals(approval_id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL CHECK (length(agent_id) > 0),
  cron_job_id TEXT NOT NULL CHECK (length(cron_job_id) > 0),
  job_config_revision TEXT NOT NULL CHECK (length(job_config_revision) > 0),
  operation_binding TEXT NOT NULL CHECK (length(operation_binding) > 0),
  created_at_ms INTEGER NOT NULL,
  expires_at_ms INTEGER CHECK (expires_at_ms IS NULL OR expires_at_ms >= created_at_ms),
  revoked_at_ms INTEGER,
  revoked_by TEXT,
  last_used_at_ms INTEGER,
  use_count INTEGER NOT NULL DEFAULT 0
) STRICT;

CREATE INDEX IF NOT EXISTS idx_operator_approval_standing_grants_binding
  ON operator_approval_standing_grants(agent_id, cron_job_id, operation_binding, created_at_ms DESC);

CREATE TABLE IF NOT EXISTS operator_approval_standing_grant_generations (
  grant_id TEXT NOT NULL PRIMARY KEY
    REFERENCES operator_approval_standing_grants(grant_id) ON DELETE CASCADE,
  job_definition_generation INTEGER NOT NULL CHECK (job_definition_generation >= 1)
) STRICT;
`,
  operator_approval_execution_identities: `
CREATE TABLE IF NOT EXISTS operator_approval_execution_identities (
  approval_id TEXT NOT NULL PRIMARY KEY
    REFERENCES operator_approvals(approval_id) ON DELETE CASCADE,
  source_context_id TEXT NOT NULL CHECK (
    length(source_context_id) BETWEEN 1 AND 256 AND source_context_id = trim(source_context_id)
  ),
  source_execution_id TEXT NOT NULL CHECK (
    length(source_execution_id) BETWEEN 1 AND 256 AND source_execution_id = trim(source_execution_id)
  )
) STRICT;
`,
  worker_environment_ssh_fallback_ports: `
CREATE TABLE IF NOT EXISTS worker_environment_ssh_fallback_ports (
  environment_id TEXT NOT NULL,
  position INTEGER NOT NULL CHECK (position >= 0 AND position <= 9),
  port INTEGER NOT NULL CHECK (port >= 1 AND port <= 65535),
  PRIMARY KEY (environment_id, position),
  UNIQUE (environment_id, port),
  FOREIGN KEY (environment_id) REFERENCES worker_environments(environment_id) ON DELETE CASCADE
) STRICT;
`,
  worker_environment_session_attachments: `
CREATE TABLE IF NOT EXISTS worker_environment_session_attachments (
  session_id TEXT PRIMARY KEY,
  session_key TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  session_lifecycle_revision TEXT,
  environment_id TEXT NOT NULL UNIQUE,
  generation INTEGER NOT NULL CHECK (generation >= 1),
  created_at_ms INTEGER NOT NULL,
  last_used_at_ms INTEGER NOT NULL,
  closed_at_ms INTEGER,
  FOREIGN KEY (environment_id) REFERENCES worker_environments(environment_id) ON DELETE CASCADE
) STRICT;
CREATE INDEX IF NOT EXISTS worker_environment_session_attachments_session_key
ON worker_environment_session_attachments(agent_id, session_key);
`,
};

export function getOpenClawStateFeatureSchemaSql(table: string, options?: SchemaOptions): string {
  if (options === undefined && featureLocalSql[table]) {
    return featureLocalSql[table];
  }
  if (table === "skill_library_entries" && options === undefined) {
    return extractSqliteTableSchema(OPENCLAW_STATE_SCHEMA_SQL, table, {
      endMarker: "-- End profile-owned skill library.",
      includeEndMarker: false,
      errorMessage: "Canonical skill library schema missing.",
    });
  }
  return extractSqliteTableSchema(
    table === "user_profile_emails" ? featureLocalSql.user_profiles! : OPENCLAW_STATE_SCHEMA_SQL,
    table,
    options,
  );
}

type OpenClawStateFeatureSchema = {
  id: string;
  tables: readonly string[];
  indexes: readonly string[];
  dependencies: readonly string[];
  activation: "first-use" | "version-additive";
  sql: () => string;
};
let declarations: readonly OpenClawStateFeatureSchema[] | undefined;

/** One discoverable owner for SQLite first-use DDL and generated PostgreSQL fragments. */
export function listOpenClawStateFeatureSchemas(): readonly OpenClawStateFeatureSchema[] {
  if (declarations) {
    return declarations;
  }
  const groups: Record<string, string[]> = {
    local_workspace_projections: ["local_workspace_projections", "local_workspace_manifest_nodes"],
    user_profiles: ["user_profiles", "user_profile_emails", "user_profile_identities"],
    skill_library_entries: [
      "skill_library_entries",
      "skill_library_revisions",
      "skill_library_events",
      "skill_library_uploads",
    ],
    operator_approval_standing_grants: [
      "operator_approval_standing_grants",
      "operator_approval_standing_grant_generations",
    ],
    worker_environment_session_attachments: ["worker_environment_session_attachments"],
  };
  const firstUseTables = new Set<string>(FIRST_USE_STATE_TABLES);
  const owned = new Set(Object.values(groups).flat());
  for (const table of LAZY_ADDITIVE_STATE_TABLES) {
    if (!owned.has(table)) {
      groups[table] = [table];
    }
  }
  const owner = new Map(
    Object.entries(groups).flatMap(([id, tables]) => tables.map((table) => [table, id] as const)),
  );
  const canonicalIndexes = [
    ...OPENCLAW_STATE_SCHEMA_SQL.matchAll(
      /CREATE (?:UNIQUE )?INDEX IF NOT EXISTS (\w+)\s+ON (\w+)[\s\S]*?;/g,
    ),
  ];
  declarations = Object.entries(groups).map(([id, tables]) => {
    const ddl = tables.map((table) => getOpenClawStateFeatureSchemaSql(table));
    const indexes = canonicalIndexes.filter((match) => tables.includes(match[2]!));
    const sql = [...ddl, ...indexes.map((match) => match[0])].join("\n");
    const localIndexes = [...sql.matchAll(/CREATE (?:UNIQUE )?INDEX IF NOT EXISTS (\w+)/g)].map(
      (match) => match[1]!,
    );
    const dependencies = [
      ...new Set(
        [...sql.matchAll(/REFERENCES (\w+)/g)]
          .map((match) => owner.get(match[1]!))
          .filter((ref): ref is string => ref !== undefined && ref !== id),
      ),
    ];
    const activation =
      tables.some((table) => firstUseTables.has(table)) ||
      id === "worker_environment_session_attachments"
        ? "first-use"
        : "version-additive";
    return {
      id,
      tables,
      indexes: [...new Set(localIndexes)],
      dependencies,
      activation,
      sql: () => sql,
    };
  });
  return declarations;
}
