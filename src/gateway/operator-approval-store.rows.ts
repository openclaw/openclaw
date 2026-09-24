// Shared approval row codecs and connection-bound lifecycle primitives.
import { safeParseJson } from "@openclaw/normalization-core/json-coercion";
import { normalizeNullableString } from "@openclaw/normalization-core/string-coerce";
import { validateApprovalPresentation } from "../../packages/gateway-protocol/src/approval-result-validators.js";
import { isWellFormedApprovalId } from "../../packages/gateway-protocol/src/schema/approval-id.js";
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
import type { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import type {
  NewOperatorApproval,
  OperatorApprovalDatabase,
  OperatorApprovalDecision,
  OperatorApprovalHistoryCursor,
  OperatorApprovalKind,
  OperatorApprovalRecord,
  OperatorApprovalResolverKind,
  OperatorApprovalRow,
  OperatorApprovalStatus,
  OperatorApprovalTerminalReason,
} from "./operator-approval-store.types.js";
export const OPERATOR_APPROVAL_TERMINAL_RETENTION_MS = 30 * 24 * 60 * 60_000;
export const OPERATOR_APPROVAL_RECEIPT_SUMMARY_MAX_ROWS = 128;
export const OPERATOR_APPROVAL_RECEIPT_MAX_PAYLOAD_BYTES = 64 * 1024;
export const OPERATOR_APPROVAL_MAX_AUDIENCE_SESSION_KEYS = 64;
export const OPERATOR_APPROVAL_PENDING_SCAN_PAGE_SIZE = 256;
export const OPERATOR_APPROVAL_MAX_LIST_LIMIT = 1_001;
export const OPERATOR_APPROVAL_HISTORY_DEFAULT_LIMIT = 50;
export const OPERATOR_APPROVAL_HISTORY_MAX_LIMIT = 100;

export class OperatorApprovalHistoryCursorError extends Error {
  constructor() {
    super("invalid operator approval history cursor");
    this.name = "OperatorApprovalHistoryCursorError";
  }
}

export function parseOperatorApprovalKind(value: string): OperatorApprovalKind | null {
  return value === "exec" || value === "plugin" || value === "system-agent" ? value : null;
}

export const OPERATOR_APPROVAL_EXECUTION_IDENTITY_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS operator_approval_execution_identities (
  approval_id TEXT NOT NULL PRIMARY KEY
    REFERENCES operator_approvals(approval_id) ON DELETE CASCADE,
  source_context_id TEXT NOT NULL CHECK (
    length(source_context_id) BETWEEN 1 AND 256 AND source_context_id = trim(source_context_id)
  ),
  source_execution_id TEXT NOT NULL CHECK (
    length(source_execution_id) BETWEEN 1 AND 256 AND source_execution_id = trim(source_execution_id)
  )
) STRICT;
`;

export function normalizeExecutionIdentityBinding(input: NewOperatorApproval) {
  const binding = input.executionIdentityToken;
  const sourceRunId = normalizeNullableString(input.source?.runId);
  if (!binding || normalizeNullableString(binding.runId) !== sourceRunId) {
    return undefined;
  }
  const sourceContextId = normalizeNullableString(binding.contextId);
  const sourceExecutionId = normalizeNullableString(binding.executionId);
  if (
    !sourceContextId ||
    !sourceExecutionId ||
    sourceContextId.length > 256 ||
    sourceExecutionId.length > 256
  ) {
    return undefined;
  }
  return { sourceContextId, sourceExecutionId };
}

function parseApprovalPresentation(raw: string): ApprovalPresentation | null {
  const value = safeParseJson(raw);
  return validateApprovalPresentation(value) ? value : null;
}

function parseStringArray(raw: string): string[] | null {
  const value = safeParseJson(raw);
  if (
    !Array.isArray(value) ||
    !value.every((entry): entry is string => typeof entry === "string" && Boolean(entry.trim()))
  ) {
    return null;
  }
  return value;
}

export function requireString(value: string, label: string): string {
  const normalized = normalizeNullableString(value);
  if (!normalized) {
    throw new Error(`${label} must not be empty`);
  }
  return normalized;
}

export function requireApprovalId(value: string): string {
  if (!isWellFormedApprovalId(value)) {
    throw new Error("operator approval id must be non-empty, well-formed Unicode, and not . or ..");
  }
  return value;
}

export function encodeOperatorApprovalHistoryCursor(cursor: OperatorApprovalHistoryCursor): string {
  return Buffer.from(JSON.stringify({ v: 1, ...cursor }), "utf8").toString("base64url");
}

export function decodeOperatorApprovalHistoryCursor(raw: string): OperatorApprovalHistoryCursor {
  try {
    const bytes = Buffer.from(raw, "base64url");
    if (bytes.toString("base64url") !== raw) {
      throw new OperatorApprovalHistoryCursorError();
    }
    const parsed: unknown = JSON.parse(bytes.toString("utf8"));
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed) ||
      !("v" in parsed) ||
      parsed.v !== 1 ||
      !("resolvedAtMs" in parsed) ||
      typeof parsed.resolvedAtMs !== "number" ||
      !Number.isSafeInteger(parsed.resolvedAtMs) ||
      parsed.resolvedAtMs < 0 ||
      !("id" in parsed) ||
      typeof parsed.id !== "string" ||
      !isWellFormedApprovalId(parsed.id)
    ) {
      throw new OperatorApprovalHistoryCursorError();
    }
    const cursor = { resolvedAtMs: parsed.resolvedAtMs, id: parsed.id };
    if (encodeOperatorApprovalHistoryCursor(cursor) !== raw) {
      throw new OperatorApprovalHistoryCursorError();
    }
    return cursor;
  } catch (error) {
    if (error instanceof OperatorApprovalHistoryCursorError) {
      throw error;
    }
    throw new OperatorApprovalHistoryCursorError();
  }
}

export function stringifyPresentation(presentation: ApprovalPresentation): string {
  if (!validateApprovalPresentation(presentation)) {
    throw new Error("operator approval presentation must match the safe protocol schema");
  }
  let raw: string;
  try {
    raw = JSON.stringify(presentation);
  } catch (error) {
    throw new Error(`operator approval presentation is not JSON serializable: ${String(error)}`, {
      cause: error,
    });
  }
  if (!parseApprovalPresentation(raw)) {
    throw new Error("operator approval presentation must serialize to the safe protocol schema");
  }
  return raw;
}

export function isValidTimestamp(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

export function clampAuditTimestamp(nowMs: number, ...minimums: Array<number | null>): number {
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

export function decodeOperatorApprovalRow(row: OperatorApprovalRow): OperatorApprovalRecord | null {
  const presentation = parseApprovalPresentation(row.presentation_json);
  const reviewerDeviceIds = parseStringArray(row.reviewer_device_ids_json);
  const audienceSessionKeys = parseStringArray(row.audience_session_keys_json);
  const kind = parseOperatorApprovalKind(row.kind);
  const status = row.status;
  const decision = row.decision;
  const terminalReason = row.terminal_reason;
  const resolverKind = row.resolver_kind;
  if (
    !presentation ||
    !isWellFormedApprovalId(row.approval_id) ||
    !isApprovalResolutionRef(row.resolution_ref) ||
    !reviewerDeviceIds ||
    !audienceSessionKeys ||
    audienceSessionKeys.length > OPERATOR_APPROVAL_MAX_AUDIENCE_SESSION_KEYS ||
    !kind ||
    (status !== "pending" &&
      status !== "allowed" &&
      status !== "denied" &&
      status !== "expired" &&
      status !== "cancelled") ||
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
    (decision !== null &&
      decision !== "allow-once" &&
      decision !== "allow-always" &&
      decision !== "deny") ||
    (terminalReason !== null &&
      terminalReason !== "user" &&
      terminalReason !== "timeout" &&
      terminalReason !== "malformed-verdict" &&
      terminalReason !== "no-route" &&
      terminalReason !== "run-aborted" &&
      terminalReason !== "gateway-restart" &&
      terminalReason !== "storage-corrupt") ||
    (resolverKind !== null &&
      resolverKind !== "device" &&
      resolverKind !== "channel" &&
      resolverKind !== "runtime" &&
      resolverKind !== "system")
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

export function selectOperatorApprovalRow(
  database: ReturnType<typeof openOpenClawStateDatabase>,
  id: string,
): OperatorApprovalRow | undefined {
  const stateDb = getNodeSqliteKysely<OperatorApprovalDatabase>(database.db);
  return executeSqliteQueryTakeFirstSync(
    database.db,
    stateDb.selectFrom("operator_approvals").selectAll().where("approval_id", "=", id),
  );
}

export function selectOperatorApprovalRowByLocator(
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

export function hasApprovalLocatorNamespaceConflict(params: {
  database: ReturnType<typeof openOpenClawStateDatabase>;
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

export function matchesExpectedApprovalOwner(params: {
  row: OperatorApprovalRow;
  expectedKind?: OperatorApprovalKind;
  runtimeEpoch?: string;
}): boolean {
  return (
    (params.expectedKind === undefined || params.row.kind === params.expectedKind) &&
    (params.runtimeEpoch === undefined || params.row.runtime_epoch === params.runtimeEpoch)
  );
}

export function denyCorruptPendingRow(params: {
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

export function expirePendingRow(params: {
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

export function requireDecodedRecord(row: OperatorApprovalRow): OperatorApprovalRecord {
  const record = decodeOperatorApprovalRow(row);
  if (!record) {
    throw new Error(`operator approval '${row.approval_id}' became corrupt during a transaction`);
  }
  return record;
}

export function inputMatchesExistingRow(
  input: NewOperatorApproval,
  row: OperatorApprovalRow,
  serialized: {
    presentationJson: string;
    reviewerDeviceIdsJson: string;
    audienceSessionKeysJson: string;
  },
): boolean {
  const source = input.source ?? {};
  return (
    row.status === "pending" &&
    row.kind === input.kind &&
    row.presentation_json === serialized.presentationJson &&
    row.requested_by_device_id === normalizeNullableString(input.requester?.deviceId) &&
    row.requested_by_client_id === normalizeNullableString(input.requester?.clientId) &&
    row.requested_by_device_token_auth === (input.requester?.deviceTokenAuth === true ? 1 : 0) &&
    row.reviewer_device_ids_json === serialized.reviewerDeviceIdsJson &&
    row.source_agent_id === normalizeNullableString(source.agentId) &&
    row.source_session_key === normalizeNullableString(source.sessionKey) &&
    row.source_session_id === normalizeNullableString(source.sessionId) &&
    row.source_run_id === normalizeNullableString(source.runId) &&
    row.source_tool_call_id === normalizeNullableString(source.toolCallId) &&
    row.source_tool_name === normalizeNullableString(source.toolName) &&
    row.audience_session_keys_json === serialized.audienceSessionKeysJson &&
    row.runtime_epoch === input.runtimeEpoch.trim() &&
    row.created_at_ms === input.createdAtMs &&
    row.expires_at_ms === input.expiresAtMs
  );
}
