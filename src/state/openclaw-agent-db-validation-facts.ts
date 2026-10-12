import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { SqliteDatabaseAdmissionKey } from "../infra/sqlite-database-admission.js";
import type { SqliteSchemaFacts } from "../infra/sqlite-schema-facts.js";

export type OpenClawAgentDatabaseValidation = {
  agentId: string;
  identity: string;
  birthtime: string;
  /** Shared-buffer wrappers change across worker transfers; this identifies the proof instance. */
  receiptId: string;
  /** Shared with admitted workers so owner invalidation revokes borrowed proof. */
  valid: SharedArrayBuffer;
  /** First full canonical proof; subsequent changes remain visible through the pending table. */
  canonicalReady: SharedArrayBuffer;
  /** Canonical admission, separately revoked by local DDL without discarding integrity proof. */
  schema?: { facts: SqliteSchemaFacts; valid: SharedArrayBuffer };
};

export const agentDatabaseValidationKey: SqliteDatabaseAdmissionKey<OpenClawAgentDatabaseValidation> =
  {
    name: "agent.completed-validation",
    read(value) {
      // SAFETY: Only the admitted agent schema owner publishes this private fact key.
      return isRecord(value) ? (value as OpenClawAgentDatabaseValidation) : undefined;
    },
  };
