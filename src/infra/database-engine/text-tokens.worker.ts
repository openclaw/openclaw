import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../kysely-sync.js";
import { openNodeSqliteDatabase } from "../node-sqlite.js";
import { isPostgresSqlConnection, type EngineConnection } from "../sql-connection.js";
import { bindSqliteFullText } from "./sqlite-full-text.js";
import { buildSqliteMemoryBodyFtsSchema } from "./sqlite-memory-search-fragments.js";

/** Probe native word parsers; current Unicode regexes disagree with unicode61 on newer symbols. */
export function hasFullTextWordTokens(database: EngineConnection, text: string): boolean {
  if (isPostgresSqlConnection(database)) {
    const result = executeSqliteQueryTakeFirstSync(
      database,
      getNodeSqliteKysely(database).selectNoFrom((eb) =>
        eb
          .fn<number>("numnode", [
            eb.fn("plainto_tsquery", [eb.val("pg_catalog.simple"), eb.val(text)]),
          ])
          .as("count"),
      ),
    );
    return (result?.count ?? 0) > 0;
  }
  // One bounded query row, never transcript history or the read-only store's schema.
  using probe = openNodeSqliteDatabase(":memory:");
  // Reuse the native unicode61 schema owner; diacritic folding does not change token presence.
  probe.exec(buildSqliteMemoryBodyFtsSchema({ tableName: "tokens", tokenizer: "unicode61" }));
  const db = getNodeSqliteKysely<{ tokens: { text: string } }>(probe);
  executeSqliteQuerySync(probe, db.insertInto("tokens").values({ text }));
  return (
    executeSqliteQueryTakeFirstSync(
      probe,
      db
        .selectFrom("tokens")
        .select("text")
        .where(
          bindSqliteFullText(probe, probe).match(
            { store: probe, table: "tokens", fields: ["text"] },
            { kind: "phrase", text },
          ),
        ),
    ) !== undefined
  );
}
