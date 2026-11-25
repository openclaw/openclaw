import { requireNodeSqlite } from "./node-sqlite.js";
import { hasUnquotedSqlKeyword, quoteSqliteIdentifier, readSqlToken } from "./sqlite-schema-sql.js";

const SQLITE_STRICT_DATATYPES: Record<string, true> = {
  ANY: true,
  BLOB: true,
  INT: true,
  INTEGER: true,
  REAL: true,
  TEXT: true,
};

export function isCompatibleAdditiveColumnDefinition(definition: string): boolean {
  const name = readSqlToken(definition, 0);
  const type = name ? readSqlToken(definition, name.end) : null;
  if (!type?.keyword || SQLITE_STRICT_DATATYPES[type.keyword] !== true) {
    return false;
  }
  if (definition.slice(type.end).trim().length === 0) {
    return true;
  }
  if (hasUnquotedSqlKeyword(definition, /\b(?:UNIQUE|REFERENCES|GENERATED|PRIMARY)\b/giu)) {
    return false;
  }
  // Evaluate only this column in an isolated engine: checks must accept both an
  // old writer's omitted value and an explicit NULL, without consulting other rows.
  const { DatabaseSync, constants } = requireNodeSqlite();
  using probe = new DatabaseSync(":memory:");
  const deterministic = new Set<string>();
  for (const entry of probe.prepare("PRAGMA function_list").all()) {
    if (entry.builtin && typeof entry.flags === "number" && (entry.flags & 0x800) !== 0) {
      deterministic.add(String(entry.name));
    }
  }
  probe.setAuthorizer((action, _first, second) =>
    action === constants.SQLITE_FUNCTION && !deterministic.has(second ?? "")
      ? constants.SQLITE_DENY
      : constants.SQLITE_OK,
  );
  try {
    probe.prepare(`CREATE TABLE additive_probe (${definition}) STRICT`).run();
    const column = probe.prepare("PRAGMA table_xinfo(additive_probe)").get();
    if (
      !column ||
      column.notnull !== 0 ||
      column.pk !== 0 ||
      column.hidden !== 0 ||
      (column.dflt_value !== null && !/^\(*\s*NULL\s*\)*$/iu.test(String(column.dflt_value)))
    ) {
      return false;
    }
    probe
      .prepare(
        `INSERT INTO additive_probe (${quoteSqliteIdentifier(String(column.name))}) VALUES (NULL)`,
      )
      .run();
    probe.prepare("INSERT INTO additive_probe DEFAULT VALUES").run();
    return true;
  } catch {
    return false;
  }
}
