// Bounded receipt projection, executed by the audit read worker.
import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { sql } from "kysely";
import type { DecisionReceiptV1 } from "../../packages/gateway-protocol/src/schema/audit-run.js";
import {
  buildApprovalResolutionRef,
  isApprovalResolutionRef,
} from "../infra/approval-resolution-ref.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../infra/kysely-sync.js";
import { normalizeSqliteNumber } from "../infra/sqlite-number.js";
import { tableExists } from "../state/openclaw-state-db-schema-helpers.js";
import {
  parseOperatorApprovalKind,
  OPERATOR_APPROVAL_TERMINAL_RETENTION_MS,
  OPERATOR_APPROVAL_RECEIPT_SUMMARY_MAX_ROWS,
  OPERATOR_APPROVAL_RECEIPT_MAX_PAYLOAD_BYTES,
  decodeOperatorApprovalRow,
  isValidTimestamp,
} from "./operator-approval-store.rows.js";
import type {
  OperatorApprovalRecord,
  OperatorApprovalReceiptContext,
  OperatorApprovalExecutionLinkState,
  OperatorApprovalRow,
  OperatorApprovalReceiptSnapshotRow,
  OperatorApprovalDatabase,
  OperatorApprovalReceiptCursor,
  OperatorApprovalReceiptSnapshotQueryRow,
  OperatorApprovalReceiptRow,
  OperatorApprovalReceiptPage,
} from "./operator-approval-store.types.js";
function operatorApprovalReasonCode(record: OperatorApprovalRecord): string {
  if (record.status === "allowed") {
    return record.decision === "allow-always"
      ? "operator_approval_allowed_always"
      : "operator_approval_allowed_once";
  }
  if (record.status === "expired") {
    return "operator_approval_expired";
  }
  if (record.status === "cancelled") {
    return record.terminalReason === "gateway-restart"
      ? "operator_approval_cancelled_gateway_restart"
      : "operator_approval_cancelled_run_aborted";
  }
  switch (record.terminalReason) {
    case "malformed-verdict":
      return "operator_approval_denied_malformed_verdict";
    case "no-route":
      return "operator_approval_denied_no_route";
    case "storage-corrupt":
      return "operator_approval_denied_storage_corrupt";
    default:
      return "operator_approval_denied_by_reviewer";
  }
}

function operatorApprovalPolicyRefs(record: OperatorApprovalRecord): string[] {
  const refs = ["operator-approval:first-answer-wins"];
  switch (record.terminalReason) {
    case "user":
      refs.push("operator-approval:human-decision");
      break;
    case "timeout":
      refs.push("operator-approval:deadline");
      break;
    case "no-route":
      refs.push("operator-approval:delivery-route-required");
      break;
    case "run-aborted":
      refs.push("operator-approval:run-lifecycle");
      break;
    case "gateway-restart":
      refs.push("operator-approval:runtime-lifecycle");
      break;
    case "malformed-verdict":
      refs.push("operator-approval:valid-verdict-required");
      break;
    case "storage-corrupt":
      refs.push("operator-approval:fail-closed-storage");
      break;
    case null:
      break;
  }
  return refs.toSorted();
}

function operatorApprovalRemediation(
  record: OperatorApprovalRecord,
): DecisionReceiptV1["remediation"] {
  if (record.status === "allowed") {
    return [];
  }
  switch (record.terminalReason) {
    case "timeout":
      return [
        {
          code: "request_approval_again",
          text: "Request the action again and resolve the new approval before its deadline.",
        },
      ];
    case "no-route":
      return [
        {
          code: "restore_approval_route",
          text: "Connect an eligible approval client or configure an approval delivery route, then request the action again.",
        },
      ];
    case "run-aborted":
      if (
        record.resolver?.kind === "system" &&
        (record.resolver.id === "permission-change" ||
          record.resolver.id === "approval-scope-closed")
      ) {
        return [
          {
            code: "request_approval_again",
            text: "Request the action again under the current permissions if it is still needed.",
          },
        ];
      }
      return [
        {
          code: "start_new_run",
          text: "Start a new run and request the action again if it is still needed.",
        },
      ];
    case "gateway-restart":
      return [
        {
          code: "request_after_restart",
          text: "After the Gateway is available, request the action again to create a current approval.",
        },
      ];
    case "malformed-verdict":
      return [
        {
          code: "submit_supported_decision",
          text: "Request the action again and resolve it with one of the decisions shown by the approval prompt.",
        },
      ];
    case "storage-corrupt":
      return [
        {
          code: "inspect_state_integrity",
          text: "Run openclaw doctor and inspect the shared state database before requesting the action again.",
        },
      ];
    default:
      return [
        {
          code: "review_and_request_again",
          text: "Review the denial, then request the action again only if an eligible reviewer should reconsider it.",
        },
      ];
  }
}

function projectOperatorApprovalReceipt(
  record: OperatorApprovalRecord,
  context: OperatorApprovalReceiptContext,
): DecisionReceiptV1 {
  const allowed = record.status === "allowed";
  const sourceRef = record.resolutionRef;
  return {
    schemaVersion: 1,
    receiptId: `approval:${sourceRef}`,
    contextId: context.contextId,
    executionId: context.executionId,
    runId: context.runId,
    actionId: sourceRef,
    occurredAt: record.resolvedAtMs ?? record.updatedAtMs,
    action: {
      family: record.kind,
      operation: "approval",
      summary: allowed
        ? `A ${record.kind} approval allowed the requested action.`
        : `A ${record.kind} approval stopped the requested action.`,
    },
    decision: {
      outcome: allowed ? "allowed" : "denied",
      reasonCode: operatorApprovalReasonCode(record),
    },
    enforcement: {
      coverageState: "enforced",
      evaluatorRef: `operator-approval:${record.resolver?.kind ?? "system"}`,
      policyRefs: operatorApprovalPolicyRefs(record),
      grantRefs: allowed ? [`operator-approval-grant:${sourceRef}`] : [],
      contextFieldsUsed: ["contextId", "executionId", "runId"],
    },
    source: {
      owner: "operator_approvals",
      recordRef: sourceRef,
      decisionBoundary: "gateway.operator-approval.first-answer",
    },
    missingEvidence: [],
    remediation: operatorApprovalRemediation(record),
  };
}

function projectUnlinkedOperatorApprovalReceipt(
  record: OperatorApprovalRecord,
  context: OperatorApprovalReceiptContext,
  linkState: Exclude<OperatorApprovalExecutionLinkState, "exact">,
): DecisionReceiptV1 {
  const sourceRef = record.resolutionRef;
  const receiptId = `approval-unlinked:${createHash("sha256")
    .update(sourceRef, "utf8")
    .update("\0", "utf8")
    .update(context.contextId, "utf8")
    .digest("base64url")}`;
  return {
    schemaVersion: 1,
    receiptId,
    contextId: context.contextId,
    executionId: context.executionId,
    runId: context.runId,
    actionId: sourceRef,
    occurredAt: record.resolvedAtMs ?? record.updatedAtMs,
    action: {
      family: record.kind,
      operation: "approval",
      summary: `A terminal ${record.kind} approval shares this run correlation, but its retained binding does not match this exact execution.`,
    },
    decision: {
      outcome: "unknown",
      reasonCode: `operator_approval_execution_link_${linkState}`,
    },
    enforcement: {
      coverageState: "unknown",
      policyRefs: operatorApprovalPolicyRefs(record),
      grantRefs: [],
      contextFieldsUsed: ["contextId", "executionId", "runId"],
    },
    source: {
      owner: "operator_approvals",
      recordRef: sourceRef,
      decisionBoundary: "gateway.operator-approval.first-answer",
    },
    missingEvidence: ["decision.execution_link"],
    remediation: [
      {
        code: "inspect_exact_approval_binding",
        text: "Treat this approval only as run-correlated; inspect its retained execution binding before trusting attribution.",
      },
    ],
  };
}

function projectCorruptOperatorApprovalReceipt(
  row: Pick<
    OperatorApprovalRow,
    "approval_id" | "kind" | "resolution_ref" | "resolved_at_ms" | "updated_at_ms"
  >,
  context: OperatorApprovalReceiptContext,
): DecisionReceiptV1 {
  const kind = parseOperatorApprovalKind(row.kind) ?? "exec";
  const sourceRef = isApprovalResolutionRef(row.resolution_ref)
    ? row.resolution_ref
    : buildApprovalResolutionRef({ approvalId: row.approval_id, approvalKind: kind });
  const occurredAt = isValidTimestamp(row.resolved_at_ms ?? -1)
    ? row.resolved_at_ms!
    : isValidTimestamp(row.updated_at_ms)
      ? row.updated_at_ms
      : 0;
  return {
    schemaVersion: 1,
    receiptId: `approval:${sourceRef}`,
    contextId: context.contextId,
    executionId: context.executionId,
    runId: context.runId,
    actionId: sourceRef,
    occurredAt,
    action: { family: kind, operation: "approval" },
    decision: { outcome: "unknown", reasonCode: "operator_approval_record_corrupt" },
    enforcement: {
      coverageState: "unknown",
      policyRefs: [],
      grantRefs: [],
      contextFieldsUsed: ["runId"],
    },
    source: {
      owner: "operator_approvals",
      recordRef: sourceRef,
      decisionBoundary: "gateway.operator-approval.first-answer",
    },
    missingEvidence: ["operator_approval.valid"],
    remediation: [
      {
        code: "inspect_state_integrity",
        text: "Run openclaw doctor and inspect the shared state database before trusting this approval.",
      },
    ],
  };
}

function projectOversizedOperatorApprovalReceipt(
  row: OperatorApprovalReceiptSnapshotRow,
  context: OperatorApprovalReceiptContext,
): DecisionReceiptV1 {
  const receipt = projectCorruptOperatorApprovalReceipt(row, context);
  return {
    ...receipt,
    decision: { outcome: "unknown", reasonCode: "operator_approval_payload_bounded" },
    missingEvidence: ["operator_approval.payload_bounded"],
    remediation: [
      {
        code: "inspect_approval_record",
        text: "Inspect the retained approval directly; its presentation exceeds the bounded audit projection.",
      },
    ],
  };
}

function terminalApprovalsForRunQuery(
  database: ReturnType<typeof getNodeSqliteKysely<OperatorApprovalDatabase>>,
  runId: string,
  nowMs: number,
) {
  return database
    .selectFrom("operator_approvals")
    .where("source_run_id", "=", runId)
    .where("status", "!=", "pending")
    .where("resolved_at_ms", "is not", null)
    .where("resolved_at_ms", ">=", nowMs - OPERATOR_APPROVAL_TERMINAL_RETENTION_MS);
}

function operatorApprovalRowId() {
  return /* kysely-allow-raw: SQLite rowid keeps the external cursor compact while the indexed approval id remains the query key. */ sql<number>`operator_approvals.rowid`;
}

function operatorApprovalSelectorId(
  row: Pick<OperatorApprovalReceiptSnapshotRow, "receipt_rowid">,
): string {
  const rowId = normalizeSqliteNumber(row.receipt_rowid);
  if (rowId === undefined || rowId < 1) {
    throw new Error("invalid operator approval receipt rowid");
  }
  return `approval-decision:${rowId}`;
}

function operatorApprovalPayloadBytes() {
  return /* kysely-allow-raw: SQLite byte length excludes oversized retained presentation JSON before materialization. */ sql<number>`
    length(CAST(operator_approvals.presentation_json AS BLOB)) +
    length(CAST(operator_approvals.reviewer_device_ids_json AS BLOB)) +
    length(CAST(operator_approvals.audience_session_keys_json AS BLOB))
  `;
}

const OPERATOR_APPROVAL_PAYLOAD_COLUMNS = {
  presentation_json: sql`operator_approvals.presentation_json`,
  reviewer_device_ids_json: sql`operator_approvals.reviewer_device_ids_json`,
  audience_session_keys_json: sql`operator_approvals.audience_session_keys_json`,
} as const;

function boundedOperatorApprovalPayload(column: keyof typeof OPERATOR_APPROVAL_PAYLOAD_COLUMNS) {
  return /* kysely-allow-raw: the page statement must not materialize owner payload JSON above its audit bound. */ sql<
    string | null
  >`CASE WHEN ${operatorApprovalPayloadBytes()} <= ${OPERATOR_APPROVAL_RECEIPT_MAX_PAYLOAD_BYTES} THEN ${OPERATOR_APPROVAL_PAYLOAD_COLUMNS[column]} ELSE NULL END`;
}

function operatorApprovalReceiptSnapshotColumns(hasExecutionIdentityTable: boolean) {
  const bindingContextId = hasExecutionIdentityTable
    ? sql`operator_approval_execution_identities.source_context_id`
    : sql`NULL`;
  const bindingExecutionId = hasExecutionIdentityTable
    ? sql`operator_approval_execution_identities.source_execution_id`
    : sql`NULL`;
  return sql`
    operator_approvals.approval_id,
    operator_approvals.consumed_at_ms,
    operator_approvals.consumed_by,
    operator_approvals.created_at_ms,
    operator_approvals.decision,
    operator_approvals.expires_at_ms,
    operator_approvals.kind,
    ${boundedOperatorApprovalPayload("presentation_json")} AS presentation_json,
    operator_approvals.requested_by_client_id,
    operator_approvals.requested_by_device_id,
    operator_approvals.requested_by_device_token_auth,
    operator_approvals.resolution_ref,
    operator_approvals.resolved_at_ms,
    operator_approvals.resolver_id,
    operator_approvals.resolver_kind,
    ${boundedOperatorApprovalPayload("reviewer_device_ids_json")} AS reviewer_device_ids_json,
    operator_approvals.runtime_epoch,
    operator_approvals.source_agent_id,
    operator_approvals.source_run_id,
    operator_approvals.source_session_id,
    operator_approvals.source_session_key,
    operator_approvals.source_tool_call_id,
    operator_approvals.source_tool_name,
    operator_approvals.status,
    operator_approvals.terminal_reason,
    operator_approvals.updated_at_ms,
    ${boundedOperatorApprovalPayload("audience_session_keys_json")} AS audience_session_keys_json,
    ${bindingContextId} AS binding_context_id,
    ${bindingExecutionId} AS binding_execution_id,
    ${operatorApprovalRowId()} AS receipt_rowid,
    ${operatorApprovalPayloadBytes()} AS payload_bytes
  `;
}

function terminalApprovalReceiptPageRows(params: {
  db: DatabaseSync;
  runId: string;
  nowMs: number;
  after?: OperatorApprovalReceiptCursor;
  offset?: number;
  limit: number;
}): OperatorApprovalReceiptSnapshotRow[] {
  const hasExecutionIdentityTable = tableExists(
    params.db,
    "operator_approval_execution_identities",
  );
  const executionIdentityJoin = hasExecutionIdentityTable
    ? sql`LEFT JOIN operator_approval_execution_identities
          ON operator_approval_execution_identities.approval_id = operator_approvals.approval_id`
    : sql``;
  const cutoffMs = params.nowMs - OPERATOR_APPROVAL_TERMINAL_RETENTION_MS;
  const offset = params.offset ?? 0;
  const pageStatement = params.after
    ? /* kysely-allow-raw: one CTE statement preserves cursor validation and pairs each owner rowid with its bounded receipt payload in the same SQLite snapshot. */ sql<OperatorApprovalReceiptSnapshotQueryRow>`
        WITH cursor_boundary AS (
          SELECT approval_id, resolved_at_ms, ${operatorApprovalRowId()} AS receipt_rowid
          FROM operator_approvals
          WHERE ${operatorApprovalRowId()} = ${params.after.rowId}
            AND source_run_id = ${params.runId}
            AND resolved_at_ms = ${params.after.occurredAt}
        ), approval_page AS (
          SELECT ${operatorApprovalReceiptSnapshotColumns(hasExecutionIdentityTable)}
          FROM operator_approvals
          ${executionIdentityJoin}
          CROSS JOIN cursor_boundary
          WHERE operator_approvals.source_run_id = ${params.runId}
            AND operator_approvals.status != 'pending'
            AND operator_approvals.resolved_at_ms IS NOT NULL
            AND operator_approvals.resolved_at_ms >= ${cutoffMs}
            AND (
              operator_approvals.resolved_at_ms > cursor_boundary.resolved_at_ms
              OR (
                operator_approvals.resolved_at_ms = cursor_boundary.resolved_at_ms
                AND operator_approvals.approval_id > cursor_boundary.approval_id
              )
            )
          ORDER BY operator_approvals.resolved_at_ms ASC, operator_approvals.approval_id ASC
          LIMIT ${params.limit} OFFSET ${offset}
        )
        SELECT
          cursor_boundary.receipt_rowid AS cursor_boundary_rowid,
          CASE WHEN approval_page.receipt_rowid IS NULL THEN 0 ELSE 1 END AS page_present,
          approval_page.*
        FROM (SELECT 1) AS snapshot_seed
        LEFT JOIN cursor_boundary ON TRUE
        LEFT JOIN approval_page ON TRUE
        ORDER BY approval_page.resolved_at_ms ASC, approval_page.approval_id ASC
      `
    : /* kysely-allow-raw: the initial page returns owner rowids and bounded receipt payloads in one SQLite snapshot. */ sql<OperatorApprovalReceiptSnapshotQueryRow>`
        SELECT
          NULL AS cursor_boundary_rowid,
          1 AS page_present,
          ${operatorApprovalReceiptSnapshotColumns(hasExecutionIdentityTable)}
        FROM operator_approvals
        ${executionIdentityJoin}
        WHERE operator_approvals.source_run_id = ${params.runId}
          AND operator_approvals.status != 'pending'
          AND operator_approvals.resolved_at_ms IS NOT NULL
          AND operator_approvals.resolved_at_ms >= ${cutoffMs}
        ORDER BY operator_approvals.resolved_at_ms ASC, operator_approvals.approval_id ASC
        LIMIT ${params.limit} OFFSET ${offset}
      `;
  const stateDb = getNodeSqliteKysely<OperatorApprovalDatabase>(params.db);
  const rows = executeSqliteQuerySync(
    params.db,
    stateDb
      .selectFrom(
        /* kysely-allow-raw: this derived table preserves the single owner-snapshot statement while exposing its closed row shape to Kysely. */
        sql<OperatorApprovalReceiptSnapshotQueryRow>`(${pageStatement})`.as("approval_snapshot"),
      )
      .selectAll(),
  ).rows;
  if (params.after && rows[0]?.cursor_boundary_rowid === null) {
    throw new Error("operator approval decision cursor is no longer retained");
  }
  if (rows.length === 1 && rows[0]?.page_present === 0) {
    return [];
  }
  return rows.map((row) => {
    if (row.page_present !== 1) {
      throw new Error("operator approval page snapshot is malformed");
    }
    return row;
  });
}

function materializeBoundedOperatorApprovalRow(
  row: OperatorApprovalReceiptSnapshotRow,
): OperatorApprovalReceiptRow | null {
  return typeof row.presentation_json === "string" &&
    typeof row.reviewer_device_ids_json === "string" &&
    typeof row.audience_session_keys_json === "string"
    ? {
        ...row,
        presentation_json: row.presentation_json,
        reviewer_device_ids_json: row.reviewer_device_ids_json,
        audience_session_keys_json: row.audience_session_keys_json,
      }
    : null;
}

function operatorApprovalExecutionLinkState(
  row: Pick<
    OperatorApprovalReceiptRow,
    "binding_context_id" | "binding_execution_id" | "source_run_id"
  >,
  context: OperatorApprovalReceiptContext,
): OperatorApprovalExecutionLinkState {
  if (row.binding_context_id === null && row.binding_execution_id === null) {
    return "missing";
  }
  if (
    typeof row.binding_context_id !== "string" ||
    typeof row.binding_execution_id !== "string" ||
    row.binding_context_id.length === 0 ||
    row.binding_execution_id.length === 0 ||
    row.binding_context_id.length > 256 ||
    row.binding_execution_id.length > 256 ||
    row.binding_context_id.trim() !== row.binding_context_id ||
    row.binding_execution_id.trim() !== row.binding_execution_id
  ) {
    return "malformed";
  }
  return row.binding_context_id === context.contextId &&
    row.binding_execution_id === context.executionId &&
    row.source_run_id === context.runId
    ? "exact"
    : "mismatch";
}

/** Probe for an authoritative retained approval without scanning the full run history. */
export function hasOperatorApprovalReceiptsForRunInDatabase(
  db: DatabaseSync,
  params: {
    runId: string;
    nowMs?: number;
  },
): boolean {
  if (!tableExists(db, "operator_approvals")) {
    return false;
  }
  const stateDb = getNodeSqliteKysely<OperatorApprovalDatabase>(db);
  return Boolean(
    executeSqliteQueryTakeFirstSync(
      db,
      terminalApprovalsForRunQuery(stateDb, params.runId, params.nowMs ?? Date.now())
        .clearSelect()
        .select("approval_id")
        .limit(1),
    ),
  );
}

/** Summarize at most 128 owner rows; the 129th makes coverage explicitly unknown. */
export function summarizeOperatorApprovalReceiptsForRunInDatabase(
  db: DatabaseSync,
  params: {
    context: OperatorApprovalReceiptContext;
    nowMs?: number;
    exactCount?: boolean;
  },
): {
  count: number;
  coverageState?: "enforced" | "unknown";
  missingEvidence: string[];
} {
  if (!tableExists(db, "operator_approvals")) {
    return { count: 0, missingEvidence: [] };
  }
  const stateDb = getNodeSqliteKysely<OperatorApprovalDatabase>(db);
  const snapshotRows = terminalApprovalReceiptPageRows({
    db,
    runId: params.context.runId,
    nowMs: params.nowMs ?? Date.now(),
    limit: OPERATOR_APPROVAL_RECEIPT_SUMMARY_MAX_ROWS + 1,
  });
  const boundedCount = snapshotRows.length;
  const count = params.exactCount
    ? (executeSqliteQueryTakeFirstSync(
        db,
        terminalApprovalsForRunQuery(stateDb, params.context.runId, params.nowMs ?? Date.now())
          .clearSelect()
          .select((eb) => eb.fn.countAll<number>().as("count")),
      )?.count ?? 0)
    : boundedCount;
  if (boundedCount === 0) {
    return { count: 0, missingEvidence: [] };
  }
  // Whole-set coverage stays conservative without decoding an unbounded
  // collection on the Gateway event loop.
  if (boundedCount > OPERATOR_APPROVAL_RECEIPT_SUMMARY_MAX_ROWS) {
    return {
      count,
      coverageState: "unknown" as const,
      missingEvidence: ["operator_approval.summary_bounded"],
    };
  }
  const hasOversizedRecord = snapshotRows.some(
    (row) => row.payload_bytes > OPERATOR_APPROVAL_RECEIPT_MAX_PAYLOAD_BYTES,
  );
  const boundedSnapshotRows = snapshotRows.filter(
    (row) => row.payload_bytes <= OPERATOR_APPROVAL_RECEIPT_MAX_PAYLOAD_BYTES,
  );
  const rows = boundedSnapshotRows.map(materializeBoundedOperatorApprovalRow);
  const hasMissingBoundedRow = rows.some((row) => row === null);
  const records = rows.map((row) => (row === null ? null : decodeOperatorApprovalRow(row)));
  const hasCorruptRecord = records.some((record) => record === null);
  const hasUnlinkedRecord = rows.some(
    (row, index) =>
      row !== null &&
      records[index] !== null &&
      operatorApprovalExecutionLinkState(row, params.context) !== "exact",
  );
  return {
    count,
    coverageState:
      hasOversizedRecord || hasMissingBoundedRow || hasCorruptRecord || hasUnlinkedRecord
        ? "unknown"
        : "enforced",
    missingEvidence: [
      ...(hasUnlinkedRecord ? ["decision.execution_link"] : []),
      ...(hasCorruptRecord ? ["operator_approval.valid"] : []),
      ...(hasOversizedRecord || hasMissingBoundedRow ? ["operator_approval.payload_bounded"] : []),
    ],
  };
}

/** Project authoritative approval rows directly; no generic decision fact is written. */
export function pageOperatorApprovalReceiptsForRunInDatabase(
  db: DatabaseSync,
  params: {
    context: OperatorApprovalReceiptContext;
    after?: OperatorApprovalReceiptCursor;
    offset?: number;
    limit: number;
    nowMs?: number;
  },
): OperatorApprovalReceiptPage {
  if (!tableExists(db, "operator_approvals")) {
    return { entries: [] };
  }
  const snapshotRows = terminalApprovalReceiptPageRows({
    db,
    runId: params.context.runId,
    nowMs: params.nowMs ?? Date.now(),
    after: params.after,
    offset: params.offset,
    limit: params.limit + 1,
  });
  const pageRows = snapshotRows.slice(0, params.limit);
  const entries = pageRows.map((snapshot) => {
    let receipt: DecisionReceiptV1;
    if (snapshot.payload_bytes > OPERATOR_APPROVAL_RECEIPT_MAX_PAYLOAD_BYTES) {
      receipt = projectOversizedOperatorApprovalReceipt(snapshot, params.context);
    } else {
      const row = materializeBoundedOperatorApprovalRow(snapshot);
      const record = row === null ? null : decodeOperatorApprovalRow(row);
      if (row === null || record === null) {
        receipt = projectCorruptOperatorApprovalReceipt(snapshot, params.context);
      } else {
        const linkState = operatorApprovalExecutionLinkState(row, params.context);
        receipt =
          linkState === "exact"
            ? projectOperatorApprovalReceipt(record, params.context)
            : projectUnlinkedOperatorApprovalReceipt(record, params.context, linkState);
      }
    }
    return { receipt, selectorId: operatorApprovalSelectorId(snapshot) };
  });
  const last = pageRows.at(-1);
  return {
    entries,
    ...(snapshotRows.length > params.limit && last && last.resolved_at_ms !== null
      ? {
          nextCursor: {
            occurredAt: last.resolved_at_ms,
            rowId: last.receipt_rowid,
          },
        }
      : {}),
  };
}
