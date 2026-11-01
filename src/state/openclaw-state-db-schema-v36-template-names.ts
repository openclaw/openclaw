import type { DatabaseSync } from "node:sqlite";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import { captureSqliteSchemaFacts } from "../infra/sqlite-schema-admission.js";
import { parseSqliteTableDefinition } from "../infra/sqlite-schema-contract-assembly.js";
import type { SqliteSchemaCompatibility } from "../infra/sqlite-schema-contract.js";
import { quoteSqliteIdentifier as quote } from "../infra/sqlite-schema-sql.js";
import {
  CLAW_STARTUP_ADDITIVE_STATE_COLUMN_DEFINITIONS,
  ORDERED_STARTUP_ADDITIVE_STATE_COLUMNS,
} from "./openclaw-state-db-additive-columns.js";
import type { DB } from "./openclaw-state-db.generated.js";

export const TEMPLATE_STATE_TABLE_RENAMES = [
  ["claw_installs", "template_installs"],
  ["claw_workspace_files", "template_workspace_files"],
  ["claw_package_refs", "template_package_refs"],
  ["claw_cron_refs", "template_cron_refs"],
  ["claw_mcp_server_refs", "template_mcp_server_refs"],
] as const;
const columns = [
  ["template_installs", "claw_name", "template_name"],
  ["template_installs", "claw_version", "template_version"],
  ["template_package_refs", "claw_name", "template_name"],
] as const;
const targetTables = new Set<string>(TEMPLATE_STATE_TABLE_RENAMES.map(([, name]) => name));
const additiveColumns = CLAW_STARTUP_ADDITIVE_STATE_COLUMN_DEFINITIONS.filter(({ tableName }) =>
  targetTables.has(tableName),
);
const orderedColumns = [
  ...ORDERED_STARTUP_ADDITIVE_STATE_COLUMNS.packageUpdatedAt,
  ...ORDERED_STARTUP_ADDITIVE_STATE_COLUMNS.packageIntegrity,
];
type VersionedTemplateTable = keyof Pick<
  DB,
  | "template_installs"
  | "template_workspace_files"
  | "template_package_refs"
  | "template_cron_refs"
  | "template_mcp_server_refs"
>;
const recordVersions: readonly (readonly [
  VersionedTemplateTable,
  readonly (readonly [string, string])[],
])[] = [
  [
    "template_installs",
    [1, 2, 3].map((version): [string, string] => [
      `openclaw.clawInstallRecord.v${version}`,
      `openclaw.templateInstallRecord.v${version}`,
    ]),
  ],
  [
    "template_workspace_files",
    [["openclaw.clawWorkspaceFileRecord.v1", "openclaw.templateWorkspaceFileRecord.v1"]],
  ],
  ["template_package_refs", [["openclaw.clawPackageRef.v1", "openclaw.templatePackageRef.v1"]]],
  ["template_cron_refs", [["openclaw.clawCronRef.v1", "openclaw.templateCronRef.v1"]]],
  [
    "template_mcp_server_refs",
    [["openclaw.clawMcpServerRef.v1", "openclaw.templateMcpServerRef.v1"]],
  ],
];
const literal = (value: string) => `'${value.replaceAll("'", "''")}'`;

/** Historical schema/backup metadata only; runtime readers use canonical names. */
export function legacyTemplateStateIdentifier(value: string): string {
  for (const [oldName, newName] of [
    ...TEMPLATE_STATE_TABLE_RENAMES,
    ...columns.map(([, previousColumn, currentColumn]) => [previousColumn, currentColumn] as const),
  ]) {
    if (value === newName) {
      return oldName;
    }
  }
  return value;
}

/** Exact predecessor DDL, not a live alias or a data-string rewrite. */
export function withLegacyTemplateStateSchema(schema: string): string {
  return schema
    .replace(
      /\btemplate_(?:installs|workspace_files|package_refs|cron_refs|mcp_server_refs|name|version)\b/gu,
      legacyTemplateStateIdentifier,
    )
    .replaceAll("'template-introduced'", "'claw-introduced'")
    .replaceAll("'template'", "'claw'");
}

export function withLegacyTemplateStateCompatibility(
  compatibility: SqliteSchemaCompatibility,
): SqliteSchemaCompatibility {
  return {
    ...compatibility,
    excludedTables: compatibility.excludedTables?.map(withLegacyTemplateStateSchema),
    allowedMissingTables: compatibility.allowedMissingTables?.map(withLegacyTemplateStateSchema),
    allowedMissingColumns: compatibility.allowedMissingColumns?.map(withLegacyTemplateStateSchema),
    allowedColumnDefinitions:
      compatibility.allowedColumnDefinitions &&
      Object.fromEntries(
        Object.entries(compatibility.allowedColumnDefinitions).map(([name, definitions]) => [
          withLegacyTemplateStateSchema(name),
          definitions.map(withLegacyTemplateStateSchema),
        ]),
      ),
  };
}

function versionUpdates(table: string, versions: readonly (readonly [string, string])[]): string {
  return `UPDATE ${quote(table)} SET schema_version = CASE schema_version
    ${versions.map(([oldValue, newValue]) => `WHEN ${literal(oldValue)} THEN ${literal(newValue)}`).join("\n")}
    ELSE schema_version END WHERE schema_version IN (${versions.map(([oldValue]) => literal(oldValue)).join(", ")});`;
}

/** The existing schema owner has disabled foreign keys before BEGIN. */
function migrateTemplateStateNames(db: DatabaseSync, previousVersion: number): boolean {
  if (previousVersion >= 36) {
    return false;
  }
  // Admitted facts describe the predecessor until this owner publishes. Plan
  // from one physical snapshot instead of consulting those facts after ALTER.
  const before = captureSqliteSchemaFacts(db);
  const tables = new Set(before.tables);
  const scopedTables = new Set<string>([
    ...TEMPLATE_STATE_TABLE_RENAMES.flat(),
    "agent_provenance",
  ]);
  const tableColumns = new Map(
    [...before.tableSql].flatMap(([table, sql]) =>
      sql && scopedTables.has(table)
        ? [[table, new Set(parseSqliteTableDefinition(sql, table).columns.keys())] as const]
        : [],
    ),
  );
  const addColumn = (table: string, declaration: string) => {
    const name = declaration.trim().split(/\s+/, 1)[0];
    const known = tableColumns.get(table);
    if (!name || !known || known.has(name)) {
      return false;
    }
    // sqlite-allow-raw -- Versioned schema owner adds a captured predecessor column.
    db.exec(`ALTER TABLE ${quote(table)} ADD COLUMN ${declaration};`);
    known.add(name);
    return true;
  };
  let changed = false;
  for (const [oldName, newName] of TEMPLATE_STATE_TABLE_RENAMES) {
    if (tables.has(oldName)) {
      if (tables.has(newName)) {
        throw new Error(
          `Both ${oldName} and ${newName} exist; preserve the store for Doctor inspection.`,
        );
      }
      // sqlite-allow-raw -- Physical table renames belong to this schema transaction.
      db.exec(`ALTER TABLE ${quote(oldName)} RENAME TO ${quote(newName)};`);
      tables.delete(oldName);
      tables.add(newName);
      const knownColumns = tableColumns.get(oldName);
      if (!knownColumns) {
        throw new Error(`Missing predecessor column contract for ${oldName}`);
      }
      tableColumns.set(newName, knownColumns);
      tableColumns.delete(oldName);
      changed = true;
    }
  }
  for (const [table, oldName, newName] of columns) {
    if (tableColumns.get(table)?.has(oldName)) {
      // sqlite-allow-raw -- Physical column renames belong to this schema transaction.
      db.exec(`ALTER TABLE ${quote(table)} RENAME COLUMN ${quote(oldName)} TO ${quote(newName)};`);
      tableColumns.get(table)?.delete(oldName);
      tableColumns.get(table)?.add(newName);
      changed = true;
    }
  }
  // Older supported stores may still lack released additive provenance columns.
  for (const { tableName, columnName, dataType } of additiveColumns) {
    addColumn(tableName, `${columnName} ${dataType}`);
  }
  const kysely = getNodeSqliteKysely<DB>(db);
  if (addColumn(...ORDERED_STARTUP_ADDITIVE_STATE_COLUMNS.packageUpdatedAt[0])) {
    executeSqliteQuerySync(
      db,
      kysely.updateTable("template_package_refs").set((eb) => ({
        updated_at_ms: eb.ref("installed_at_ms"),
      })),
    );
  }
  for (const [table, definition] of ORDERED_STARTUP_ADDITIVE_STATE_COLUMNS.packageIntegrity) {
    addColumn(table, definition);
  }
  // Capture once after SQLite has rewritten table/column references in local objects.
  const schema = captureSqliteSchemaFacts(db);
  const values: Readonly<Record<string, readonly [string, string, string]>> = {
    template_package_refs: ["origin", "claw-introduced", "template-introduced"],
    template_mcp_server_refs: ["origin", "claw-introduced", "template-introduced"],
    agent_provenance: ["created_via", "claw", "template"],
  };
  for (const table of ["template_installs", ...Object.keys(values)]) {
    const create = schema.tableSql.get(table);
    if (!create) {
      continue;
    }
    const original = create.slice(create.indexOf("("));
    let declaration = original;
    // ALTER COLUMN quotes the renamed identifier. Rebuild its declaration in
    // canonical spelling without relaxing the schema comparator for all stores.
    for (const [owner, , newName] of columns) {
      if (owner === table) {
        declaration = declaration.replaceAll(quote(newName), newName);
      }
    }
    const rewrite = values[table];
    if (rewrite) {
      declaration = declaration.replaceAll(literal(rewrite[1]), literal(rewrite[2]));
    }
    if (declaration === original) {
      continue;
    }
    const temporary = quote(`${table}_migration_v36`);
    const names = [...parseSqliteTableDefinition(create, table).columns.keys()];
    const rowid = /\bWITHOUT\s+ROWID\b/iu.test(create) ? [] : ["rowid"];
    const target = [...rowid, ...names].map(quote).join(", ");
    const projection = [
      ...rowid.map(quote),
      ...names.map((name) =>
        rewrite && name === rewrite[0]
          ? `CASE ${quote(name)} WHEN ${literal(rewrite[1])} THEN ${literal(rewrite[2])} ELSE ${quote(name)} END`
          : quote(name),
      ),
    ].join(", ");
    // sqlite-allow-raw -- Rebuild captured DDL and copy its dynamic columns/rowids atomically.
    db.exec(`CREATE TABLE ${temporary} ${declaration};
      INSERT INTO ${temporary} (${target}) SELECT ${projection} FROM ${quote(table)};
      DROP TABLE ${quote(table)};
      ALTER TABLE ${temporary} RENAME TO ${quote(table)};`);
    for (const object of [...schema.indexDefinitions.values(), ...schema.triggers.values()]) {
      if (object.table === table && typeof object.sql === "string") {
        // sqlite-allow-raw -- Restore the rebuilt table's captured local indexes and triggers.
        db.exec(object.sql);
      }
    }
    changed = true;
  }
  for (const [table, versions] of recordVersions) {
    if (tables.has(table)) {
      for (const [previous, current] of versions) {
        executeSqliteQuerySync(
          db,
          kysely
            .updateTable(table)
            .set({ schema_version: current })
            .where("schema_version", "=", previous),
        );
      }
    }
  }
  return changed;
}

export const stateTemplateNamesMigration = {
  version: 36,
  tables: [
    ...TEMPLATE_STATE_TABLE_RENAMES.flat(),
    "agent_provenance",
    "sqlite_stat1",
    "sqlite_stat4",
  ],
  columns: [
    ...additiveColumns.map(({ tableName, columnName }) => `${tableName}.${columnName}`),
    ...orderedColumns.map(([table, definition]) => `${table}.${definition.split(" ", 1)[0]}`),
  ],
  migrate: migrateTemplateStateNames,
  applied: "Migrated released starter tables and provenance to canonical Template names (v36)",
};

// PostgreSQL retains table/constraint identity through ALTER; the owner verifies
// the exact predecessor and successor catalogs and publishes both version seals.
export const TEMPLATE_STATE_POSTGRES_MIGRATION_SQL = `DO $template_names_v36$
DECLARE item record; column_item record; constraint_name text; next_constraint_name text;
BEGIN
  FOR item IN SELECT * FROM (VALUES
    ${TEMPLATE_STATE_TABLE_RENAMES.map(([oldName, newName]) => `(${literal(oldName)}, ${literal(newName)})`).join(",\n")}
  ) AS names(old_name, new_name) LOOP
    EXECUTE format('ALTER TABLE %I RENAME TO %I', item.old_name, item.new_name);
    FOR column_item IN SELECT * FROM (VALUES
      ${columns.map(([table, oldName, newName]) => `(${literal(table)}, ${literal(oldName)}, ${literal(newName)})`).join(",\n")}
    ) AS columns(table_name, old_name, new_name) WHERE table_name = item.new_name LOOP
      EXECUTE format('ALTER TABLE %I RENAME COLUMN %I TO %I', item.new_name, column_item.old_name, column_item.new_name);
    END LOOP;
    FOR constraint_name IN SELECT conname FROM pg_constraint
      WHERE conrelid = to_regclass(item.new_name) LOOP
      next_constraint_name := constraint_name;
      IF left(constraint_name, length(item.old_name) + 1) = item.old_name || '_' THEN
        next_constraint_name := item.new_name || substr(constraint_name, length(item.old_name) + 1);
      END IF;
      next_constraint_name := replace(replace(next_constraint_name, '_claw_name_', '_template_name_'), '_claw_version_', '_template_version_');
      IF next_constraint_name <> constraint_name THEN
        EXECUTE format('ALTER TABLE %I RENAME CONSTRAINT %I TO %I', item.new_name, constraint_name, next_constraint_name);
      END IF;
    END LOOP;
  END LOOP;
  ${["template_package_refs", "template_mcp_server_refs"]
    .map(
      (table) => `
    ALTER TABLE ${quote(table)} DROP CONSTRAINT ${quote(`${table}_origin_check`)};
    UPDATE ${quote(table)} SET origin = 'template-introduced' WHERE origin = 'claw-introduced';
    ALTER TABLE ${quote(table)} ADD CONSTRAINT ${quote(`${table}_origin_check`)}
      CHECK (origin IN ('template-introduced', 'pre-existing'));`,
    )
    .join("\n")}
  IF to_regclass('agent_provenance') IS NOT NULL THEN
    ALTER TABLE agent_provenance DROP CONSTRAINT agent_provenance_created_via_check;
    UPDATE agent_provenance SET created_via = 'template' WHERE created_via = 'claw';
    ALTER TABLE agent_provenance ADD CONSTRAINT agent_provenance_created_via_check
      CHECK (created_via IN ('operator', 'agent', 'template'));
  END IF;
  ${recordVersions.map(([table, versions]) => versionUpdates(table, versions)).join("\n")}
END $template_names_v36$;`;
