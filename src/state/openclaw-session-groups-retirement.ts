import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import {
  assertSqliteSchemaContains,
  collectSqliteSchemaIssues,
} from "../infra/sqlite-schema-contract.js";
import { StartupMaintenanceRequiredError } from "../infra/startup-maintenance-required.js";
import { tableExists } from "./openclaw-state-db-schema-helpers.js";
import { readStateSchemaContentVersion } from "./openclaw-state-db-schema-version.js";
import type { DB } from "./openclaw-state-db.generated.js";
import {
  assertNoRetiredStateTableDependencies,
  assertRetainedVirtualTablesUsable,
} from "./sqlite-retirement-dependencies.js";

// Pin the historical source contract independently of future agent catalog changes.
const LEGACY_SESSION_GROUPS_SCHEMA_SQL = `
CREATE TABLE session_groups (
  name TEXT NOT NULL PRIMARY KEY,
  position INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  cwd TEXT,
  worktree INTEGER
) STRICT;
`;
const PRE_STRICT_SESSION_GROUPS_SCHEMA_SQL = LEGACY_SESSION_GROUPS_SCHEMA_SQL.replace(
  ") STRICT;",
  ");",
);
// The old first-use defaults owner allowed these columns to remain absent.
const LEGACY_SESSION_GROUPS_COMPATIBILITY = {
  allowedMissingColumns: ["session_groups.cwd", "session_groups.worktree"],
};

export function assertLegacySessionGroupsSchema(db: DatabaseSync, pathname: string): void {
  if (!tableExists(db, "session_groups")) {
    return;
  }
  const schema =
    readStateSchemaContentVersion(db) < 3 &&
    collectSqliteSchemaIssues(
      db,
      PRE_STRICT_SESSION_GROUPS_SCHEMA_SQL,
      LEGACY_SESSION_GROUPS_COMPATIBILITY,
    ).length === 0
      ? PRE_STRICT_SESSION_GROUPS_SCHEMA_SQL
      : LEGACY_SESSION_GROUPS_SCHEMA_SQL;
  assertSqliteSchemaContains(
    db,
    `legacy session groups at ${pathname}`,
    schema,
    LEGACY_SESSION_GROUPS_COMPATIBILITY,
  );
}

const proofs = new Map<string, () => void>();
/** A synchronous, owner-held proof cannot survive a failed Doctor or authorize a later writer. */
export function withSessionGroupRetirementProof<T>(
  pathname: string,
  verify: () => void,
  run: () => T,
): T {
  const key = path.resolve(pathname);
  if (proofs.has(key)) {
    throw new Error("Session-group retirement is already running");
  }
  proofs.set(key, verify);
  try {
    return run();
  } finally {
    proofs.delete(key);
  }
}
export function assertSessionGroupRetirementReady(db: DatabaseSync, pathname: string): void {
  const version = readStateSchemaContentVersion(db);
  if (version >= 17 || (version <= 0 && !tableExists(db, "session_groups"))) {
    return;
  }
  const verify = proofs.get(path.resolve(pathname));
  if (!verify) {
    throw new StartupMaintenanceRequiredError(
      "session-groups-per-agent",
      `Session groups require Doctor migration at ${pathname}; run openclaw doctor --fix.`,
    );
  }
  verify();
}
export function retireLegacySessionGroups(db: DatabaseSync, pathname: string): void {
  if (readStateSchemaContentVersion(db) >= 17) {
    return;
  }
  assertLegacySessionGroupsSchema(db, pathname);
  assertSessionGroupRetirementReady(db, pathname);
  if (tableExists(db, "session_groups")) {
    const dependents = db
      .prepare(
        "SELECT name FROM sqlite_schema WHERE sql IS NOT NULL AND tbl_name = 'session_groups' AND type != 'table'",
      )
      .all(); // sqlite-allow-raw -- Retirement refuses unknown attached objects.
    if (dependents.length) {
      throw new Error("Session-group retirement has unknown schema dependents");
    }
    assertNoRetiredStateTableDependencies(db, "session_groups");
    assertRetainedVirtualTablesUsable(db, "session_groups", "before");
    db.exec("DROP TABLE session_groups;"); // sqlite-allow-raw -- Schema17 retires the verified legacy catalog.
    assertRetainedVirtualTablesUsable(db, "session_groups", "after");
  }
  if (tableExists(db, "config_machine_state")) {
    executeSqliteQuerySync(
      db,
      getNodeSqliteKysely<Pick<DB, "config_machine_state">>(db)
        .deleteFrom("config_machine_state")
        .where("state_key", "=", "sidebar.sectionOrder"),
    );
  }
}
