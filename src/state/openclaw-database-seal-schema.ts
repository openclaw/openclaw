import { createHash } from "node:crypto";
import { VERSION } from "../version.js";
import { OPENCLAW_AGENT_SCHEMA_VERSION } from "./openclaw-agent-db-contract.js";
import { OPENCLAW_AGENT_SCHEMA_SQL } from "./openclaw-agent-schema.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "./openclaw-state-db-contract.js";
import { OPENCLAW_STATE_SCHEMA_SQL } from "./openclaw-state-schema.js";

// Advance the policy revision for code-only validation or serialized admission-fact changes.
// Builds with the same version and schema can reuse proof; commit IDs cannot describe that contract.
export const SQLITE_DATABASE_SEAL_SCHEMA = createHash("sha256")
  .update(
    JSON.stringify([1, VERSION, OPENCLAW_AGENT_SCHEMA_VERSION, OPENCLAW_STATE_SCHEMA_VERSION]),
  )
  .update(OPENCLAW_AGENT_SCHEMA_SQL)
  .update(OPENCLAW_STATE_SCHEMA_SQL)
  .digest("hex");
