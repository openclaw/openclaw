import { preparePostgresBridge } from "../postgres-sync/bridge-prestart.js";
import { peekSqliteDatabaseAdmissionForPath } from "../sqlite-database-admission.js";
import { postgresPhysicalFactsKey } from "./physical-facts-contract.js";
import { listDatabaseEngineStores } from "./registry.js";
import type { DatabaseEngineSelection } from "./types.js";

/** Overlap module loading only when the owner already supplied this store's identity. */
export function prepareAdmittedPostgresBridge(
  location: string,
  selection: DatabaseEngineSelection | undefined,
  options?: { reuse?: boolean; signal?: AbortSignal },
) {
  if (!selection?.postgres) {
    return undefined;
  }
  const facts = peekSqliteDatabaseAdmissionForPath(location, postgresPhysicalFactsKey);
  if (!facts) {
    return undefined;
  }
  const family = listDatabaseEngineStores().find(
    ({ id }) => id.replaceAll("-", "_") === facts.store,
  );
  if (!family || selection.effectiveEngines[family.id] !== "postgres") {
    return undefined;
  }
  return preparePostgresBridge(
    {
      url: selection.postgres.connection,
      schema: facts.namespace,
      storeId: facts.storeId,
      reuse: options?.reuse,
    },
    options?.signal,
  );
}
