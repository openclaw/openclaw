import { createHash } from "node:crypto";
import { VERSION } from "../version.js";
import { OPENCLAW_AGENT_SCHEMA_SQL } from "./openclaw-agent-schema.js";
import { OPENCLAW_STATE_SCHEMA_SQL } from "./openclaw-state-schema.js";

// Advance the policy revision for code-only migrations, schema-version, validation, or fact changes.
// Builds with the same version and schema can reuse proof; commit IDs cannot describe that contract.
export function sqliteDatabaseSealSchemaFor(version = VERSION): string {
  return createHash("sha256")
    .update(JSON.stringify([2, version]))
    .update(OPENCLAW_AGENT_SCHEMA_SQL)
    .update(OPENCLAW_STATE_SCHEMA_SQL)
    .digest("hex");
}
