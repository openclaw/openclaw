// Gateway boot admission only; runtime mutations use the approval worker.
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import type { OpenClawStateDatabaseOptions } from "../state/openclaw-state-db-contract.js";
import { runOpenClawStateWriteTransaction } from "../state/openclaw-state-db.js";
import { operatorApprovalTerminalFields } from "./operator-approval-store.fields.js";
import { operatorApprovalPublication } from "./operator-approval-store.publication.js";
import {
  OPERATOR_APPROVAL_TERMINAL_RETENTION_MS,
  requireString,
  clampAuditTimestamp,
  decodeOperatorApprovalRow,
} from "./operator-approval-store.rows.js";
import type {
  OperatorApprovalDatabase,
  OperatorApprovalRecord,
  OperatorApprovalRow,
  TerminalizeOperatorApprovalsResult,
} from "./operator-approval-store.types.js";

export function closeOrphanedOperatorApprovals(params: {
  runtimeEpoch: string;
  nowMs?: number;
  databaseOptions?: OpenClawStateDatabaseOptions;
}): TerminalizeOperatorApprovalsResult {
  const runtimeEpoch = requireString(params.runtimeEpoch, "operator approval runtime epoch");
  return runOpenClawStateWriteTransaction((database) => {
    const nowMs = params.nowMs ?? Date.now();
    const stateDb = getNodeSqliteKysely<OperatorApprovalDatabase>(database.db);
    const orphanRows = executeSqliteQuerySync(
      database.db,
      stateDb
        .selectFrom("operator_approvals")
        .selectAll()
        .where("status", "=", "pending")
        .where("runtime_epoch", "!=", runtimeEpoch)
        .orderBy("created_at_ms", "asc")
        .orderBy("approval_id", "asc"),
    ).rows;
    if (orphanRows.length === 0) {
      return { affected: 0, records: [] };
    }
    let affected = 0;
    const terminalRows: OperatorApprovalRow[] = [];
    for (const row of orphanRows) {
      const auditTimestampMs = clampAuditTimestamp(nowMs, row.created_at_ms);
      const terminalFields = operatorApprovalTerminalFields(
        "cancelled",
        "gateway-restart",
        auditTimestampMs,
      );
      const result = executeSqliteQuerySync(
        database.db,
        stateDb
          .updateTable("operator_approvals")
          .set(terminalFields)
          .where("approval_id", "=", row.approval_id)
          .where("status", "=", "pending"),
      );
      const rowAffected = Number(result.numAffectedRows ?? 0n);
      affected += rowAffected;
      if (rowAffected === 1) {
        terminalRows.push({ ...row, ...terminalFields });
      }
    }
    operatorApprovalPublication.stagePostimages(database.db, terminalRows);
    return {
      affected,
      records: terminalRows
        .map((row) => decodeOperatorApprovalRow(row))
        .filter((record): record is OperatorApprovalRecord => record !== null),
    };
  }, params.databaseOptions);
}

export function pruneTerminalOperatorApprovals(params: {
  nowMs?: number;
  retentionMs?: number;
  databaseOptions?: OpenClawStateDatabaseOptions;
}): number {
  const retentionMs = params.retentionMs ?? OPERATOR_APPROVAL_TERMINAL_RETENTION_MS;
  if (!Number.isSafeInteger(retentionMs) || retentionMs < 0) {
    throw new Error("operator approval retention must be a non-negative safe integer");
  }
  return runOpenClawStateWriteTransaction((database) => {
    const nowMs = params.nowMs ?? Date.now();
    const cutoffMs = nowMs - retentionMs;
    const stateDb = getNodeSqliteKysely<OperatorApprovalDatabase>(database.db);
    const result = executeSqliteQuerySync(
      database.db,
      stateDb
        .deleteFrom("operator_approvals")
        .where("status", "!=", "pending")
        .where("resolved_at_ms", "is not", null)
        .where("resolved_at_ms", "<=", cutoffMs)
        .returning("approval_id"),
    );
    operatorApprovalPublication.stageDeletions(
      database.db,
      result.rows.map((row) => row.approval_id),
    );
    return result.rows.length;
  }, params.databaseOptions);
}
