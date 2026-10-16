import { isPostgresSqlConnection, type EngineConnection } from "../sql-connection.js";
import { bindPostgresSearch } from "./postgres-search.js";
import { bindSqliteFullText } from "./sqlite-full-text.js";
import { bindSqliteVectorCapability } from "./sqlite-vector.js";
import type { FullTextCapability, TextIndex, TextIndexDefinition } from "./text-contract.js";
import type { DatabaseEngineInput } from "./types.js";
import type { VectorCapability, VectorIndex } from "./vector-contract.js";

/** @experimental Existing admitted native handle or admitted worker-store descriptor. */
export type SearchStore = EngineConnection | { databasePath: string; input?: DatabaseEngineInput };
/** @experimental Feature-owned declarations of the existing derived indexes. */
export type SearchSchema = {
  text?: Record<string, TextIndexDefinition>;
  vector?: Record<string, Omit<VectorIndex, "store">>;
  /** Selected by the memory owner only for the explicit provider: "none" setting. */
  mode?: "keyword-only";
  /** Schema where the operator installed the required PostgreSQL extensions. */
  extensionSchema?: string;
};
/** @experimental Null means unavailable; diagnostics name the required next step. */
export type StoreSearchCapabilities = {
  fullText: FullTextCapability | null;
  vector: VectorCapability | null;
  text: Record<string, TextIndex>;
  vectors: Record<string, VectorIndex>;
  diagnostics: readonly string[];
  /** Rebuild derived PostgreSQL search state inside the owning writer transaction. */
  rebuild?: () => void;
};

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
