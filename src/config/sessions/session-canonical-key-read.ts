import { executeSqliteQueryTakeFirstSync, getNodeSqliteKysely } from "../../infra/kysely-sync.js";
import { normalizeMainKey } from "../../routing/session-key.js";
import {
  OPENCLAW_AGENT_SCHEMA_VERSION,
  type OpenClawAgentDatabaseOptions,
} from "../../state/openclaw-agent-db-contract.js";
import { withOpenClawAgentDatabaseReadOnly } from "../../state/openclaw-agent-db-readonly.js";
import type { DB as OpenClawAgentKyselyDatabase } from "../../state/openclaw-agent-db.generated.js";

type CanonicalSessionDatabase = Pick<
  OpenClawAgentKyselyDatabase,
  "schema_meta" | "session_key_contract"
>;

/** Checks the startup contract without joining the writable database lifecycle. */
export function isCanonicalSqliteSessionMainKeyCurrent(
  options: OpenClawAgentDatabaseOptions,
  mainKey: string | undefined,
): boolean {
  const canonicalMainKey = normalizeMainKey(mainKey);
  const result = withOpenClawAgentDatabaseReadOnly((database) => {
    const db = getNodeSqliteKysely<CanonicalSessionDatabase>(database.db);
    const schema = executeSqliteQueryTakeFirstSync(
      database.db,
      db.selectFrom("schema_meta").select("schema_version").where("meta_key", "=", "primary"),
    );
    if (schema?.schema_version !== OPENCLAW_AGENT_SCHEMA_VERSION) {
      return false;
    }
    return (
      executeSqliteQueryTakeFirstSync(
        database.db,
        db.selectFrom("session_key_contract").select("main_key").where("id", "=", 1),
      )?.main_key === canonicalMainKey
    );
  }, options);
  return result.found && result.value;
}
