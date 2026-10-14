import { isPostgresSqlConnection } from "../sql-connection.js";
import type { DatabaseEngineInput } from "./config.js";
import type { EngineConnection } from "./contract.js";
import { bindSqliteFullText } from "./sqlite-full-text.js";
import { bindSqliteVectorCapability } from "./sqlite-vector.js";
import type { FullTextCapability, TextIndex, TextIndexDefinition } from "./text-contract.js";
import type { VectorCapability, VectorIndex } from "./vector-contract.js";

const POSTGRES_SEARCH_UNAVAILABLE =
  "PostgreSQL search capabilities are unavailable until P3-5b; use SQLite search or wait for PostgreSQL search admission.";

/** @experimental Existing admitted native handle or admitted worker-store descriptor. */
export type SearchStore = EngineConnection | { databasePath: string; input?: DatabaseEngineInput };
/** @experimental Feature-owned declarations of the existing derived indexes. */
export type SearchSchema = {
  text?: Record<string, TextIndexDefinition>;
  vector?: Record<string, Omit<VectorIndex, "store">>;
};
/** @experimental Null means unavailable; diagnostics name the required next step. */
export type StoreSearchCapabilities = {
  fullText: FullTextCapability | null;
  vector: VectorCapability | null;
  text: Record<string, TextIndex>;
  vectors: Record<string, VectorIndex>;
  diagnostics: readonly string[];
};

/** @experimental Bind once alongside the owner's admission, using its declared indexes. */
export function bindStoreSearch(store: SearchStore, schema: SearchSchema): StoreSearchCapabilities {
  const postgres = "databasePath" in store ? Boolean(store.input) : isPostgresSqlConnection(store);
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
    diagnostics: postgres ? [POSTGRES_SEARCH_UNAVAILABLE] : [],
  };
}
