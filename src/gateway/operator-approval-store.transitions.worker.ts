// First-answer, consumption, and expiry transactions owned by the approval worker.
import { normalizeNullableString } from "@openclaw/normalization-core/string-coerce";
import { mintMcpToolGrantLocked } from "../infra/exec-approvals-sqlite.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import type { OpenClawStateDatabaseOptions } from "../state/openclaw-state-db-contract.js";
import { runOpenClawStateWriteTransaction } from "../state/openclaw-state-db.js";
import type { CronStandingGrantMintSpec } from "./operator-approval-standing-grants.types.js";
import { mintCronStandingGrantLocked } from "./operator-approval-standing-grants.worker.js";
import { operatorApprovalTerminalFields } from "./operator-approval-store.fields.js";
import { operatorApprovalPublication } from "./operator-approval-store.publication.js";
import {
  requireApprovalId,
  requireString,
  matchesExpectedApprovalOwner,
  decodeOperatorApprovalRow,
  requireDecodedRecord,
  clampAuditTimestamp,
  isValidTimestamp,
} from "./operator-approval-store.rows.js";
import {
  selectOperatorApprovalRow,
  denyCorruptPendingRow,
  expirePendingRow,
} from "./operator-approval-store.rows.worker.js";
import type {
  OperatorApprovalDecision,
  OperatorApprovalKind,
  OperatorApprovalResolver,
  OperatorApprovalTerminalReason,
  OperatorApprovalDatabase,
  OperatorApprovalRecord,
  ResolveOperatorApprovalResult,
  ForceDenyOperatorApprovalResult,
  TerminalizeOperatorApprovalsResult,
  ConsumeOperatorApprovalResult,
} from "./operator-approval-store.types.js";

export function resolveOperatorApprovalInDatabase(params: {
  id: string;
  decision: OperatorApprovalDecision;
  resolver: OperatorApprovalResolver;
  expectedKind?: OperatorApprovalKind;
  runtimeEpoch?: string;
  nowMs?: number;
  mcpToolGrant?: { agentId: string; server: string; tool: string };
  /** Cron-context allow-always mints this scoped grant in the same transaction. */
  standingGrant?: { kind: "cron" } & CronStandingGrantMintSpec & {
      expiresAtMs: number | null;
    };
  databaseOptions?: OpenClawStateDatabaseOptions;
}): ResolveOperatorApprovalResult {
  const id = requireApprovalId(params.id);
  const resolverId = normalizeNullableString(params.resolver.id);
  const runtimeEpoch =
    params.runtimeEpoch === undefined
      ? undefined
      : requireString(params.runtimeEpoch, "operator approval runtime epoch");
  return runOpenClawStateWriteTransaction((database) => {
    const nowMs = params.nowMs ?? Date.now();
    let row = selectOperatorApprovalRow(database, id);
    if (!row) {
      return { outcome: "not-found" };
    }
    if (!matchesExpectedApprovalOwner({ row, expectedKind: params.expectedKind, runtimeEpoch })) {
      return { outcome: "not-found" };
    }
    let record = decodeOperatorApprovalRow(row);
    if (!record) {
      denyCorruptPendingRow({ database, id, nowMs, createdAtMs: row.created_at_ms });
      return { outcome: "corrupt" };
    }
    if (record.status !== "pending") {
      return {
        outcome: "already-resolved",
        retry: record.decision === params.decision ? "same" : "conflict",
        record,
      };
    }
    if (record.expiresAtMs <= nowMs) {
      row = expirePendingRow({ database, id, nowMs, createdAtMs: row.created_at_ms });
      if (!row) {
        return { outcome: "not-found" };
      }
      record = requireDecodedRecord(row);
      return { outcome: "expired", record };
    }
    if (!Array.prototype.includes.call(record.presentation.allowedDecisions, params.decision)) {
      return { outcome: "decision-not-allowed", record };
    }

    const auditTimestampMs = clampAuditTimestamp(nowMs, record.createdAtMs);
    const stateDb = getNodeSqliteKysely<OperatorApprovalDatabase>(database.db);
    const result = executeSqliteQuerySync(
      database.db,
      stateDb
        .updateTable("operator_approvals")
        .set(
          operatorApprovalTerminalFields(
            params.decision === "deny" ? "denied" : "allowed",
            "user",
            auditTimestampMs,
            params.decision,
            { kind: params.resolver.kind, id: resolverId },
          ),
        )
        .where("approval_id", "=", id)
        .returningAll(),
    );
    row = result.rows[0]!;
    record = requireDecodedRecord(row);
    operatorApprovalPublication.stagePostimages(database.db, [row]);
    if (
      params.decision === "allow-always" &&
      params.mcpToolGrant &&
      record.kind === "plugin" &&
      record.source.agentId === params.mcpToolGrant.agentId
    ) {
      mintMcpToolGrantLocked(database.db, params.mcpToolGrant, auditTimestampMs);
    }
    if (params.decision === "allow-always" && params.standingGrant) {
      // The parent decision and its derivative grant commit in one transaction.
      mintCronStandingGrantLocked(database, {
        ...params.standingGrant,
        approvalId: id,
        nowMs: auditTimestampMs,
      });
    }
    return { outcome: "resolved", record };
  }, params.databaseOptions);
}

export function forceDenyOperatorApprovalInDatabase(params: {
  id: string;
  status?: "denied" | "expired" | "cancelled";
  requireDue?: boolean;
  reason: OperatorApprovalTerminalReason;
  resolver: OperatorApprovalResolver;
  expectedKind?: OperatorApprovalKind;
  runtimeEpoch?: string;
  nowMs?: number;
  databaseOptions?: OpenClawStateDatabaseOptions;
}): ForceDenyOperatorApprovalResult {
  const id = requireApprovalId(params.id);
  const runtimeEpoch =
    params.runtimeEpoch === undefined
      ? undefined
      : requireString(params.runtimeEpoch, "operator approval runtime epoch");
  return runOpenClawStateWriteTransaction((database) => {
    const nowMs = params.nowMs ?? Date.now();
    const row = selectOperatorApprovalRow(database, id);
    if (!row) {
      return { outcome: "not-found" };
    }
    if (!matchesExpectedApprovalOwner({ row, expectedKind: params.expectedKind, runtimeEpoch })) {
      return { outcome: "not-found" };
    }
    if (row.status === "pending" && row.expires_at_ms <= nowMs) {
      const expiredRow = expirePendingRow({
        database,
        id,
        nowMs,
        createdAtMs: row.created_at_ms,
      });
      if (!expiredRow) {
        return { outcome: "not-found" };
      }
      const expiredRecord = decodeOperatorApprovalRow(expiredRow);
      return expiredRecord ? { outcome: "expired", record: expiredRecord } : { outcome: "corrupt" };
    }
    const record = decodeOperatorApprovalRow(row);
    if (!record) {
      denyCorruptPendingRow({ database, id, nowMs, createdAtMs: row.created_at_ms });
      return { outcome: "corrupt" };
    }
    if (record.status !== "pending") {
      return { outcome: "already-terminal", record };
    }
    if (params.status === "expired" && params.requireDue === true && record.expiresAtMs > nowMs) {
      return { outcome: "not-due", record };
    }
    const auditTimestampMs = clampAuditTimestamp(nowMs, record.createdAtMs);
    const stateDb = getNodeSqliteKysely<OperatorApprovalDatabase>(database.db);
    const result = executeSqliteQuerySync(
      database.db,
      stateDb
        .updateTable("operator_approvals")
        .set(
          operatorApprovalTerminalFields(
            params.status ?? "denied",
            params.reason,
            auditTimestampMs,
            "deny",
            { kind: params.resolver.kind, id: normalizeNullableString(params.resolver.id) },
          ),
        )
        .where("approval_id", "=", id)
        .returningAll(),
    );
    const terminalRow = result.rows[0]!;
    operatorApprovalPublication.stagePostimages(database.db, [terminalRow]);
    return { outcome: "denied", record: requireDecodedRecord(terminalRow) };
  }, params.databaseOptions);
}

export function expireDueOperatorApprovalsInDatabase(params: {
  nowMs?: number;
  databaseOptions?: OpenClawStateDatabaseOptions;
}): TerminalizeOperatorApprovalsResult {
  return runOpenClawStateWriteTransaction((database) => {
    const nowMs = params.nowMs ?? Date.now();
    const stateDb = getNodeSqliteKysely<OperatorApprovalDatabase>(database.db);
    const terminalFields = operatorApprovalTerminalFields("expired", "timeout", nowMs);
    const result = executeSqliteQuerySync(
      database.db,
      stateDb
        .updateTable("operator_approvals")
        .set(terminalFields)
        .where("status", "=", "pending")
        .where("expires_at_ms", "<=", nowMs)
        .returningAll(),
    );
    operatorApprovalPublication.stagePostimages(database.db, result.rows);
    return {
      affected: result.rows.length,
      records: result.rows
        .toSorted(
          (a, b) =>
            a.expires_at_ms - b.expires_at_ms ||
            (a.approval_id < b.approval_id ? -1 : a.approval_id > b.approval_id ? 1 : 0),
        )
        .map((row) => decodeOperatorApprovalRow(row))
        .filter((record): record is OperatorApprovalRecord => record !== null),
    };
  }, params.databaseOptions);
}

export function consumeOperatorApprovalAllowOnceInDatabase(params: {
  id: string;
  consumerId: string;
  expectedKind?: OperatorApprovalKind;
  runtimeEpoch?: string;
  redemptionWindowMs?: number;
  nowMs?: number;
  databaseOptions?: OpenClawStateDatabaseOptions;
}): ConsumeOperatorApprovalResult {
  const id = requireApprovalId(params.id);
  const consumerId = requireString(params.consumerId, "operator approval consumer id");
  const runtimeEpoch =
    params.runtimeEpoch === undefined
      ? undefined
      : requireString(params.runtimeEpoch, "operator approval runtime epoch");
  if (params.redemptionWindowMs !== undefined && !isValidTimestamp(params.redemptionWindowMs)) {
    throw new Error("operator approval redemption window must be a non-negative safe integer");
  }
  return runOpenClawStateWriteTransaction((database) => {
    const nowMs = params.nowMs ?? Date.now();
    const redemptionThresholdMs =
      params.redemptionWindowMs === undefined ? undefined : nowMs - params.redemptionWindowMs;
    let row = selectOperatorApprovalRow(database, id);
    if (!row) {
      return { outcome: "not-found" };
    }
    if (!matchesExpectedApprovalOwner({ row, expectedKind: params.expectedKind, runtimeEpoch })) {
      return { outcome: "not-found" };
    }
    if (row.status === "pending" && row.expires_at_ms <= nowMs) {
      row = expirePendingRow({ database, id, nowMs, createdAtMs: row.created_at_ms });
      if (!row) {
        return { outcome: "not-found" };
      }
    }
    let record = decodeOperatorApprovalRow(row);
    if (!record) {
      denyCorruptPendingRow({ database, id, nowMs, createdAtMs: row.created_at_ms });
      return { outcome: "corrupt" };
    }
    if (record.status !== "allowed" || record.decision !== "allow-once") {
      return { outcome: "not-allow-once", record };
    }
    if (record.consumedAtMs !== null) {
      return { outcome: "already-consumed", record };
    }
    if (record.resolvedAtMs === null) {
      return { outcome: "corrupt" };
    }
    if (redemptionThresholdMs !== undefined && record.resolvedAtMs <= redemptionThresholdMs) {
      return { outcome: "redemption-expired", record };
    }
    const auditTimestampMs = clampAuditTimestamp(
      nowMs,
      record.createdAtMs,
      record.resolvedAtMs,
      record.updatedAtMs,
    );
    const stateDb = getNodeSqliteKysely<OperatorApprovalDatabase>(database.db);
    const result = executeSqliteQuerySync(
      database.db,
      stateDb
        .updateTable("operator_approvals")
        .set({
          consumed_at_ms: auditTimestampMs,
          consumed_by: consumerId,
          updated_at_ms: auditTimestampMs,
        })
        .where("approval_id", "=", id)
        .returningAll(),
    );
    row = result.rows[0]!;
    record = requireDecodedRecord(row);
    operatorApprovalPublication.stagePostimages(database.db, [row]);
    return { outcome: "consumed", record };
  }, params.databaseOptions);
}
