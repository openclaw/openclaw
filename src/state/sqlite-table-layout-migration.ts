import type { DatabaseSync } from "node:sqlite";
import { captureSqliteSchemaFacts } from "../infra/sqlite-schema-admission.js";
import { getAdmittedSqliteSchemaFacts } from "../infra/sqlite-schema-facts.js";
import {
  findSqlCharacter,
  findSqlClosingParenthesis,
  quoteSqliteIdentifier,
} from "../infra/sqlite-schema-sql.js";
import { readTableColumns } from "./openclaw-state-db-schema-helpers.js";

/** The schema owner holds the migration transaction with foreign keys disabled. */
export function migrateSqliteTableWithoutRowid(db: DatabaseSync, table: string): boolean {
  const schema = getAdmittedSqliteSchemaFacts(db) ?? captureSqliteSchemaFacts(db);
  const create = schema.tableSql.get(table);
  // Lazy tables may still be absent, or already created with the current layout.
  if (!create) {
    return false;
  }
  const open = findSqlCharacter(create, "(");
  const close = findSqlClosingParenthesis(create, open);
  const options = create
    .slice(close + 1)
    .replace(/;\s*$/u, "")
    .trim();
  if (/\bWITHOUT\s+ROWID\b/iu.test(options)) {
    return false;
  }
  const name = quoteSqliteIdentifier(table);
  const temporary = quoteSqliteIdentifier(`${table}_without_rowid_migration`);
  const columns = [...readTableColumns(db, table)].map(quoteSqliteIdentifier).join(", ");
  // Retain the admitted constraints and compatible local columns, indexes, and triggers.
  db.exec(`CREATE TABLE ${temporary} ${create.slice(open, close + 1)}
      ${options ? `${options}, ` : ""}WITHOUT ROWID;
    INSERT INTO ${temporary} (${columns}) SELECT ${columns} FROM ${name};
    DROP TABLE ${name};
    ALTER TABLE ${temporary} RENAME TO ${name};`);
  for (const object of [...schema.indexDefinitions.values(), ...schema.triggers.values()]) {
    if (object.table === table && typeof object.sql === "string") {
      // sqlite-allow-raw -- Replay the table's own captured index/trigger definitions.
      db.exec(object.sql);
    }
  }
  return true;
}
