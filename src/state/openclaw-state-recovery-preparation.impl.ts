import type { BigIntStats } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type { DatabaseSync, SQLOutputValue } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import { formatErrorMessage } from "../infra/errors.js";
import { openNodeSqliteDatabase, resolveImmutableSqliteFileUri } from "../infra/node-sqlite.js";
import { assertSqliteIntegrity } from "../infra/sqlite-integrity.js";
import { createSqliteTableContractReader } from "../infra/sqlite-schema-contract.js";
import { quoteSqliteIdentifier } from "../infra/sqlite-schema-sql.js";
import { readSqliteUserVersion } from "../infra/sqlite-user-version.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "./openclaw-state-db-contract.js";
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
  const query = database.prepare(sql); // sqlite-allow-raw -- Private recovery schema/metadata inspection; never application writes.
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

async function copyRecoveryGenerationExclusive(
  source: string,
  target: string,
): Promise<BigIntStats> {
  const stagingDirectory = await fs.mkdtemp(
    path.join(path.dirname(target), `.${path.basename(target)}.copy-`),
  );
  const staged = path.join(stagingDirectory, "generation.sqlite");
  let failed = false;
  let failure: unknown;
  let linked = false;
  let identity: BigIntStats | undefined;
  try {
    await fs.copyFile(source, staged, fs.constants.COPYFILE_EXCL);
    await fs.link(staged, target);
    linked = true;
    identity = await fs.lstat(target, { bigint: true });
  } catch (cause) {
    failed = true;
    failure = cause;
  }
  try {
    await fs.rm(stagingDirectory, { recursive: true });
  } catch (cleanupError) {
    // A linked destination belongs to this attempt. Remove it if staging
    // cleanup prevents the operation from completing as one owned unit.
    if (linked) {
      try {
        await fs.rm(target, { force: true });
      } catch (targetCleanupError) {
        throw new Error(
          `Recovery copy cleanup failed for both its staging directory and linked destination: ${target}; staging error: ${formatErrorMessage(cleanupError)}`,
          { cause: targetCleanupError },
        );
      }
    }
    throw new Error(
      `Recovery copy ${failed ? `failed (${formatErrorMessage(failure)}) and ` : ""}could not remove its staging directory: ${stagingDirectory}`,
      { cause: cleanupError },
    );
  }
  if (failed) {
    throw failure;
  }
  if (!identity?.isFile()) {
    throw new Error(`Recovery copy target is not a regular file: ${target}`);
  }
  return identity;
}

function sameTargetOwner(expected: BigIntStats, current: BigIntStats | undefined): boolean {
  return Boolean(
    current?.isFile() &&
    expected.dev !== 0n &&
    expected.ino !== 0n &&
    current.dev === expected.dev &&
    current.ino === expected.ino,
  );
}

async function removeTargetIfOwned(pathname: string, expected: BigIntStats): Promise<boolean> {
  const current = await fs.lstat(pathname, { bigint: true }).catch(() => undefined);
  if (!sameTargetOwner(expected, current)) {
    return false;
  }
  await fs.unlink(pathname);
  return true;
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
    // Reintroduced migration fields are candidate-owned facts, not permission
    // to overwrite them with B's older attribution. Even nullable columns can
    // contain acknowledged writes; refuse before rebuilding the affected table.
    const candidateColumns = new Set(
      columns(target, table).map((column) => text(column, "name").toLowerCase()),
    );
    const restoredColumns =
      table === proposals ? ["workspace_dir", "claim_released_time"] : ["workspace_dir"];
    for (const column of restoredColumns) {
      if (tableHasColumn(baseline, table, column) && candidateColumns.has(column)) {
        refuse(table, `candidate column ${column} collides with a restored migration field`);
      }
    }
    // SQLite column names are case-insensitive. Neither a declared rowid nor
    // an extra field may shadow the physical row identity retained below.
    for (const column of ["rowid", "__recovery_rowid__"]) {
      if (candidateColumns.has(column)) {
        refuse(table, `candidate column ${column} collides with the retained row identity`);
      }
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

function assertSameVersionRecoveryShape(
  baseline: DatabaseSync,
  target: DatabaseSync,
  version: number,
): void {
  const schema =
    "SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE sql IS NOT NULL ORDER BY type,name";
  if (
    version > OPENCLAW_STATE_SCHEMA_VERSION ||
    readSqliteUserVersion(baseline) !== version ||
    readSqliteUserVersion(target) !== version ||
    !isDeepStrictEqual(rows(baseline, schema), rows(target, schema))
  ) {
    refuse("schema_meta", `schema${version} changed without a supported inverse migration`);
  }
}

function assertSharedStoreIdentity(
  database: DatabaseSync,
  publishedVersion: number,
  generation: "baseline" | "candidate",
): void {
  const identity = database // sqlite-allow-raw -- Validate the private copy's canonical shared-store identity row.
    .prepare("SELECT role,agent_id,schema_version FROM schema_meta WHERE meta_key='primary'")
    .get();
  if (
    identity?.role !== "global" ||
    identity.agent_id !== null ||
    identity.schema_version !== publishedVersion
  ) {
    refuse(
      "schema_meta",
      `${generation} identity does not match published schema ${publishedVersion}`,
    );
  }
}

/** Prepare one private C copy, never a live DB. B/C remain immutable on every
 * failure. The publication owner must still run the selected older CLI's exact
 * preflight over the result; version numbers alone do not admit publication. */
export async function prepareOpenClawStateRecoveryCopyInProcess(params: {
  baselinePath: string;
  candidatePath: string;
  targetPath: string;
  assertOwned: () => void;
}): Promise<{ dev: string; ino: string; size: string; mtimeNs: string; birthtimeNs: string }> {
  params.assertOwned();
  const targetIdentity = await copyRecoveryGenerationExclusive(
    params.candidatePath,
    params.targetPath,
  );
  const expectedPath = `${params.targetPath}.migration-after-image`;
  let baseline: DatabaseSync | undefined;
  let target: DatabaseSync | undefined;
  let expected: DatabaseSync | undefined;
  let expectedCreated = false;
  let completed = false;
  let operationFailed = false;
  let operationFailure: unknown;
  let cleanupFailed = false;
  let cleanupFailure: unknown;
  const recordCleanupFailure = (label: string, cause: unknown) => {
    cleanupFailure = new Error(
      `${label}: ${formatErrorMessage(cause)}${cleanupFailed ? `; earlier cleanup failure: ${formatErrorMessage(cleanupFailure)}` : ""}`,
      { cause },
    );
    cleanupFailed = true;
  };
  try {
    await (async () => {
      params.assertOwned();
      baseline = openNodeSqliteDatabase(resolveImmutableSqliteFileUri(params.baselinePath), {
        readOnly: true,
      });
      target = openNodeSqliteDatabase(params.targetPath);
      const baselinePublished = readSqliteUserVersion(baseline);
      const candidatePublished = readSqliteUserVersion(target);
      assertSharedStoreIdentity(baseline, baselinePublished, "baseline");
      assertSharedStoreIdentity(target, candidatePublished, "candidate");
      const older = readStateSchemaContentVersion(baseline);
      const newer = readStateSchemaContentVersion(target);
      if (older === newer) {
        assertSameVersionRecoveryShape(baseline, target, older);
        params.assertOwned();
        completed = true;
        return;
      }
      if (older >= 18 || newer >= 18 || baselinePublished >= 18 || candidatePublished >= 18) {
        refuse(
          "schema_meta",
          `permission-bearing schema transition ${newer} -> ${older} requires its owner's recovery contract`,
        );
      }
      if (
        readSqliteUserVersion(baseline) !== older ||
        ![15, 16, 17].includes(older) ||
        newer < older ||
        newer > 17
      ) {
        refuse("schema_meta", `unsupported content transition ${newer} -> ${older}`);
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
      await copyRecoveryGenerationExclusive(params.baselinePath, expectedPath);
      expectedCreated = true;
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
        const metadata = baseline
          .prepare("SELECT * FROM schema_meta WHERE meta_key='primary'")
          .get();
        if (!metadata || metadata.role !== "global" || metadata.agent_id !== null) {
          refuse("schema_meta", "baseline is not the selected shared-store identity");
        }
        target
          .prepare(
            "UPDATE schema_meta SET schema_version=?, app_version=? WHERE meta_key='primary'",
          )
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
        completed = true;
      } catch (error) {
        target.exec("ROLLBACK");
        throw error;
      }
    })();
  } catch (cause) {
    operationFailed = true;
    operationFailure = cause;
  } finally {
    try {
      expected?.close();
    } catch (cause) {
      recordCleanupFailure("Recovery migration after-image close failed", cause);
    }
    try {
      target?.close();
    } catch (cause) {
      recordCleanupFailure("Prepared recovery database close failed", cause);
    }
    try {
      baseline?.close();
    } catch (cause) {
      recordCleanupFailure("Recovery baseline database close failed", cause);
    }
    if (expectedCreated) {
      try {
        await fs.rm(expectedPath);
      } catch (cause) {
        recordCleanupFailure("Recovery migration after-image cleanup failed", cause);
      }
    }
    if (!completed || cleanupFailed) {
      try {
        await removeTargetIfOwned(params.targetPath, targetIdentity);
      } catch (cause) {
        recordCleanupFailure("Incomplete prepared recovery cleanup failed", cause);
      }
    }
  }
  if (cleanupFailed) {
    throw new Error(
      `Recovery preparation finalization failed: ${formatErrorMessage(cleanupFailure)}${operationFailed ? `; preparation also failed: ${formatErrorMessage(operationFailure)}` : ""}`,
      { cause: cleanupFailure },
    );
  }
  if (operationFailed) {
    throw operationFailure;
  }
  const current = await fs.lstat(params.targetPath, { bigint: true }).catch(() => undefined);
  if (!sameTargetOwner(targetIdentity, current)) {
    throw new Error("Prepared recovery target changed before completion.");
  }
  return {
    dev: String(current!.dev),
    ino: String(current!.ino),
    size: String(current!.size),
    mtimeNs: String(current!.mtimeNs),
    birthtimeNs: String(current!.birthtimeNs),
  };
}
