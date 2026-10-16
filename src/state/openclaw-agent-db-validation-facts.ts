import { randomUUID } from "node:crypto";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { PostgresPhysicalFacts } from "../infra/database-engine/physical-facts.js";
import type { EngineConnection } from "../infra/sql-connection.js";
import { isPostgresSqlConnection } from "../infra/sql-connection.js";
import {
  readSqliteDatabaseIntegrityVerification,
  type SqliteDatabaseAdmissionKey,
} from "../infra/sqlite-database-admission.js";
import type { SqliteSchemaFacts } from "../infra/sqlite-schema-facts.js";
import {
  findOpenClawAgentDatabaseIdentity,
  readOpenClawAgentDatabaseIdentity,
} from "./openclaw-agent-db-identity.js";

export type OpenClawAgentDatabaseValidation = {
  agentId: string;
  identity: string;
  birthtime: string;
  /** Shared-buffer wrappers change across worker transfers; this identifies the proof instance. */
  receiptId: string;
  /** Preserve the full-check age when a worker borrows proof after host eviction. */
  integrityVerifiedAt?: number;
  /** Shared with admitted workers so owner invalidation revokes borrowed proof. */
  valid: SharedArrayBuffer;
  /** First full canonical proof; subsequent changes remain visible through the pending table. */
  canonicalReady: SharedArrayBuffer;
  /** Canonical admission, separately revoked by local DDL without discarding integrity proof. */
  schema?: (
    | { facts: SqliteSchemaFacts; postgres?: never }
    | { facts?: never; postgres: PostgresPhysicalFacts }
  ) & { valid: SharedArrayBuffer };
};

export const agentDatabaseValidationKey: SqliteDatabaseAdmissionKey<OpenClawAgentDatabaseValidation> =
  {
    name: "agent.completed-validation",
    read(value) {
      // SAFETY: Only the admitted agent schema owner publishes this private fact key.
      return isRecord(value) ? (value as OpenClawAgentDatabaseValidation) : undefined;
    },
  };

export function matchesAgentDatabaseValidation(
  database: { db: EngineConnection; agentId: string },
  validation: OpenClawAgentDatabaseValidation,
): boolean {
  const identity = findOpenClawAgentDatabaseIdentity(database);
  return (
    validation.agentId === database.agentId &&
    validation.identity === identity?.identity &&
    validation.birthtime === identity?.birthtime &&
    Atomics.load(new Int32Array(validation.valid), 0) === 1
  );
}

export function createOpenClawAgentDatabaseValidationReceipt(
  database: { db: EngineConnection; agentId: string },
  canonicalReady: boolean,
): OpenClawAgentDatabaseValidation {
  const { identity, birthtime } = readOpenClawAgentDatabaseIdentity(database);
  if (typeof identity !== "string" || birthtime === undefined) {
    throw new Error("Only persistent agent databases retain integrity validation");
  }
  const validation = {
    agentId: database.agentId,
    identity,
    birthtime,
    receiptId: randomUUID(),
    integrityVerifiedAt: isPostgresSqlConnection(database.db)
      ? undefined
      : readSqliteDatabaseIntegrityVerification(database.db)?.verifiedAt,
    valid: new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT),
    canonicalReady: new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT),
  };
  if (canonicalReady) {
    Atomics.store(new Int32Array(validation.canonicalReady), 0, 1);
  }
  Atomics.store(new Int32Array(validation.valid), 0, 1);
  return validation;
}
