import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { SqliteDatabaseAdmissionKey } from "../infra/sqlite-database-admission.js";
import type { SqliteSchemaFacts } from "../infra/sqlite-schema-facts.js";
import { readOpenClawAgentDatabaseIdentity } from "./openclaw-agent-db-identity.js";

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

export function readTransferredAgentSchema(
  value: unknown,
): OpenClawAgentDatabaseValidation["schema"] {
  if (!isRecord(value) || !isRecord(value.facts)) {
    return undefined;
  }
  const { facts, valid } = value;
  if (
    !(valid instanceof SharedArrayBuffer) ||
    valid.byteLength !== Int32Array.BYTES_PER_ELEMENT ||
    typeof facts.admissionId !== "string" ||
    typeof facts.revision !== "number" ||
    typeof facts.userVersion !== "number" ||
    typeof facts.schemaVersion !== "number" ||
    !(facts.tables instanceof Set) ||
    ![...facts.tables].every((table) => typeof table === "string") ||
    !(facts.views instanceof Set) ||
    ![...facts.views].every((view) => typeof view === "string") ||
    !(facts.tableSql instanceof Map) ||
    ![...facts.tableSql].every(
      ([name, sql]) => typeof name === "string" && (sql === null || typeof sql === "string"),
    ) ||
    !(facts.indexes instanceof Set) ||
    ![...facts.indexes].every((index) => typeof index === "string") ||
    !(facts.indexDefinitions instanceof Map) ||
    ![...facts.indexDefinitions].every(
      ([name, index]) =>
        typeof name === "string" &&
        isRecord(index) &&
        typeof index.table === "string" &&
        (index.sql === null || typeof index.sql === "string"),
    ) ||
    !(facts.triggers instanceof Map) ||
    ![...facts.triggers].every(
      ([name, trigger]) =>
        typeof name === "string" &&
        isRecord(trigger) &&
        typeof trigger.table === "string" &&
        (trigger.sql === null || typeof trigger.sql === "string"),
    )
  ) {
    return undefined;
  }
  return {
    valid,
    facts: {
      admissionId: facts.admissionId,
      revision: facts.revision,
      userVersion: facts.userVersion,
      schemaVersion: facts.schemaVersion,
      tables: facts.tables,
      views: facts.views,
      tableSql: facts.tableSql,
      indexes: facts.indexes,
      indexDefinitions: facts.indexDefinitions,
      triggers: facts.triggers,
    },
  };
}

export const agentDatabaseValidationKey: SqliteDatabaseAdmissionKey<OpenClawAgentDatabaseValidation> =
  {
    name: "agent.completed-validation",
    read(value) {
      if (
        !isRecord(value) ||
        typeof value.agentId !== "string" ||
        typeof value.identity !== "string" ||
        typeof value.birthtime !== "string" ||
        typeof value.receiptId !== "string" ||
        !(value.valid instanceof SharedArrayBuffer) ||
        value.valid.byteLength !== Int32Array.BYTES_PER_ELEMENT ||
        !(value.canonicalReady instanceof SharedArrayBuffer) ||
        value.canonicalReady.byteLength !== Int32Array.BYTES_PER_ELEMENT
      ) {
        return undefined;
      }
      return {
        agentId: value.agentId,
        identity: value.identity,
        birthtime: value.birthtime,
        receiptId: value.receiptId,
        valid: value.valid,
        canonicalReady: value.canonicalReady,
        schema: readTransferredAgentSchema(value.schema),
      };
    },
  };

export function createOpenClawAgentDatabaseValidationReceipt(
  database: { db: DatabaseSync; agentId: string },
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
    valid: new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT),
    canonicalReady: new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT),
  };
  if (canonicalReady) {
    Atomics.store(new Int32Array(validation.canonicalReady), 0, 1);
  }
  Atomics.store(new Int32Array(validation.valid), 0, 1);
  return validation;
}
