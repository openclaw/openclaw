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
  /** Index into AGENT_VALIDATION_REVOKERS, written before `valid` clears, so a borrower names it. */
  revokedBy: SharedArrayBuffer;
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
    lifetime: "process",
    read(value) {
      if (!isRecord(value)) {
        return undefined;
      }
      // SAFETY: Only the admitted agent schema owner publishes this private fact key.
      const validation = value as OpenClawAgentDatabaseValidation;
      // A receipt sealed by an older release at clean close has no revoker cell; give the
      // restored record one so revocation and refusal reports work after upgrade.
      validation.revokedBy ??= new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
      return validation;
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

/** Every owner that can revoke a receipt; a refused borrower reports which one did. */
const AGENT_VALIDATION_REVOKERS = [
  "not revoked",
  "a lease release without a confirmed close",
  "a failed close",
  "agent database disposal",
  "a maintenance write",
  "a refused open",
  "registration without an admitted connection",
  "agent database unregistration",
  "a failed schema refresh",
  "a successor receipt",
  "agent removal",
  "a validation cache reset",
  "a reopen that must converge",
  "a failed open",
  "an open that retained its database",
  "execution cleanup",
  "execution retirement",
  "a missing database file",
  "a database file identity change",
  "connection replacement",
  "a refused admission handoff",
  "a superseded alias",
] as const;
export type AgentValidationRevoker = Exclude<
  (typeof AGENT_VALIDATION_REVOKERS)[number],
  "not revoked"
>;

export function revokeAgentDatabaseValidation(
  validation: Pick<OpenClawAgentDatabaseValidation, "valid" | "revokedBy">,
  revoker: AgentValidationRevoker,
): void {
  // The first revoker owns the report; later revocations of a dead receipt change nothing.
  if (Atomics.load(new Int32Array(validation.valid), 0) === 1) {
    Atomics.store(
      new Int32Array(validation.revokedBy),
      0,
      AGENT_VALIDATION_REVOKERS.indexOf(revoker),
    );
  }
  Atomics.store(new Int32Array(validation.valid), 0, 0);
}

/** Why a borrowed receipt no longer matches the connection a reader opened. */
export function describeAgentDatabaseValidationMismatch(
  database: { db: EngineConnection; agentId: string },
  validation: Pick<
    OpenClawAgentDatabaseValidation,
    "agentId" | "identity" | "birthtime" | "valid" | "revokedBy"
  >,
): string {
  if (Atomics.load(new Int32Array(validation.valid), 0) !== 1) {
    const index = Atomics.load(new Int32Array(validation.revokedBy), 0);
    return `the receipt was revoked by ${index > 0 ? AGENT_VALIDATION_REVOKERS[index] : "an unknown owner"}`;
  }
  if (validation.agentId !== database.agentId) {
    return `the receipt belongs to agent ${validation.agentId}, not ${database.agentId}`;
  }
  const identity = findOpenClawAgentDatabaseIdentity(database);
  return `the open file is ${identity?.identity ?? "unidentified"}/${identity?.birthtime ?? "?"}, the receipt names ${validation.identity}/${validation.birthtime}`;
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
    revokedBy: new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT),
    canonicalReady: new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT),
  };
  if (canonicalReady) {
    Atomics.store(new Int32Array(validation.canonicalReady), 0, 1);
  }
  Atomics.store(new Int32Array(validation.valid), 0, 1);
  return validation;
}
