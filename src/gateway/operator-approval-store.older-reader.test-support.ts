import { normalizeNullableString as normalizeString } from "@openclaw/normalization-core/string-coerce";
import { validateApprovalPresentation } from "../../packages/gateway-protocol/src/approval-result-validators.js";
import { isWellFormedApprovalId } from "../../packages/gateway-protocol/src/schema/approval-id.js";
// Frozen pre-companion approval reader from aa7cf44c75a123a2724f20b05cd10d66cf7e65f3.
// get/resolve and their validation/query helpers below are unmodified historical source.
// Database, protocol, and nullable-string normalization dependencies are current;
// normalization is equivalent for the historical string/null/undefined input domain.
// This qualifies the older reader, not an older binary's schema-version admission.
import type { ApprovalPresentation } from "../../packages/gateway-protocol/src/schema/approvals.js";
import {
  buildApprovalResolutionRef,
  isApprovalResolutionRef,
} from "../infra/approval-resolution-ref.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../infra/kysely-sync.js";
import {
  type OpenClawStateDatabaseOptions,
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";
import type {
  GetOperatorApprovalResult,
  OperatorApprovalDatabase,
  OperatorApprovalDecision,
  OperatorApprovalKind,
  OperatorApprovalRecord,
  OperatorApprovalResolver,
  OperatorApprovalResolverKind,
  OperatorApprovalRow,
  OperatorApprovalStatus,
  OperatorApprovalTerminalReason,
  ResolveOperatorApprovalResult,
} from "./operator-approval-store.types.js";

const OPERATOR_APPROVAL_MAX_AUDIENCE_SESSION_KEYS = 64;

const OPERATOR_APPROVAL_DECISIONS = new Set<OperatorApprovalDecision>([
  "allow-once",
  "allow-always",
  "deny",
]);
const OPERATOR_APPROVAL_KINDS = new Set<OperatorApprovalKind>(["exec", "plugin", "system-agent"]);
const OPERATOR_APPROVAL_STATUSES = new Set<OperatorApprovalStatus>([
  "pending",
  "allowed",
  "denied",
  "expired",
  "cancelled",
]);
const OPERATOR_APPROVAL_TERMINAL_REASONS = new Set<OperatorApprovalTerminalReason>([
  "user",
  "timeout",
  "malformed-verdict",
  "no-route",
  "run-aborted",
  "gateway-restart",
  "storage-corrupt",
]);
const OPERATOR_APPROVAL_RESOLVER_KINDS = new Set<OperatorApprovalResolverKind>([
  "device",
  "channel",
  "runtime",
  "system",
]);

function parseApprovalPresentation(raw: string): ApprovalPresentation | null {
  try {
    const value: unknown = JSON.parse(raw);
    return validateApprovalPresentation(value) ? value : null;
  } catch {
    return null;
  }
}

function parseStringArray(raw: string): string[] | null {
  try {
    const value: unknown = JSON.parse(raw);
    if (
      !Array.isArray(value) ||
      value.some((entry) => typeof entry !== "string" || !entry.trim())
    ) {
      return null;
    }
    return value as string[];
  } catch {
    return null;
  }
}

function requireString(value: string, label: string): string {
  const normalized = normalizeString(value);
  if (!normalized) {
    throw new Error(`${label} must not be empty`);
  }
  return normalized;
}

function requireApprovalId(value: string): string {
  if (!isWellFormedApprovalId(value)) {
    throw new Error("operator approval id must be non-empty, well-formed Unicode, and not . or ..");
  }
  return value;
}

function isValidTimestamp(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function clampAuditTimestamp(nowMs: number, ...minimums: Array<number | null>): number {
  return Math.max(nowMs, ...minimums.filter((value): value is number => value !== null));
}

function hasValidLifecycleTuple(params: {
  row: OperatorApprovalRow;
  status: OperatorApprovalStatus;
  decision: OperatorApprovalDecision | null;
  terminalReason: OperatorApprovalTerminalReason | null;
  resolverKind: OperatorApprovalResolverKind | null;
}): boolean {
  const { row, status, decision, terminalReason, resolverKind } = params;
  const noConsumption = row.consumed_at_ms === null && row.consumed_by === null;
  if (status === "pending") {
    return (
      decision === null &&
      terminalReason === null &&
      row.resolved_at_ms === null &&
      resolverKind === null &&
      row.resolver_id === null &&
      noConsumption
    );
  }
  if (row.resolved_at_ms === null || resolverKind === null) {
    return false;
  }
  if (status === "allowed") {
    const validConsumption =
      decision === "allow-once"
        ? noConsumption || (row.consumed_at_ms !== null && Boolean(row.consumed_by?.trim()))
        : noConsumption;
    return (
      (decision === "allow-once" || decision === "allow-always") &&
      terminalReason === "user" &&
      validConsumption
    );
  }
  if (decision !== "deny" || !noConsumption) {
    return false;
  }
  if (status === "denied") {
    return (
      terminalReason === "user" ||
      terminalReason === "malformed-verdict" ||
      terminalReason === "no-route" ||
      terminalReason === "storage-corrupt"
    );
  }
  if (status === "expired") {
    return terminalReason === "timeout";
  }
  return (
    status === "cancelled" &&
    (terminalReason === "run-aborted" || terminalReason === "gateway-restart")
  );
}

function decodeOperatorApprovalRow(row: OperatorApprovalRow): OperatorApprovalRecord | null {
  const presentation = parseApprovalPresentation(row.presentation_json);
  const reviewerDeviceIds = parseStringArray(row.reviewer_device_ids_json);
  const audienceSessionKeys = parseStringArray(row.audience_session_keys_json);
  const kind = row.kind as OperatorApprovalKind;
  const status = row.status as OperatorApprovalStatus;
  const decision = row.decision as OperatorApprovalDecision | null;
  const terminalReason = row.terminal_reason as OperatorApprovalTerminalReason | null;
  const resolverKind = row.resolver_kind as OperatorApprovalResolverKind | null;
  if (
    !presentation ||
    !isWellFormedApprovalId(row.approval_id) ||
    !isApprovalResolutionRef(row.resolution_ref) ||
    !reviewerDeviceIds ||
    !audienceSessionKeys ||
    audienceSessionKeys.length > OPERATOR_APPROVAL_MAX_AUDIENCE_SESSION_KEYS ||
    !OPERATOR_APPROVAL_KINDS.has(kind) ||
    !OPERATOR_APPROVAL_STATUSES.has(status) ||
    !isValidTimestamp(row.created_at_ms) ||
    !isValidTimestamp(row.expires_at_ms) ||
    !isValidTimestamp(row.updated_at_ms) ||
    row.expires_at_ms < row.created_at_ms ||
    row.updated_at_ms < row.created_at_ms ||
    (row.resolved_at_ms !== null &&
      (!isValidTimestamp(row.resolved_at_ms) ||
        row.resolved_at_ms < row.created_at_ms ||
        row.resolved_at_ms > row.updated_at_ms)) ||
    (row.consumed_at_ms !== null &&
      (!isValidTimestamp(row.consumed_at_ms) ||
        row.resolved_at_ms === null ||
        row.consumed_at_ms < row.resolved_at_ms ||
        row.consumed_at_ms > row.updated_at_ms)) ||
    (row.requested_by_device_token_auth !== 0 && row.requested_by_device_token_auth !== 1) ||
    (decision !== null && !OPERATOR_APPROVAL_DECISIONS.has(decision)) ||
    (terminalReason !== null && !OPERATOR_APPROVAL_TERMINAL_REASONS.has(terminalReason)) ||
    (resolverKind !== null && !OPERATOR_APPROVAL_RESOLVER_KINDS.has(resolverKind))
  ) {
    return null;
  }
  if (
    presentation.kind !== kind ||
    row.resolution_ref !==
      buildApprovalResolutionRef({ approvalId: row.approval_id, approvalKind: kind }) ||
    !hasValidLifecycleTuple({ row, status, decision, terminalReason, resolverKind }) ||
    (status === "allowed" &&
      (!decision || !Array.prototype.includes.call(presentation.allowedDecisions, decision)))
  ) {
    return null;
  }

  return {
    id: row.approval_id,
    resolutionRef: row.resolution_ref,
    kind,
    status,
    presentation,
    requester: {
      deviceId: row.requested_by_device_id,
      clientId: row.requested_by_client_id,
      deviceTokenAuth: row.requested_by_device_token_auth === 1,
    },
    reviewerDeviceIds,
    source: {
      agentId: row.source_agent_id,
      sessionKey: row.source_session_key,
      sessionId: row.source_session_id,
      runId: row.source_run_id,
      toolCallId: row.source_tool_call_id,
      toolName: row.source_tool_name,
    },
    audienceSessionKeys,
    runtimeEpoch: row.runtime_epoch,
    createdAtMs: row.created_at_ms,
    expiresAtMs: row.expires_at_ms,
    updatedAtMs: row.updated_at_ms,
    decision,
    terminalReason,
    resolvedAtMs: row.resolved_at_ms,
    resolver:
      resolverKind === null
        ? null
        : {
            kind: resolverKind,
            id: row.resolver_id,
          },
    consumedAtMs: row.consumed_at_ms,
    consumedBy: row.consumed_by,
  };
}

function selectOperatorApprovalRow(
  database: ReturnType<typeof openOpenClawStateDatabase>,
  id: string,
): OperatorApprovalRow | undefined {
  const stateDb = getNodeSqliteKysely<OperatorApprovalDatabase>(database.db);
  return executeSqliteQueryTakeFirstSync(
    database.db,
    stateDb.selectFrom("operator_approvals").selectAll().where("approval_id", "=", id),
  );
}

function selectOperatorApprovalRowByLocator(
  database: ReturnType<typeof openOpenClawStateDatabase>,
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

function matchesExpectedApprovalOwner(params: {
  row: OperatorApprovalRow;
  expectedKind?: OperatorApprovalKind;
  runtimeEpoch?: string;
}): boolean {
  return (
    (params.expectedKind === undefined || params.row.kind === params.expectedKind) &&
    (params.runtimeEpoch === undefined || params.row.runtime_epoch === params.runtimeEpoch)
  );
}

function denyCorruptPendingRow(params: {
  database: ReturnType<typeof openOpenClawStateDatabase>;
  id: string;
  nowMs: number;
  createdAtMs: number;
}): void {
  const auditTimestampMs = clampAuditTimestamp(params.nowMs, params.createdAtMs);
  const stateDb = getNodeSqliteKysely<OperatorApprovalDatabase>(params.database.db);
  executeSqliteQuerySync(
    params.database.db,
    stateDb
      .updateTable("operator_approvals")
      .set({
        status: "denied",
        decision: "deny",
        terminal_reason: "storage-corrupt",
        resolved_at_ms: auditTimestampMs,
        resolver_kind: "system",
        resolver_id: null,
        updated_at_ms: auditTimestampMs,
      })
      .where("approval_id", "=", params.id)
      .where("status", "=", "pending"),
  );
}

function expirePendingRow(params: {
  database: ReturnType<typeof openOpenClawStateDatabase>;
  id: string;
  nowMs: number;
  createdAtMs: number;
}): OperatorApprovalRow | undefined {
  const auditTimestampMs = clampAuditTimestamp(params.nowMs, params.createdAtMs);
  const stateDb = getNodeSqliteKysely<OperatorApprovalDatabase>(params.database.db);
  executeSqliteQuerySync(
    params.database.db,
    stateDb
      .updateTable("operator_approvals")
      .set({
        status: "expired",
        decision: "deny",
        terminal_reason: "timeout",
        resolved_at_ms: auditTimestampMs,
        resolver_kind: "system",
        resolver_id: null,
        updated_at_ms: auditTimestampMs,
      })
      .where("approval_id", "=", params.id)
      .where("status", "=", "pending")
      .where("expires_at_ms", "<=", params.nowMs),
  );
  return selectOperatorApprovalRow(params.database, params.id);
}

function requireDecodedRecord(row: OperatorApprovalRow): OperatorApprovalRecord {
  const record = decodeOperatorApprovalRow(row);
  if (!record) {
    throw new Error(`operator approval '${row.approval_id}' became corrupt during a transaction`);
  }
  return record;
}

export function getOperatorApprovalDetailed(params: {
  id: string;
  allowTransportRef?: boolean;
  nowMs?: number;
  databaseOptions?: OpenClawStateDatabaseOptions;
}): GetOperatorApprovalResult {
  const locator = requireApprovalId(params.id);
  return runOpenClawStateWriteTransaction((database) => {
    const nowMs = params.nowMs ?? Date.now();
    let row = params.allowTransportRef
      ? selectOperatorApprovalRowByLocator(database, locator)
      : selectOperatorApprovalRow(database, locator);
    if (!row) {
      return { outcome: "not-found" };
    }
    const id = row.approval_id;
    if (row.status === "pending" && row.expires_at_ms <= nowMs) {
      row = expirePendingRow({ database, id, nowMs, createdAtMs: row.created_at_ms });
      if (!row) {
        return { outcome: "not-found" };
      }
    }
    const record = decodeOperatorApprovalRow(row);
    if (record) {
      return { outcome: "found", record };
    }
    denyCorruptPendingRow({ database, id, nowMs, createdAtMs: row.created_at_ms });
    return params.allowTransportRef ? { outcome: "corrupt", id } : { outcome: "corrupt" };
  }, params.databaseOptions);
}

export function resolveOperatorApproval(params: {
  id: string;
  decision: OperatorApprovalDecision;
  resolver: OperatorApprovalResolver;
  expectedKind?: OperatorApprovalKind;
  runtimeEpoch?: string;
  nowMs?: number;
  databaseOptions?: OpenClawStateDatabaseOptions;
}): ResolveOperatorApprovalResult {
  const id = requireApprovalId(params.id);
  const resolverId = normalizeString(params.resolver.id);
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
      .set({
        status: params.decision === "deny" ? "denied" : "allowed",
        decision: params.decision,
        terminal_reason: "user",
        resolved_at_ms: auditTimestampMs,
        resolver_kind: params.resolver.kind,
        resolver_id: resolverId,
        updated_at_ms: auditTimestampMs,
      })
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

export const OLDER_OPERATOR_APPROVAL_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS operator_approvals (
  approval_id TEXT NOT NULL PRIMARY KEY CHECK (
    length(approval_id) > 0 AND approval_id NOT IN ('.', '..')
  ),
  resolution_ref TEXT NOT NULL CHECK (
    length(resolution_ref) = 43 AND resolution_ref NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  kind TEXT NOT NULL CHECK (kind IN ('exec', 'plugin', 'system-agent')),
  status TEXT NOT NULL CHECK (status IN ('pending', 'allowed', 'denied', 'expired', 'cancelled')),
  presentation_json TEXT NOT NULL,
  requested_by_device_id TEXT,
  requested_by_client_id TEXT,
  requested_by_device_token_auth INTEGER NOT NULL DEFAULT 0,
  reviewer_device_ids_json TEXT NOT NULL,
  source_agent_id TEXT,
  source_session_key TEXT,
  source_session_id TEXT,
  source_run_id TEXT,
  source_tool_call_id TEXT,
  source_tool_name TEXT,
  audience_session_keys_json TEXT NOT NULL,
  runtime_epoch TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  expires_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  decision TEXT CHECK (decision IN ('allow-once', 'allow-always', 'deny')),
  terminal_reason TEXT CHECK (
    terminal_reason IN (
      'user',
      'timeout',
      'malformed-verdict',
      'no-route',
      'run-aborted',
      'gateway-restart',
      'storage-corrupt'
    )
  ),
  resolved_at_ms INTEGER,
  resolver_kind TEXT CHECK (resolver_kind IN ('device', 'channel', 'runtime', 'system')),
  resolver_id TEXT,
  consumed_at_ms INTEGER,
  consumed_by TEXT,
  CHECK (expires_at_ms >= created_at_ms),
  CHECK (updated_at_ms >= created_at_ms),
  CHECK (resolved_at_ms IS NULL OR resolved_at_ms >= created_at_ms),
  CHECK (resolved_at_ms IS NULL OR resolved_at_ms <= updated_at_ms),
  CHECK (consumed_at_ms IS NULL OR consumed_at_ms >= resolved_at_ms),
  CHECK (consumed_at_ms IS NULL OR consumed_at_ms <= updated_at_ms),
  CHECK (requested_by_device_token_auth IN (0, 1)),
  CHECK (
    (
      status = 'pending'
      AND decision IS NULL
      AND terminal_reason IS NULL
      AND resolved_at_ms IS NULL
      AND resolver_kind IS NULL
      AND resolver_id IS NULL
      AND consumed_at_ms IS NULL
      AND consumed_by IS NULL
    )
    OR (
      status = 'allowed'
      AND decision IN ('allow-once', 'allow-always')
      AND terminal_reason = 'user'
      AND resolved_at_ms IS NOT NULL
      AND resolver_kind IS NOT NULL
    )
    OR (
      status = 'denied'
      AND decision = 'deny'
      AND terminal_reason IN ('user', 'malformed-verdict', 'no-route', 'storage-corrupt')
      AND resolved_at_ms IS NOT NULL
      AND resolver_kind IS NOT NULL
      AND consumed_at_ms IS NULL
      AND consumed_by IS NULL
    )
    OR (
      status = 'expired'
      AND decision = 'deny'
      AND terminal_reason = 'timeout'
      AND resolved_at_ms IS NOT NULL
      AND resolver_kind IS NOT NULL
      AND consumed_at_ms IS NULL
      AND consumed_by IS NULL
    )
    OR (
      status = 'cancelled'
      AND decision = 'deny'
      AND terminal_reason IN ('run-aborted', 'gateway-restart')
      AND resolved_at_ms IS NOT NULL
      AND resolver_kind IS NOT NULL
      AND consumed_at_ms IS NULL
      AND consumed_by IS NULL
    )
  ),
  CHECK (
    (consumed_at_ms IS NULL AND consumed_by IS NULL)
    OR (
      status = 'allowed'
      AND decision = 'allow-once'
      AND consumed_at_ms IS NOT NULL
      AND consumed_by IS NOT NULL
    )
  )
) STRICT;

CREATE INDEX IF NOT EXISTS idx_operator_approvals_status_expiry
  ON operator_approvals(status, expires_at_ms, approval_id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_operator_approvals_resolution_ref
  ON operator_approvals(resolution_ref);

CREATE INDEX IF NOT EXISTS idx_operator_approvals_source_session_created
  ON operator_approvals(source_session_key, created_at_ms DESC, approval_id);

CREATE INDEX IF NOT EXISTS idx_operator_approvals_resolved
  ON operator_approvals(resolved_at_ms, approval_id)
  WHERE resolved_at_ms IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_operator_approvals_runtime_pending
  ON operator_approvals(runtime_epoch, approval_id)
  WHERE status = 'pending';

`;
