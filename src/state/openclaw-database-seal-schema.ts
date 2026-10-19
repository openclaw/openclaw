import { createHash } from "node:crypto";
import {
  captureSqliteNativeRuntimeAdmission,
  requireNodeSqlite,
} from "../infra/sqlite-native-runtime.js";
import { OPENCLAW_AGENT_SCHEMA_SQL } from "./openclaw-agent-schema.js";
import {
  OPENCLAW_AGENT_SCHEMA_VERSION,
  OPENCLAW_STATE_SCHEMA_VERSION,
} from "./openclaw-schema-versions.js";
import { OPENCLAW_STATE_SCHEMA_SQL } from "./openclaw-state-schema.js";

// Advance for code-only migrations, validation rules, or serialized fact changes.
const integrityPolicyRevision = 3;

export function sqliteDatabaseSealSchemaFor(kind: "agent" | "state" | "other"): string | undefined {
  requireNodeSqlite();
  const storageIdentity = captureSqliteNativeRuntimeAdmission()?.storageIdentity;
  if (!storageIdentity) {
    return undefined;
  }
  const hash = createHash("sha256").update(
    JSON.stringify([integrityPolicyRevision, storageIdentity, kind]),
  );
  if (kind !== "state") {
    hash.update(String(OPENCLAW_AGENT_SCHEMA_VERSION));
    hash.update(OPENCLAW_AGENT_SCHEMA_SQL);
  }
  if (kind !== "agent") {
    hash.update(String(OPENCLAW_STATE_SCHEMA_VERSION));
    hash.update(OPENCLAW_STATE_SCHEMA_SQL);
  }
  return hash.digest("hex");
}
