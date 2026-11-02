import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../kysely-sync.js";
import { openNodeSqliteDatabase } from "../node-sqlite.js";
import { isPostgresSqlConnection, type EngineConnection } from "../sql-connection.js";
import { bindSqliteFullText } from "./sqlite-full-text.js";

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
  probe.exec(
    /* sqlite-allow-raw: A private one-row FTS5 probe delegates tokenization to the same native unicode61 implementation. */
    "CREATE VIRTUAL TABLE tokens USING fts5(text, tokenize='unicode61 remove_diacritics 2')",
  );
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
