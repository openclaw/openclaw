import { expect } from "vitest";
import { captureThrown } from "../../test/helpers/capture-thrown.js";
import { captureFreshDoctorMigrationTables } from "../commands/doctor-migration-backup.js";
import { CLIENT_CREDENTIAL_LEGACY_TABLES_SQL } from "../infra/client-credential-schema.js";
import { acquireGatewayStateOwner } from "../infra/gateway-state-owner.js";
import type { EngineConnection } from "../infra/sql-connection.js";
import {
  findSqlCharacter,
  findSqlClosingParenthesis,
  normalizeSqlIdentifier,
  quoteSqliteIdentifier,
  readSqlToken,
  splitSqlList,
} from "../infra/sqlite-schema-sql.js";
import { runWithDoctorMigrationBackup } from "../infra/update-doctor-migration-attribution.js";
import { createOpenClawDatabaseMaintenanceScope } from "./openclaw-state-db-async-lifecycle.js";
import type { OpenClawStateDatabaseOptions } from "./openclaw-state-db-contract.js";
import { FIRST_USE_STATE_TABLES } from "./openclaw-state-db-contract.js";
import { OpenClawStateDatabaseSchemaMigrationRequiredError } from "./openclaw-state-db-schema-migration-required.js";
import { TEMPLATE_STATE_TABLE_RENAMES } from "./openclaw-state-db-schema-v36-template-names.js";
import { repairOpenClawStateDatabaseSchema } from "./openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "./openclaw-state-db.paths.js";
import { createSqliteSchemaShapeFromSql } from "./sqlite-schema-shape.test-support.js";

/** Restore predecessor contracts without filling missing columns or changing unrelated row data. */
export function restorePreTemplateStateIdentifiersForTest(database: EngineConnection): void {
  for (const [previous, current] of TEMPLATE_STATE_TABLE_RENAMES) {
    if (!database.prepare("SELECT 1 FROM sqlite_schema WHERE name = ?").get(current)) {
      continue;
    }
    database.exec(
      `ALTER TABLE ${quoteSqliteIdentifier(current)} RENAME TO ${quoteSqliteIdentifier(previous)};`,
    );
    const columns: readonly (readonly [string, string])[] =
      current === "template_installs"
        ? [
            ["template_name", "claw_name"],
            ["template_version", "claw_version"],
          ]
        : current === "template_package_refs"
          ? [["template_name", "claw_name"]]
          : [];
    for (const [column, oldColumn] of columns) {
      database.exec(
        `ALTER TABLE ${quoteSqliteIdentifier(previous)} RENAME COLUMN ${quoteSqliteIdentifier(column)} TO ${quoteSqliteIdentifier(oldColumn)};`,
      );
    }
  }
  // ALTER quotes renamed columns and leaves successor CHECKs intact. Those are
  // not admitted predecessor definitions and would select full Doctor repair.
  for (const table of [
    ...TEMPLATE_STATE_TABLE_RENAMES.map(([previous]) => previous),
    "agent_provenance",
  ]) {
    const definition = database
      .prepare("SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = ?")
      .get(table)?.sql;
    if (typeof definition !== "string") {
      continue;
    }
    const rewrite: readonly [string, string, string] | undefined =
      table === "claw_package_refs" || table === "claw_mcp_server_refs"
        ? ["origin", "template-introduced", "claw-introduced"]
        : table === "agent_provenance"
          ? ["created_via", "template", "claw"]
          : undefined;
    const renamedColumns =
      table === "claw_installs"
        ? ["claw_name", "claw_version"]
        : table === "claw_package_refs"
          ? ["claw_name"]
          : [];
    const open = findSqlCharacter(definition, "(");
    const close = findSqlClosingParenthesis(definition, open);
    let changed = false;
    const definitions = splitSqlList(definition.slice(open + 1, close)).map((part) => {
      const token = readSqlToken(part, 0);
      if (!token) {
        return part;
      }
      const name = normalizeSqlIdentifier(token.raw);
      let restored = part;
      if (renamedColumns.includes(name) && token.raw !== name) {
        restored = part.slice(0, part.indexOf(token.raw)) + name + part.slice(token.end);
      }
      if (rewrite && name === rewrite[0]) {
        restored = restored.replaceAll(`'${rewrite[1]}'`, `'${rewrite[2]}'`);
      }
      changed ||= restored !== part;
      return restored;
    });
    if (!changed) {
      continue;
    }
    const declaration = `(${definitions.join(",")}${definition.slice(close)}`;
    const objects = database
      .prepare(
        "SELECT sql FROM sqlite_schema WHERE tbl_name = ? AND type IN ('index', 'trigger') AND sql IS NOT NULL",
      )
      .all(table);
    const names = database
      .prepare("SELECT name FROM pragma_table_xinfo(?) WHERE hidden = 0")
      .all(table)
      .map(({ name }) => {
        if (typeof name !== "string") {
          throw new Error("Predecessor fixture column name must be text");
        }
        return name;
      });
    const rowid = /\bWITHOUT\s+ROWID\b/iu.test(definition) ? [] : ["rowid"];
    const projection = [
      ...rowid.map(quoteSqliteIdentifier),
      ...names.map((name) =>
        rewrite && name === rewrite[0]
          ? `CASE ${quoteSqliteIdentifier(name)} WHEN '${rewrite[1]}' THEN '${rewrite[2]}' ELSE ${quoteSqliteIdentifier(name)} END`
          : quoteSqliteIdentifier(name),
      ),
    ];
    const temporary = quoteSqliteIdentifier(`${table}_fixture_pre_template`);
    database.exec(`CREATE TABLE ${temporary} ${declaration};
      INSERT INTO ${temporary} (${[...rowid, ...names].map(quoteSqliteIdentifier).join(", ")})
        SELECT ${projection.join(", ")} FROM ${quoteSqliteIdentifier(table)};
      DROP TABLE ${quoteSqliteIdentifier(table)};
      ALTER TABLE ${temporary} RENAME TO ${quoteSqliteIdentifier(table)};`);
    for (const object of objects) {
      if (typeof object.sql === "string") {
        database.exec(object.sql);
      }
    }
  }
}

/** Add credential tables only; explicit historical constructors own schema downgrades. */
export function addPreCutoverClientCredentialTablesForTest(database: EngineConnection): void {
  database.exec(CLIENT_CREDENTIAL_LEGACY_TABLES_SQL);
}

/** Historical schema success paths retain the real owner and Doctor's fresh table backup. */
export async function withStateMigrationBackupForTest<T>(
  options: OpenClawStateDatabaseOptions,
  operation: () => T,
): Promise<Awaited<T>> {
  const pathname = options.path ?? resolveOpenClawStateSqlitePath(options.env);
  const lease = acquireGatewayStateOwner({ databasePath: pathname });
  const resources = createOpenClawDatabaseMaintenanceScope({
    schemaMaintenance: true,
    assertOwnerCurrent: lease.assertCurrent,
    assertDatabaseAccess: lease.assertDatabaseAccess,
  });
  try {
    // Retain asynchronous work in the resource scope until process custody is released.
    return await resources.run(() =>
      runWithDoctorMigrationBackup(captureFreshDoctorMigrationTables, operation),
    );
  } finally {
    await resources.close();
    lease.release();
  }
}

export function createInitialStateSchemaShape(
  deletionJournal: "present" | "unavailable" = "present",
) {
  const shape = createSqliteSchemaShapeFromSql(
    new URL("./openclaw-state-schema.sql", import.meta.url),
  );
  for (const tableName of FIRST_USE_STATE_TABLES) {
    delete shape[tableName];
  }
  if (deletionJournal === "unavailable") {
    delete shape.agent_deletion_journal;
  }
  return shape;
}

export async function expectStateSchemaRepair(
  options: NonNullable<Parameters<typeof repairOpenClawStateDatabaseSchema>[0]>,
  changes: unknown[],
  warnings: unknown[] = [],
) {
  expect(
    await withStateMigrationBackupForTest(options, () =>
      repairOpenClawStateDatabaseSchema(options),
    ),
  ).toEqual({ changes, warnings });
}

export function captureStateDatabaseFailure(run: () => unknown) {
  return captureThrown(run, "Expected operation to fail");
}

export function expectStateSchemaMigrationRequired(
  run: () => unknown,
  expected: {
    kind: OpenClawStateDatabaseSchemaMigrationRequiredError["kind"];
    pathname: string;
  },
): void {
  const caught = captureStateDatabaseFailure(run);
  expect(caught).toBeInstanceOf(OpenClawStateDatabaseSchemaMigrationRequiredError);
  expect(caught).toMatchObject(expected);
}
