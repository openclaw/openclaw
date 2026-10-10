import { getAdmittedSqliteSchemaFacts } from "../../infra/sqlite-schema-facts.js";
import { normalizeMainKey } from "../../routing/session-key.js";
import {
  OPENCLAW_AGENT_SCHEMA_VERSION,
  type OpenClawAgentDatabaseOptions,
} from "../../state/openclaw-agent-db-contract.js";
import { withOpenClawAgentDatabaseReadOnly } from "../../state/openclaw-agent-db-readonly.js";
import { readStoredCanonicalSessionMainKey } from "./session-canonical-key.js";

/** Checks the startup contract without joining the writable database lifecycle. */
export function isCanonicalSqliteSessionMainKeyCurrent(
  options: OpenClawAgentDatabaseOptions,
  mainKey: string | undefined,
): boolean {
  const canonicalMainKey = normalizeMainKey(mainKey);
  const result = withOpenClawAgentDatabaseReadOnly((database) => {
    if (getAdmittedSqliteSchemaFacts(database.db)?.userVersion !== OPENCLAW_AGENT_SCHEMA_VERSION) {
      return false;
    }
    return readStoredCanonicalSessionMainKey(database) === canonicalMainKey;
  }, options);
  return result.found && result.value;
}
