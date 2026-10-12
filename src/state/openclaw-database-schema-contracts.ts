import { getCanonicalSqliteTableNames } from "../infra/sqlite-schema-contract.js";
import { OPENCLAW_AGENT_SCHEMA_SQL } from "./openclaw-agent-schema.js";
import { OPENCLAW_STATE_SCHEMA_SQL } from "./openclaw-state-schema.js";

/** Prepare pure comparison contracts before runtime workers inherit the host's cache. */
export function prepareOpenClawDatabaseSchemaContracts(): void {
  getCanonicalSqliteTableNames(OPENCLAW_STATE_SCHEMA_SQL);
  getCanonicalSqliteTableNames(OPENCLAW_AGENT_SCHEMA_SQL);
}
