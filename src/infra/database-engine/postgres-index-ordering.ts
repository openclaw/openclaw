// Generated index DDL quotes identifiers and parenthesizes every key expression.
const generatedIndexes =
  /CREATE (?:UNIQUE )?INDEX ("(?:[^"]|"")+") ON ("(?:[^"]|"")+") (?:'(?:[^']|'')*'|"(?:[^"]|"")*"|[^;'"])*;/g;
const orderedKeys = /'(?:[^']|'')*'|"(?:[^"]|"")*"|\) (ASC|DESC)(?=,|\))/g;

/** Retain the physical index definitions admitted before nullability-aware ordering. */
export function withLegacyPostgresIndexOrdering(sql: string): string {
  return sql.replace(generatedIndexes, (index) =>
    index.replace(orderedKeys, (key: string, order: string | undefined) =>
      order ? `${key} NULLS ${order === "DESC" ? "LAST" : "FIRST"}` : key,
    ),
  );
}

/** The schema owner runs this under its existing versioned admission transaction. */
export function postgresIndexOrderingMigration(sql: string): string {
  return [...sql.matchAll(generatedIndexes)]
    .filter(([index]) => withLegacyPostgresIndexOrdering(index) !== index)
    .map(
      ([index, name, table]) => `DO $index_order$
BEGIN
  IF to_regclass('${table!.replaceAll("'", "''")}') IS NOT NULL THEN
    DROP INDEX ${name};
    ${index}
  END IF;
END $index_order$;`,
    )
    .join("\n");
}
