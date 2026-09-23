import type { DatabaseSync } from "node:sqlite";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../infra/kysely-sync.js";
import { deferSqlitePostCommitPublication } from "../infra/sqlite-post-commit.js";
import { assertCanonicalSessionValidationSchema } from "./openclaw-agent-canonical-validation-schema.js";
import { CANONICAL_READY_COLUMN_DEFINITION } from "./openclaw-agent-db-additive-columns.js";
import {
  findOpenClawAgentDatabaseIdentity,
  isOpenClawAgentDatabasePathCurrent,
} from "./openclaw-agent-db-identity.js";
import type { DB } from "./openclaw-agent-db.generated.js";
import { ensureColumn, tableHasColumn } from "./openclaw-state-db-schema-helpers.js";

type ReceiptDatabase = { db: DatabaseSync; agentId: string };
const receiptSchemas = new WeakSet<DatabaseSync>();

function hasReceiptColumn(db: DatabaseSync): boolean {
  if (receiptSchemas.has(db)) {
    return true;
  }
  const { tableName, columnName } = CANONICAL_READY_COLUMN_DEFINITION;
  const present = tableHasColumn(db, tableName, columnName);
  if (present && !db.isTransaction) {
    receiptSchemas.add(db);
  }
  return present;
}

function physicalReceipt(database: ReceiptDatabase): string | undefined {
  const physical = findOpenClawAgentDatabaseIdentity(database);
  if (
    !physical ||
    typeof physical.identity !== "string" ||
    !isOpenClawAgentDatabasePathCurrent({ ...database, path: physical.filename })
  ) {
    return undefined;
  }
  // Advance the receipt revision when canonical validation rules change.
  return JSON.stringify([1, database.agentId, physical.identity, physical.birthtime]);
}

/** Canonical proof follows this file generation; it never certifies physical integrity. */
export function hasPersistedOpenClawAgentCanonicalValidation(database: ReceiptDatabase): boolean {
  const receipt = physicalReceipt(database);
  if (!receipt || !hasReceiptColumn(database.db)) {
    return false;
  }
  assertCanonicalSessionValidationSchema(database.db);
  return (
    executeSqliteQueryTakeFirstSync(
      database.db,
      getNodeSqliteKysely<Pick<DB, "session_key_contract">>(database.db)
        .selectFrom("session_key_contract")
        .select("canonical_ready")
        .where("id", "=", 1),
    )?.canonical_ready === receipt
  );
}

/** The certifying writer records proof in the same authorized transaction as its final batch. */
export function recordOpenClawAgentCanonicalValidation(database: ReceiptDatabase): void {
  if (!database.db.isTransaction) {
    throw new Error("Canonical validation receipt requires write admission");
  }
  const receipt = physicalReceipt(database);
  if (!receipt) {
    throw new Error("Canonical validation database owner is no longer current");
  }
  assertCanonicalSessionValidationSchema(database.db);
  if (!hasReceiptColumn(database.db)) {
    const { tableName, columnName, dataType } = CANONICAL_READY_COLUMN_DEFINITION;
    ensureColumn(database.db, tableName, `${columnName} ${dataType}`);
  }
  // A rolled-back first use must retry the DDL on its next admission.
  deferSqlitePostCommitPublication(database.db, () => receiptSchemas.add(database.db));
  executeSqliteQuerySync(
    database.db,
    getNodeSqliteKysely<Pick<DB, "session_key_contract">>(database.db)
      .updateTable("session_key_contract")
      .set({ canonical_ready: receipt })
      .where("id", "=", 1),
  );
}
