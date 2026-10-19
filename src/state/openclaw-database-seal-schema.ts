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

export function sqliteDatabaseSealSchemaFor(kind: "agent" | "state" | "other") {
  requireNodeSqlite();
  const native = captureSqliteNativeRuntimeAdmission();
  const storageIdentity = native?.storageIdentity;
  if (!native || !storageIdentity) {
    return undefined;
  }
  const hash = createHash("sha256").update(
    JSON.stringify([integrityPolicyRevision, storageIdentity, kind]),
  );
  const schema = createHash("sha256").update(kind);
  if (kind !== "state") {
    hash.update(String(OPENCLAW_AGENT_SCHEMA_VERSION));
    hash.update(OPENCLAW_AGENT_SCHEMA_SQL);
    schema.update(String(OPENCLAW_AGENT_SCHEMA_VERSION));
    schema.update(OPENCLAW_AGENT_SCHEMA_SQL);
  }
  if (kind !== "agent") {
    hash.update(String(OPENCLAW_STATE_SCHEMA_VERSION));
    hash.update(OPENCLAW_STATE_SCHEMA_SQL);
    schema.update(String(OPENCLAW_STATE_SCHEMA_VERSION));
    schema.update(OPENCLAW_STATE_SCHEMA_SQL);
  }
  return {
    schemaIdentity: hash.digest("hex"),
    identity: {
      runtime: JSON.stringify([native.runtime.nodeVersion, native.runtime.bunVersion ?? null]),
      sqlite: createHash("sha256").update(storageIdentity).digest("hex"),
      schema: schema.digest("hex"),
      policy: integrityPolicyRevision,
    },
  };
}
