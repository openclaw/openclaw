// First-answer, consumption, expiry, and boot cleanup transactions.
import { normalizeNullableString } from "@openclaw/normalization-core/string-coerce";
import { mintMcpToolGrantLocked } from "../infra/exec-approvals-sqlite.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import type { OpenClawStateDatabaseOptions } from "../state/openclaw-state-db-contract.js";
import { runOpenClawStateWriteTransaction } from "../state/openclaw-state-db.js";
import { mintCronStandingGrantLocked } from "./operator-approval-standing-grants.js";
import type { CronStandingGrantMintSpec } from "./operator-approval-standing-grants.types.js";
import { operatorApprovalTerminalFields } from "./operator-approval-store.fields.js";
import {
  OPERATOR_APPROVAL_TERMINAL_RETENTION_MS,
  requireApprovalId,
  requireString,
  selectOperatorApprovalRow,
  matchesExpectedApprovalOwner,
  decodeOperatorApprovalRow,
  denyCorruptPendingRow,
  expirePendingRow,
  requireDecodedRecord,
  clampAuditTimestamp,
  isValidTimestamp,
} from "./operator-approval-store.rows.js";
import type {
  OperatorApprovalDecision,
  OperatorApprovalKind,
  OperatorApprovalResolver,
  OperatorApprovalTerminalReason,
  OperatorApprovalDatabase,
  OperatorApprovalRecord,
  OperatorApprovalRow,
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
    let resolveQuery = stateDb
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
      .where("status", "=", "pending")
      .where("expires_at_ms", ">", nowMs);
    if (params.expectedKind !== undefined) {
      resolveQuery = resolveQuery.where("kind", "=", params.expectedKind);
    }
    if (runtimeEpoch !== undefined) {
      resolveQuery = resolveQuery.where("runtime_epoch", "=", runtimeEpoch);
    }
    const result = executeSqliteQuerySync(database.db, resolveQuery);
    row = selectOperatorApprovalRow(database, id);
    if (!row) {
      return { outcome: "not-found" };
    }
    record = requireDecodedRecord(row);
    if (result.numAffectedRows === 1n) {
      if (
        params.decision === "allow-always" &&
        params.mcpToolGrant &&
        record.kind === "plugin" &&
        record.source.agentId === params.mcpToolGrant.agentId
      ) {
        mintMcpToolGrantLocked(database.db, params.mcpToolGrant, auditTimestampMs);
      }
      if (params.decision === "allow-always" && params.standingGrant) {
        // Same-transaction mint: the just-resolved approval row is the sole
        // authorization owner; the grant is its derivative cron re-execution scope.
        mintCronStandingGrantLocked(database, {
          ...params.standingGrant,
          approvalId: id,
          nowMs: auditTimestampMs,
        });
      }
      return { outcome: "resolved", record };
    }
    if (record.status === "pending" && record.expiresAtMs <= nowMs) {
      const expiredRow = expirePendingRow({
        database,
        id,
        nowMs,
        createdAtMs: record.createdAtMs,
      });
      if (!expiredRow) {
        return { outcome: "not-found" };
      }
      return { outcome: "expired", record: requireDecodedRecord(expiredRow) };
    }
    return {
      outcome: "already-resolved",
      retry: record.decision === params.decision ? "same" : "conflict",
      record,
    };
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
    let denyQuery = stateDb
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
      .where("status", "=", "pending");
    if (params.expectedKind !== undefined) {
      denyQuery = denyQuery.where("kind", "=", params.expectedKind);
    }
    if (runtimeEpoch !== undefined) {
      denyQuery = denyQuery.where("runtime_epoch", "=", runtimeEpoch);
    }
    executeSqliteQuerySync(database.db, denyQuery);
    const terminalRow = selectOperatorApprovalRow(database, id);
    if (!terminalRow) {
      return { outcome: "not-found" };
    }
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
    const dueRows = executeSqliteQuerySync(
      database.db,
      stateDb
        .selectFrom("operator_approvals")
        .selectAll()
        .where("status", "=", "pending")
        .where("expires_at_ms", "<=", nowMs)
        .orderBy("expires_at_ms", "asc")
        .orderBy("approval_id", "asc"),
    ).rows;
    if (dueRows.length === 0) {
      return { affected: 0, records: [] };
    }
    const terminalFields = operatorApprovalTerminalFields("expired", "timeout", nowMs);
    const result = executeSqliteQuerySync(
      database.db,
      stateDb
        .updateTable("operator_approvals")
        .set(terminalFields)
        .where("status", "=", "pending")
        .where("expires_at_ms", "<=", nowMs),
    );
    return {
      affected: Number(result.numAffectedRows ?? 0n),
      records: dueRows
        .map((row) => decodeOperatorApprovalRow({ ...row, ...terminalFields }))
        .filter((record): record is OperatorApprovalRecord => record !== null),
    };
  }, params.databaseOptions);
}

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
    return {
      affected,
      records: terminalRows
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
    let consumeQuery = stateDb
      .updateTable("operator_approvals")
      .set({
        consumed_at_ms: auditTimestampMs,
        consumed_by: consumerId,
        updated_at_ms: auditTimestampMs,
      })
      .where("approval_id", "=", id)
      .where("status", "=", "allowed")
      .where("decision", "=", "allow-once")
      .where("consumed_at_ms", "is", null);
    if (redemptionThresholdMs !== undefined) {
      consumeQuery = consumeQuery.where("resolved_at_ms", ">", redemptionThresholdMs);
    }
    if (params.expectedKind !== undefined) {
      consumeQuery = consumeQuery.where("kind", "=", params.expectedKind);
    }
    if (runtimeEpoch !== undefined) {
      consumeQuery = consumeQuery.where("runtime_epoch", "=", runtimeEpoch);
    }
    const result = executeSqliteQuerySync(database.db, consumeQuery);
    row = selectOperatorApprovalRow(database, id);
    if (!row) {
      return { outcome: "not-found" };
    }
    record = requireDecodedRecord(row);
    if (result.numAffectedRows === 1n) {
      return { outcome: "consumed", record };
    }
    if (
      redemptionThresholdMs !== undefined &&
      record.resolvedAtMs !== null &&
      record.resolvedAtMs <= redemptionThresholdMs
    ) {
      return { outcome: "redemption-expired", record };
    }
    return { outcome: "already-consumed", record };
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
        .where("resolved_at_ms", "<=", cutoffMs),
    );
    return Number(result.numAffectedRows ?? 0n);
  }, params.databaseOptions);
}
