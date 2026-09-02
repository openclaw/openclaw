import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { safeParseJson } from "@openclaw/normalization-core";
import { isRecord as isPlainRecord } from "@openclaw/normalization-core/record-coerce";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "./kysely-sync.js";
import {
  buildRestartSentinelRow,
  nextRevision,
  readRestartSentinelRowForKeySync,
  type RestartSentinel,
  type RestartSentinelPayload,
} from "./restart-sentinel-store.js";

export type UpdateFailureReportReceipt = {
  fallbackUrl?: string;
  preparingSinceMs?: number;
  reservationId: string;
  status: "preparing" | "pending" | "retryable" | "created" | "fallback";
  url?: string;
};

type GatewayRestartSentinelDatabase = Pick<OpenClawStateKyselyDatabase, "gateway_restart_sentinel">;

const RECEIPT_KEY_PREFIX = "update-failure-report:";
const PREPARING_RECEIPT_STALE_AFTER_MS = 2 * 60_000;

function receiptKey(attemptId: string): string {
  return `${RECEIPT_KEY_PREFIX}${createHash("sha256").update(attemptId).digest("hex")}`;
}

function parseReceipt(sentinel: RestartSentinel | null): UpdateFailureReportReceipt | null {
  if (
    sentinel?.payload.kind !== "update" ||
    sentinel.payload.status !== "skipped" ||
    sentinel.payload.stats?.reason !== "update-failure-report-receipt" ||
    typeof sentinel.payload.message !== "string"
  ) {
    return null;
  }
  const value = safeParseJson(sentinel.payload.message);
  if (
    !isPlainRecord(value) ||
    (value.status !== "preparing" &&
      value.status !== "pending" &&
      value.status !== "retryable" &&
      value.status !== "created" &&
      value.status !== "fallback") ||
    typeof value.reservationId !== "string" ||
    (value.status === "preparing" &&
      (typeof value.preparingSinceMs !== "number" || !Number.isFinite(value.preparingSinceMs))) ||
    (value.url !== undefined && typeof value.url !== "string") ||
    (value.fallbackUrl !== undefined && typeof value.fallbackUrl !== "string")
  ) {
    return null;
  }
  return {
    reservationId: value.reservationId,
    status: value.status,
    ...(typeof value.preparingSinceMs === "number"
      ? { preparingSinceMs: value.preparingSinceMs }
      : {}),
    ...(typeof value.url === "string" ? { url: value.url } : {}),
    ...(typeof value.fallbackUrl === "string" ? { fallbackUrl: value.fallbackUrl } : {}),
  };
}

function readReceipt(db: DatabaseSync, attemptId: string): UpdateFailureReportReceipt | null {
  const current = readRestartSentinelRowForKeySync(db, receiptKey(attemptId));
  return parseReceipt(current.kind === "valid" ? current.sentinel : null);
}

/** Reads one existing report receipt without creating state. */
export function readUpdateFailureReportReceiptRowSync(
  db: DatabaseSync,
  attemptId: string,
): UpdateFailureReportReceipt | null {
  return readReceipt(db, attemptId);
}

function buildReceiptPayload(receipt: UpdateFailureReportReceipt): RestartSentinelPayload {
  return {
    kind: "update",
    status: "skipped",
    ts: Date.now(),
    message: JSON.stringify(receipt),
    stats: { reason: "update-failure-report-receipt" },
  };
}

/** Atomically owns one report attempt in the canonical state database. */
export function reserveUpdateFailureReportReceiptRowSync(
  db: DatabaseSync,
  attemptId: string,
  reservationId: string,
): { receipt: UpdateFailureReportReceipt | null; reserved: boolean } {
  const sentinelKey = receiptKey(attemptId);
  const stateDb = getNodeSqliteKysely<GatewayRestartSentinelDatabase>(db);
  const nowMs = Date.now();
  const receipt: UpdateFailureReportReceipt = {
    preparingSinceMs: nowMs,
    reservationId,
    status: "preparing",
  };
  const row = buildRestartSentinelRow(buildReceiptPayload(receipt), nowMs, sentinelKey);
  const result = executeSqliteQuerySync(
    db,
    stateDb
      .insertInto("gateway_restart_sentinel")
      .values(row)
      .onConflict((conflict) => conflict.column("sentinel_key").doNothing()),
  );
  if (result.numAffectedRows === 1n) {
    return { receipt, reserved: true };
  }
  const current = readRestartSentinelRowForKeySync(db, sentinelKey);
  const currentReceipt = parseReceipt(current.kind === "valid" ? current.sentinel : null);
  const retryable = current.kind === "valid" && currentReceipt?.status === "retryable";
  const stalePreparation =
    current.kind === "valid" &&
    currentReceipt?.status === "preparing" &&
    currentReceipt.preparingSinceMs !== undefined &&
    currentReceipt.preparingSinceMs <= nowMs - PREPARING_RECEIPT_STALE_AFTER_MS;
  if (!retryable && !stalePreparation) {
    return { receipt: currentReceipt, reserved: false };
  }
  const replacement = buildRestartSentinelRow(
    buildReceiptPayload(receipt),
    nextRevision(current.sentinel.revision),
    sentinelKey,
  );
  const replaced = executeSqliteQuerySync(
    db,
    stateDb
      .updateTable("gateway_restart_sentinel")
      .set(replacement)
      .where("sentinel_key", "=", sentinelKey)
      .where("updated_at_ms", "=", current.sentinel.revision),
  );
  return replaced.numAffectedRows === 1n
    ? { receipt, reserved: true }
    : { receipt: readReceipt(db, attemptId), reserved: false };
}

/** Renews or restores one owned definitely-unstarted preparation before fallback publication. */
export function refreshUpdateFailureReportReceiptPreparationRowSync(
  db: DatabaseSync,
  attemptId: string,
  reservationId: string,
): boolean {
  const sentinelKey = receiptKey(attemptId);
  const current = readRestartSentinelRowForKeySync(db, sentinelKey);
  const currentReceipt = parseReceipt(current.kind === "valid" ? current.sentinel : null);
  if (
    current.kind !== "valid" ||
    !currentReceipt ||
    (currentReceipt.status !== "pending" && currentReceipt.status !== "preparing") ||
    currentReceipt.reservationId !== reservationId
  ) {
    return false;
  }
  const nowMs = Date.now();
  const refreshed: UpdateFailureReportReceipt = {
    preparingSinceMs: nowMs,
    reservationId,
    status: "preparing",
  };
  const row = buildRestartSentinelRow(
    buildReceiptPayload(refreshed),
    nextRevision(current.sentinel.revision),
    sentinelKey,
  );
  const stateDb = getNodeSqliteKysely<GatewayRestartSentinelDatabase>(db);
  const result = executeSqliteQuerySync(
    db,
    stateDb
      .updateTable("gateway_restart_sentinel")
      .set(row)
      .where("sentinel_key", "=", sentinelKey)
      .where("updated_at_ms", "=", current.sentinel.revision),
  );
  return result.numAffectedRows === 1n;
}

/** Makes one preparation ambiguity-safe immediately before issue creation starts. */
export function markUpdateFailureReportReceiptPendingRowSync(
  db: DatabaseSync,
  attemptId: string,
  reservationId: string,
): boolean {
  const sentinelKey = receiptKey(attemptId);
  const current = readRestartSentinelRowForKeySync(db, sentinelKey);
  const currentReceipt = parseReceipt(current.kind === "valid" ? current.sentinel : null);
  if (
    current.kind !== "valid" ||
    !currentReceipt ||
    currentReceipt.status !== "preparing" ||
    currentReceipt.reservationId !== reservationId
  ) {
    return false;
  }
  const pending: UpdateFailureReportReceipt = { reservationId, status: "pending" };
  const row = buildRestartSentinelRow(
    buildReceiptPayload(pending),
    nextRevision(current.sentinel.revision),
    sentinelKey,
  );
  const stateDb = getNodeSqliteKysely<GatewayRestartSentinelDatabase>(db);
  const result = executeSqliteQuerySync(
    db,
    stateDb
      .updateTable("gateway_restart_sentinel")
      .set(row)
      .where("sentinel_key", "=", sentinelKey)
      .where("updated_at_ms", "=", current.sentinel.revision),
  );
  return result.numAffectedRows === 1n;
}

/** Finalizes only a process-owned reservation in the required prior phase. */
export function finalizeUpdateFailureReportReceiptRowSync(
  db: DatabaseSync,
  attemptId: string,
  receipt: UpdateFailureReportReceipt,
): boolean {
  const sentinelKey = receiptKey(attemptId);
  const current = readRestartSentinelRowForKeySync(db, sentinelKey);
  const currentReceipt = parseReceipt(current.kind === "valid" ? current.sentinel : null);
  if (
    current.kind !== "valid" ||
    !currentReceipt ||
    currentReceipt.status !== (receipt.status === "fallback" ? "preparing" : "pending") ||
    currentReceipt.reservationId !== receipt.reservationId
  ) {
    return false;
  }
  const row = buildRestartSentinelRow(
    buildReceiptPayload(receipt),
    nextRevision(current.sentinel.revision),
    sentinelKey,
  );
  const stateDb = getNodeSqliteKysely<GatewayRestartSentinelDatabase>(db);
  const result = executeSqliteQuerySync(
    db,
    stateDb
      .updateTable("gateway_restart_sentinel")
      .set(row)
      .where("sentinel_key", "=", sentinelKey)
      .where("updated_at_ms", "=", current.sentinel.revision),
  );
  return result.numAffectedRows === 1n;
}

/** Removes private artifacts and releases their receipt under one state-owner transaction. */
export function releaseUpdateFailureReportReceiptWithCleanupRowSync(
  db: DatabaseSync,
  attemptId: string,
  reservationId: string,
  cleanup: () => void,
): boolean {
  const sentinelKey = receiptKey(attemptId);
  const current = readRestartSentinelRowForKeySync(db, sentinelKey);
  const currentReceipt = parseReceipt(current.kind === "valid" ? current.sentinel : null);
  if (
    current.kind !== "valid" ||
    !currentReceipt ||
    currentReceipt.status !== "preparing" ||
    currentReceipt.reservationId !== reservationId
  ) {
    return false;
  }
  cleanup();
  const stateDb = getNodeSqliteKysely<GatewayRestartSentinelDatabase>(db);
  const result = executeSqliteQuerySync(
    db,
    stateDb
      .deleteFrom("gateway_restart_sentinel")
      .where("sentinel_key", "=", sentinelKey)
      .where("updated_at_ms", "=", current.sentinel.revision),
  );
  return result.numAffectedRows === 1n;
}
