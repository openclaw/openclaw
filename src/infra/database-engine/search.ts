import { isPostgresSqlConnection } from "../sql-connection.js";
import type { SearchSchema, SearchStore, StoreSearchCapabilities } from "./contract.js";
import { bindPostgresSearch } from "./postgres-search.js";
import { bindSqliteFullText } from "./sqlite-full-text.js";
import { bindSqliteVectorCapability } from "./sqlite-vector.js";
export type { SearchSchema, SearchStore, StoreSearchCapabilities } from "./contract.js";

/** @experimental Bind once alongside the owner's admission, using its declared indexes. */
export function bindStoreSearch(store: SearchStore, schema: SearchSchema): StoreSearchCapabilities {
  const postgres = "databasePath" in store ? Boolean(store.input) : isPostgresSqlConnection(store);
  if (postgres) {
    if ("databasePath" in store || !isPostgresSqlConnection(store)) {
      throw new Error("PostgreSQL search requires the admitted worker connection");
    }
    return bindPostgresSearch(store, schema);
  }
  const sqlite = "databasePath" in store || isPostgresSqlConnection(store) ? undefined : store;
  const databasePath = "databasePath" in store ? store.databasePath : (sqlite?.location() ?? "");
  const token = {};
  const bindIndexes = <Definition>(definitions: Record<string, Definition> = {}) =>
    Object.fromEntries(
      Object.entries(definitions).map(([name, definition]) => [
        name,
        { ...definition, store: token },
      ]),
    );
  return {
    fullText: postgres ? null : bindSqliteFullText(token, sqlite),
    vector: postgres ? null : bindSqliteVectorCapability({ store: token, databasePath }, sqlite),
    text: bindIndexes(schema.text),
    vectors: bindIndexes(schema.vector),
    diagnostics: [],
  };
}
