import { createHash } from "node:crypto";
import { VERSION } from "../version.js";
import { OPENCLAW_AGENT_SCHEMA_SQL } from "./openclaw-agent-schema.js";
import { OPENCLAW_STATE_SCHEMA_SQL } from "./openclaw-state-schema.js";

// Advance the policy revision for code-only migrations, schema-version, validation, or fact changes.
// Builds with the same version and schema can reuse proof; commit IDs cannot describe that contract.
export function sqliteDatabaseSealSchemaFor(
  kind: "agent" | "state" | "other",
  version = VERSION,
): string {
  const hash = createHash("sha256").update(JSON.stringify([2, version, kind]));
  if (kind !== "state") {
    hash.update(OPENCLAW_AGENT_SCHEMA_SQL);
  }
  if (kind !== "agent") {
    hash.update(OPENCLAW_STATE_SCHEMA_SQL);
  }
  return hash.digest("hex");
}
