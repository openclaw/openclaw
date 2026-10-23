import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../infra/kysely-sync.js";
import type { OpenClawStateDatabase } from "../state/openclaw-state-db-contract.js";
import { operatorApprovalTerminalFields } from "./operator-approval-store.fields.js";
import { operatorApprovalPublication } from "./operator-approval-store.publication.js";
import { clampAuditTimestamp } from "./operator-approval-store.rows.js";
import type {
  OperatorApprovalDatabase,
  OperatorApprovalRow,
} from "./operator-approval-store.types.js";

export function selectOperatorApprovalRow(
  database: OpenClawStateDatabase,
  id: string,
): OperatorApprovalRow | undefined {
  const stateDb = getNodeSqliteKysely<OperatorApprovalDatabase>(database.db);
  return executeSqliteQueryTakeFirstSync(
    database.db,
    stateDb.selectFrom("operator_approvals").selectAll().where("approval_id", "=", id),
  );
}

export function selectOperatorApprovalRowByLocator(
  database: OpenClawStateDatabase,
  locator: string,
): OperatorApprovalRow | undefined {
  const stateDb = getNodeSqliteKysely<OperatorApprovalDatabase>(database.db);
  const rows = executeSqliteQuerySync(
    database.db,
    stateDb
      .selectFrom("operator_approvals")
      .selectAll()
      .where((eb) => eb.or([eb("approval_id", "=", locator), eb("resolution_ref", "=", locator)]))
      .limit(2),
  ).rows;
  return rows.length === 1 ? rows[0] : undefined;
}

export function hasApprovalLocatorNamespaceConflict(params: {
  database: OpenClawStateDatabase;
  id: string;
  resolutionRef: string;
}): boolean {
  const stateDb = getNodeSqliteKysely<OperatorApprovalDatabase>(params.database.db);
  const row = executeSqliteQueryTakeFirstSync(
    params.database.db,
    stateDb
      .selectFrom("operator_approvals")
      .select("approval_id")
      .where((eb) =>
        eb.or([eb("approval_id", "=", params.resolutionRef), eb("resolution_ref", "=", params.id)]),
      )
      .where("approval_id", "!=", params.id),
  );
  return row !== undefined;
}

export function denyCorruptPendingRow(params: {
  database: OpenClawStateDatabase;
  id: string;
  nowMs: number;
  createdAtMs: number;
}): void {
  const auditTimestampMs = clampAuditTimestamp(params.nowMs, params.createdAtMs);
  const stateDb = getNodeSqliteKysely<OperatorApprovalDatabase>(params.database.db);
  const changed = executeSqliteQuerySync(
    params.database.db,
    stateDb
      .updateTable("operator_approvals")
      .set(operatorApprovalTerminalFields("denied", "storage-corrupt", auditTimestampMs))
      .where("approval_id", "=", params.id)
      .where("status", "=", "pending")
      .returningAll(),
  );
  operatorApprovalPublication.stagePostimages(params.database.db, changed.rows);
}

export function expirePendingRow(params: {
  database: OpenClawStateDatabase;
  id: string;
  nowMs: number;
  createdAtMs: number;
}): OperatorApprovalRow | undefined {
  const auditTimestampMs = clampAuditTimestamp(params.nowMs, params.createdAtMs);
  const stateDb = getNodeSqliteKysely<OperatorApprovalDatabase>(params.database.db);
  const changed = executeSqliteQuerySync(
    params.database.db,
    stateDb
      .updateTable("operator_approvals")
      .set(operatorApprovalTerminalFields("expired", "timeout", auditTimestampMs))
      .where("approval_id", "=", params.id)
      .where("status", "=", "pending")
      .where("expires_at_ms", "<=", params.nowMs)
      .returningAll(),
  );
  operatorApprovalPublication.stagePostimages(params.database.db, changed.rows);
  return changed.rows[0];
}
