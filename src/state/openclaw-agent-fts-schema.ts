import { getSqliteMemorySearchFtsSchemas } from "../infra/database-engine/sqlite-memory-search-fragments.js";
import { OPENCLAW_AGENT_SCHEMA_SQL } from "./openclaw-agent-schema.js";

/** Static agent DDL and the memory owner's lazily installed FTS definitions. */
export const AGENT_FTS_SCHEMAS = [OPENCLAW_AGENT_SCHEMA_SQL, ...getSqliteMemorySearchFtsSchemas()];
