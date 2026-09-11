import fs from "node:fs/promises";
import type { DatabaseSync, SQLOutputValue } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import { openNodeSqliteDatabase, resolveImmutableSqliteFileUri } from "../infra/node-sqlite.js";
import { assertSqliteIntegrity } from "../infra/sqlite-integrity.js";
import { createSqliteTableContractReader } from "../infra/sqlite-schema-contract.js";
import { quoteSqliteIdentifier } from "../infra/sqlite-schema-sql.js";
import { readSqliteUserVersion } from "../infra/sqlite-user-version.js";
import { versionedStateMigrations } from "./openclaw-state-db-maintenance.js";
import { tableExists, tableHasColumn } from "./openclaw-state-db-schema-helpers.js";
import {
  CONTENT_VERSION_KEY,
  readStateSchemaContentVersion,
} from "./openclaw-state-db-schema-version.js";

type Row = Record<string, SQLOutputValue>;
const proposals = "skill_workshop_proposals";
const reviews = "skill_workshop_collection_reviews";
const workerColumns = [
  "preparation_consumed_at_ms",
  "preparation_expires_at_ms",
  "preparation_demand_at_ms",
  "preparation_purpose",
  "preparation_key",
  "last_activated_at_ms",
] as const;

function rows(database: DatabaseSync, sql: string): Row[] {
  const query = database.prepare(sql);
  query.setReadBigInts(true);
  return query.all();
}

function columns(database: DatabaseSync, table: string): Row[] {
  return rows(database, `PRAGMA table_xinfo(${quoteSqliteIdentifier(table)})`);
}

function refuse(resource: string, reason: string): never {
  throw new Error(
    `Shared-state recovery refused for ${resource}: ${reason}. Baseline and candidate were not changed.`,
  );
}

function value(row: Row, key: string): SQLOutputValue {
  const result = row[key];
  if (result === undefined) {
    return refuse(key, "missing required column");
  }
  return result;
}

function text(row: Row, key: string): string {
  const result = row[key];
  if (typeof result !== "string") {
    return refuse(key, "unrecognized row identity");
  }
  return result;
}

/** Only these two Workshop tables changed representation in v16. Keep current
 * common columns and rowids; restore only the lost workspace/claim attribution.
 * Deleted current rows remain deleted. Never synthesize identities from paths. */
function prepareWorkshop(baseline: DatabaseSync, target: DatabaseSync): void {
  const baselineProposals = tableExists(baseline, proposals)
    ? rows(baseline, `SELECT * FROM ${proposals}`)
    : [];
  const byId = new Map(baselineProposals.map((row) => [text(row, "proposal_id"), row]));
  const workspaceOwners = new Map<string, Set<string>>();
  for (const row of baselineProposals) {
    const workspace = text(row, "workspace_dir");
    if (typeof row.owner_agent_id === "string") {
      const owners = workspaceOwners.get(workspace) ?? new Set<string>();
      owners.add(row.owner_agent_id);
      workspaceOwners.set(workspace, owners);
    }
  }
  const originalReviews = tableExists(baseline, reviews)
    ? rows(baseline, `SELECT * FROM ${reviews}`)
    : [];
  const reviewById = new Map(originalReviews.map((row) => [text(row, "review_id"), row]));
  for (const row of originalReviews) {
    if (workspaceOwners.get(text(row, "workspace_dir"))?.size !== 1) {
      refuse(reviews, `review ${text(row, "review_id")} has ambiguous migration attribution`);
    }
  }
  for (const table of [proposals, reviews]) {
    if (!tableExists(baseline, table)) {
      if (tableExists(target, table) && rows(target, `SELECT 1 FROM ${table} LIMIT 1`).length) {
        refuse(table, "new identities have no older workspace/claim representation");
      }
      continue;
    }
    if (!tableExists(target, table)) {
      refuse(table, "migration-owned table is missing");
    }
    const currentRows = rows(target, `SELECT rowid AS __recovery_rowid__, * FROM ${table}`);
    for (const current of currentRows) {
      if (table === proposals) {
        const id = text(current, "proposal_id");
        const original = byId.get(id);
        if (!original || original.owner_agent_id !== current.owner_agent_id) {
          refuse(proposals, `proposal ${id} is new or changed its owner`);
        }
        current.workspace_dir = text(original, "workspace_dir");
        if (tableHasColumn(baseline, proposals, "claim_released_time")) {
          current.claim_released_time = value(original, "claim_released_time");
        }
      } else {
        const id = text(current, "review_id");
        const original = reviewById.get(id);
        if (!original) {
          refuse(reviews, `review ${id} has no baseline workspace identity`);
        }
        const workspace = text(original, "workspace_dir");
        if (!workspaceOwners.get(workspace)?.has(text(current, "owner_agent_id"))) {
          refuse(reviews, `review ${id} changed its owner`);
        }
        current.workspace_dir = workspace;
        delete current.owner_agent_id;
      }
    }
    rebuildWorkshopTable(baseline, target, table, currentRows);
  }
}

function rebuildWorkshopTable(
  baseline: DatabaseSync,
  target: DatabaseSync,
  table: string,
  currentRows: Row[],
): void {
  const oldColumns = columns(baseline, table);
  const currentColumns = columns(target, table);
  const oldNames = new Set(oldColumns.map((column) => text(column, "name")));
  const added = currentColumns.filter(
    (column) =>
      !oldNames.has(text(column, "name")) &&
      !(table === reviews && column.name === "owner_agent_id"),
  );
  for (const column of added) {
    if (
      !/^(ANY|BLOB|INT|INTEGER|REAL|TEXT)$/u.test(text(column, "type")) ||
      column.notnull !== 0n ||
      column.pk !== 0n ||
      column.hidden !== 0n ||
      column.dflt_value !== null
    ) {
      refuse(table, `unrepresentable additional column ${text(column, "name")}`);
    }
  }
  const objects = baseline
    .prepare(
      "SELECT type, sql FROM sqlite_schema WHERE tbl_name = ? AND sql IS NOT NULL ORDER BY type, name",
    )
    .all(table);
  const definition = objects.find((object) => object.type === "table")?.sql;
  if (typeof definition !== "string") {
    refuse(table, "older table definition is unavailable");
  }
  const names = [...oldNames, ...added.map((column) => text(column, "name"))];
  for (const row of currentRows) {
    if (names.some((name) => !(name in row))) {
      refuse(table, "a non-migration column disappeared");
    }
  }
  // This runs only in a private copy with foreign keys disabled. Recreate the
  // original schema before restoring indexes/triggers, so inserts cannot replay
  // migration or application trigger effects.
  target.exec(`DROP TABLE ${quoteSqliteIdentifier(table)}`);
  target.exec(definition);
  for (const column of added) {
    target.exec(
      `ALTER TABLE ${quoteSqliteIdentifier(table)} ADD COLUMN ${quoteSqliteIdentifier(text(column, "name"))} ${text(column, "type")}`,
    );
  }
  const insert = target.prepare(
    `INSERT INTO ${quoteSqliteIdentifier(table)} (rowid, ${names.map(quoteSqliteIdentifier).join(",")}) VALUES (${names
      .map(() => "?")
      .concat("?")
      .join(",")})`,
  );
  for (const row of currentRows) {
    insert.run(value(row, "__recovery_rowid__"), ...names.map((name) => value(row, name)));
  }
  for (const object of objects) {
    if (object.type !== "table" && typeof object.sql === "string") {
      target.exec(object.sql);
    }
  }
}

function prepareWorkers(baseline: DatabaseSync, target: DatabaseSync): void {
  if (!tableExists(target, "worker_environments")) {
    return;
  }
  const present = workerColumns.filter(
    (column) =>
      tableHasColumn(target, "worker_environments", column) &&
      !tableHasColumn(baseline, "worker_environments", column),
  );
  if (present.length === 0) {
    refuse("worker_environments", "v17 content marker has no prepared-worker columns");
  }
  const unsettled = target
    .prepare(
      `SELECT environment_id FROM worker_environments WHERE ${present.map((column) => `${column} IS NOT NULL`).join(" OR ")} LIMIT 1`,
    )
    .get();
  if (unsettled) {
    refuse(
      "worker_environments",
      "prepared-worker facts or remote lifecycle effects need their owner's settlement",
    );
  }
  // Drop the CHECK-bearing column first, then its dependencies. This is the
  // inverse of the v17 owner's additive DDL, only for rows with no new facts.
  for (const column of present) {
    target.exec(`ALTER TABLE worker_environments DROP COLUMN ${column}`);
  }
}

function assertMigrationShapes(
  expected: DatabaseSync,
  target: DatabaseSync,
  tables: string[],
): void {
  const readExpected = createSqliteTableContractReader(expected);
  const readTarget = createSqliteTableContractReader(target);
  for (const table of tables) {
    const before = readExpected(table);
    const current = readTarget(table);
    if (!before && !current) {
      continue;
    }
    if (!before?.definition || !current?.definition) {
      refuse(table, "missing or unrecognized migration table");
    }
    const expectedColumns = new Map(before.definition.columns);
    for (const [name, definition] of current.definition.columns) {
      if (!expectedColumns.has(name)) {
        if (!/^[a-z_][a-z0-9_]* (?:ANY|BLOB|INT|INTEGER|REAL|TEXT)$/iu.test(definition)) {
          refuse(table, `unknown constrained column ${name}`);
        }
        expectedColumns.set(name, definition);
      }
    }
    if (
      !isDeepStrictEqual(current, {
        ...before,
        definition: { ...before.definition, columns: expectedColumns },
      })
    ) {
      refuse(table, "schema differs from the real migration owner's after-image");
    }
  }
}

/** Prepare one private C copy, never a live DB. B/C remain immutable on every
 * failure. The publication owner must still run the selected older CLI's exact
 * preflight over the result; version numbers alone do not admit publication. */
export async function prepareOpenClawStateRecoveryCopy(params: {
  baselinePath: string;
  candidatePath: string;
  targetPath: string;
  assertOwned: () => void;
}): Promise<void> {
  params.assertOwned();
  await fs.copyFile(params.candidatePath, params.targetPath, fs.constants.COPYFILE_EXCL);
  params.assertOwned();
  const baseline = openNodeSqliteDatabase(resolveImmutableSqliteFileUri(params.baselinePath), {
    readOnly: true,
  });
  const target = openNodeSqliteDatabase(params.targetPath);
  const expectedPath = `${params.targetPath}.migration-after-image`;
  let expected: DatabaseSync | undefined;
  try {
    const older = readStateSchemaContentVersion(baseline);
    const newer = readStateSchemaContentVersion(target);
    if (
      readSqliteUserVersion(baseline) !== older ||
      ![15, 16, 17].includes(older) ||
      newer < older ||
      newer > 17
    ) {
      refuse("schema_meta", `unsupported content transition ${newer} -> ${older}`);
    }
    if (newer === older) {
      return;
    }
    const baselineTables = new Set(
      rows(baseline, "SELECT name FROM sqlite_schema WHERE type='table'").map((row) =>
        text(row, "name"),
      ),
    );
    for (const row of rows(
      target,
      "SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%'",
    )) {
      const name = text(row, "name");
      if (
        !baselineTables.has(name) &&
        rows(target, `SELECT 1 FROM ${quoteSqliteIdentifier(name)} LIMIT 1`).length
      ) {
        refuse(name, "new table contains records whose older interpretation is unknown");
      }
    }
    await fs.copyFile(params.baselinePath, expectedPath, fs.constants.COPYFILE_EXCL);
    params.assertOwned();
    expected = openNodeSqliteDatabase(expectedPath);
    expected.exec("PRAGMA foreign_keys=OFF; BEGIN IMMEDIATE");
    for (const migration of versionedStateMigrations) {
      if (migration.version > older && migration.version <= newer) {
        migration.migrate(expected, older);
      }
    }
    expected.exec("COMMIT");
    assertMigrationShapes(
      expected,
      target,
      [...baselineTables].filter((name) => !name.startsWith("sqlite_")),
    );
    target.exec("PRAGMA foreign_keys=OFF; BEGIN IMMEDIATE");
    try {
      if (older < 17 && newer >= 17) {
        prepareWorkers(baseline, target);
      }
      if (older === 15 && newer >= 16) {
        prepareWorkshop(baseline, target);
      }
      const metadata = baseline.prepare("SELECT * FROM schema_meta WHERE meta_key='primary'").get();
      if (!metadata || metadata.role !== "global" || metadata.agent_id !== null) {
        refuse("schema_meta", "baseline is not the selected shared-store identity");
      }
      target
        .prepare("UPDATE schema_meta SET schema_version=?, app_version=? WHERE meta_key='primary'")
        .run(value(metadata, "schema_version"), value(metadata, "app_version"));
      const content = baseline
        .prepare("SELECT value_json FROM config_machine_state WHERE state_key=?")
        .get(CONTENT_VERSION_KEY);
      if (content) {
        target
          .prepare("UPDATE config_machine_state SET value_json=? WHERE state_key=?")
          .run(value(content, "value_json"), CONTENT_VERSION_KEY);
      } else {
        target
          .prepare("DELETE FROM config_machine_state WHERE state_key=?")
          .run(CONTENT_VERSION_KEY);
      }
      target.exec(`PRAGMA user_version=${older}`);
      assertSqliteIntegrity(target, params.targetPath);
      params.assertOwned();
      target.exec("COMMIT");
    } catch (error) {
      target.exec("ROLLBACK");
      throw error;
    }
  } finally {
    target.close();
    baseline.close();
    expected?.close();
    if (expected) {
      await fs.rm(expectedPath);
    }
  }
}
