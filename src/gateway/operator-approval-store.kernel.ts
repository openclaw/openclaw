// Approval creation and bounded query transactions, executed in workers.
import type { DatabaseSync } from "node:sqlite";
import { normalizeNullableString } from "@openclaw/normalization-core/string-coerce";
import { normalizeUniqueTrimmedStringList } from "@openclaw/normalization-core/string-normalization";
import { buildApprovalResolutionRef } from "../infra/approval-resolution-ref.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../infra/kysely-sync.js";
import { tableExists } from "../state/openclaw-state-db-schema-helpers.js";
import {
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabaseOptions,
} from "../state/openclaw-state-db.js";
import { matchesOperatorApprovalReviewerBinding } from "./operator-approval-reviewer-binding.js";
import {
  OPERATOR_APPROVAL_TERMINAL_RETENTION_MS,
  OPERATOR_APPROVAL_MAX_AUDIENCE_SESSION_KEYS,
  OPERATOR_APPROVAL_PENDING_SCAN_PAGE_SIZE,
  OPERATOR_APPROVAL_MAX_LIST_LIMIT,
  OPERATOR_APPROVAL_HISTORY_DEFAULT_LIMIT,
  OPERATOR_APPROVAL_HISTORY_MAX_LIMIT,
  OPERATOR_APPROVAL_EXECUTION_IDENTITY_SCHEMA_SQL,
  requireApprovalId,
  requireString,
  isValidTimestamp,
  stringifyPresentation,
  normalizeExecutionIdentityBinding,
  hasApprovalLocatorNamespaceConflict,
  selectOperatorApprovalRow,
  selectOperatorApprovalRowByLocator,
  decodeOperatorApprovalRow,
  denyCorruptPendingRow,
  inputMatchesExistingRow,
  expirePendingRow,
  decodeOperatorApprovalHistoryCursor,
  encodeOperatorApprovalHistoryCursor,
} from "./operator-approval-store.rows.js";
import { expireDueOperatorApprovalsInDatabase } from "./operator-approval-store.transitions.js";
import type {
  InsertOperatorApprovalResult,
  GetOperatorApprovalResult,
  OperatorApprovalDatabase,
  OperatorApprovalRecord,
  ListTerminalOperatorApprovalsInput,
  ListTerminalOperatorApprovalsResult,
} from "./operator-approval-store.types.js";
import type { OperatorApprovalWorkerOperations } from "./operator-approval-store.worker-contract.js";

type Input<Key extends keyof OperatorApprovalWorkerOperations> =
  OperatorApprovalWorkerOperations[Key]["input"] & {
    databaseOptions?: OpenClawStateDatabaseOptions;
  };

export function insertOperatorApprovalInDatabase(
  params: Input<"operatorApprovals.insert">,
): InsertOperatorApprovalResult {
  const input = params.approval;
  const id = requireApprovalId(input.id);
  const resolutionRef = buildApprovalResolutionRef({
    approvalId: id,
    approvalKind: input.kind,
  });
  const runtimeEpoch = requireString(input.runtimeEpoch, "operator approval runtime epoch");
  if (!isValidTimestamp(input.createdAtMs) || !isValidTimestamp(input.expiresAtMs)) {
    throw new Error("operator approval timestamps must be non-negative safe integers");
  }
  if (input.expiresAtMs < input.createdAtMs) {
    throw new Error("operator approval expiry cannot precede creation");
  }
  const presentationJson = stringifyPresentation(input.presentation);
  if (input.presentation.kind !== input.kind) {
    throw new Error("operator approval kind must match its safe presentation");
  }
  const reviewerDeviceIdsJson = JSON.stringify(
    normalizeUniqueTrimmedStringList(input.reviewerDeviceIds),
  );
  const audienceSessionKeys = normalizeUniqueTrimmedStringList(input.audienceSessionKeys);
  if (audienceSessionKeys.length > OPERATOR_APPROVAL_MAX_AUDIENCE_SESSION_KEYS) {
    throw new Error(
      `operator approval audience exceeds ${OPERATOR_APPROVAL_MAX_AUDIENCE_SESSION_KEYS} sessions`,
    );
  }
  const audienceSessionKeysJson = JSON.stringify(audienceSessionKeys);
  const serialized = {
    presentationJson,
    reviewerDeviceIdsJson,
    audienceSessionKeysJson,
  };
  const executionIdentityBinding = normalizeExecutionIdentityBinding(input);

  return runOpenClawStateWriteTransaction((database) => {
    const stateDb = getNodeSqliteKysely<OperatorApprovalDatabase>(database.db);
    executeSqliteQuerySync(
      database.db,
      stateDb
        .deleteFrom("operator_approvals")
        .where("status", "!=", "pending")
        .where("resolved_at_ms", "is not", null)
        .where("resolved_at_ms", "<=", input.createdAtMs - OPERATOR_APPROVAL_TERMINAL_RETENTION_MS),
    );
    if (hasApprovalLocatorNamespaceConflict({ database, id, resolutionRef })) {
      return { outcome: "conflict" };
    }
    const source = input.source ?? {};
    const result = executeSqliteQuerySync(
      database.db,
      stateDb
        .insertInto("operator_approvals")
        .values({
          approval_id: id,
          resolution_ref: resolutionRef,
          kind: input.kind,
          status: "pending",
          presentation_json: presentationJson,
          requested_by_device_id: normalizeNullableString(input.requester?.deviceId),
          requested_by_client_id: normalizeNullableString(input.requester?.clientId),
          requested_by_device_token_auth: input.requester?.deviceTokenAuth === true ? 1 : 0,
          reviewer_device_ids_json: reviewerDeviceIdsJson,
          source_agent_id: normalizeNullableString(source.agentId),
          source_session_key: normalizeNullableString(source.sessionKey),
          source_session_id: normalizeNullableString(source.sessionId),
          source_run_id: normalizeNullableString(source.runId),
          source_tool_call_id: normalizeNullableString(source.toolCallId),
          source_tool_name: normalizeNullableString(source.toolName),
          audience_session_keys_json: audienceSessionKeysJson,
          runtime_epoch: runtimeEpoch,
          created_at_ms: input.createdAtMs,
          expires_at_ms: input.expiresAtMs,
          updated_at_ms: input.createdAtMs,
          decision: null,
          terminal_reason: null,
          resolved_at_ms: null,
          resolver_kind: null,
          resolver_id: null,
          consumed_at_ms: null,
          consumed_by: null,
        })
        .onConflict((conflict) => conflict.column("approval_id").doNothing()),
    );
    const row = selectOperatorApprovalRow(database, id);
    if (!row) {
      throw new Error(`operator approval '${id}' was not readable after insert`);
    }
    const record = decodeOperatorApprovalRow(row);
    if (!record) {
      denyCorruptPendingRow({
        database,
        id,
        nowMs: input.createdAtMs,
        createdAtMs: row.created_at_ms,
      });
      return { outcome: "conflict" };
    }
    if (result.numAffectedRows === 1n) {
      if (executionIdentityBinding) {
        // sqlite-allow-raw -- feature-local additive schema DDL; binding rows use Kysely.
        database.db.exec(OPERATOR_APPROVAL_EXECUTION_IDENTITY_SCHEMA_SQL);
        executeSqliteQuerySync(
          database.db,
          stateDb.insertInto("operator_approval_execution_identities").values({
            approval_id: id,
            source_context_id: executionIdentityBinding.sourceContextId,
            source_execution_id: executionIdentityBinding.sourceExecutionId,
          }),
        );
      }
      return { outcome: "inserted", record };
    }
    if (!inputMatchesExistingRow(input, row, serialized)) {
      return { outcome: "conflict" };
    }
    if (executionIdentityBinding) {
      if (!tableExists(database.db, "operator_approval_execution_identities")) {
        return { outcome: "conflict" };
      }
      const existingBinding = executeSqliteQueryTakeFirstSync(
        database.db,
        stateDb
          .selectFrom("operator_approval_execution_identities")
          .select(["source_context_id", "source_execution_id"])
          .where("approval_id", "=", id),
      );
      if (
        existingBinding?.source_context_id !== executionIdentityBinding.sourceContextId ||
        existingBinding.source_execution_id !== executionIdentityBinding.sourceExecutionId
      ) {
        return { outcome: "conflict" };
      }
    }
    return { outcome: "existing", record };
  }, params.databaseOptions);
}

export function getOperatorApprovalDetailedInDatabase(
  params: Input<"operatorApprovals.get">,
): GetOperatorApprovalResult {
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

export function listPendingOperatorApprovalsInDatabase(
  params: Input<"operatorApprovals.pending"> = {},
): OperatorApprovalRecord[] {
  expireDueOperatorApprovalsInDatabase({
    nowMs: params.nowMs,
    databaseOptions: params.databaseOptions,
  });
  return runOpenClawStateWriteTransaction((database) => {
    const nowMs = params.nowMs ?? Date.now();
    const stateDb = getNodeSqliteKysely<OperatorApprovalDatabase>(database.db);
    const resultLimit = Math.max(
      1,
      Math.min(params.limit ?? 1_000, OPERATOR_APPROVAL_MAX_LIST_LIMIT),
    );
    const audienceSessionKey =
      params.audienceSessionKey === undefined
        ? undefined
        : requireString(params.audienceSessionKey, "operator approval audience session key");
    const requiresPostFilter =
      audienceSessionKey !== undefined || params.reviewerDeviceId !== undefined;
    const records: OperatorApprovalRecord[] = [];
    let cursor: { createdAtMs: number; id: string } | undefined;
    // Audience and reviewer bindings live in validated bounded JSON. Keyset-scan
    // first, then apply the limit so unrelated records cannot starve replay.
    while (records.length < resultLimit) {
      let query = stateDb
        .selectFrom("operator_approvals")
        .selectAll()
        .where("status", "=", "pending")
        .where("expires_at_ms", ">", nowMs)
        .orderBy("created_at_ms", "asc")
        .orderBy("approval_id", "asc")
        .limit(requiresPostFilter ? OPERATOR_APPROVAL_PENDING_SCAN_PAGE_SIZE : resultLimit);
      if (params.kind) {
        query = query.where("kind", "=", params.kind);
      }
      if (params.sourceSessionKey) {
        query = query.where("source_session_key", "=", params.sourceSessionKey);
      }
      if (cursor) {
        const pageCursor = cursor;
        query = query.where((eb) =>
          eb.or([
            eb("created_at_ms", ">", pageCursor.createdAtMs),
            eb.and([
              eb("created_at_ms", "=", pageCursor.createdAtMs),
              eb("approval_id", ">", pageCursor.id),
            ]),
          ]),
        );
      }
      const rows = executeSqliteQuerySync(database.db, query).rows;
      for (const row of rows) {
        const record = decodeOperatorApprovalRow(row);
        if (!record) {
          denyCorruptPendingRow({
            database,
            id: row.approval_id,
            nowMs,
            createdAtMs: row.created_at_ms,
          });
          continue;
        }
        const matchesAudience =
          !audienceSessionKey || record.audienceSessionKeys.includes(audienceSessionKey);
        const matchesReviewer =
          params.reviewerDeviceId === undefined ||
          matchesOperatorApprovalReviewerBinding(record, params.reviewerDeviceId);
        if (matchesAudience && matchesReviewer) {
          records.push(record);
          if (records.length === resultLimit) {
            break;
          }
        }
      }
      const last = rows.at(-1);
      if (!requiresPostFilter || rows.length < OPERATOR_APPROVAL_PENDING_SCAN_PAGE_SIZE || !last) {
        break;
      }
      cursor = { createdAtMs: last.created_at_ms, id: last.approval_id };
    }
    return records;
  }, params.databaseOptions);
}

export function listTerminalOperatorApprovalsInDatabase(
  params: ListTerminalOperatorApprovalsInput,
  db: DatabaseSync,
): ListTerminalOperatorApprovalsResult {
  const requestedLimit = Number.isSafeInteger(params.limit)
    ? (params.limit ?? OPERATOR_APPROVAL_HISTORY_DEFAULT_LIMIT)
    : OPERATOR_APPROVAL_HISTORY_DEFAULT_LIMIT;
  const resultLimit = Math.max(1, Math.min(requestedLimit, OPERATOR_APPROVAL_HISTORY_MAX_LIMIT));
  // Enforce the same 30-day retention the UI promises, independent of whether a
  // prune has run recently, so history can never surface rows past the window.
  const retentionCutoffMs = (params.nowMs ?? Date.now()) - OPERATOR_APPROVAL_TERMINAL_RETENTION_MS;
  let cursor =
    params.cursor === undefined ? undefined : decodeOperatorApprovalHistoryCursor(params.cursor);
  const database = { db };
  const stateDb = getNodeSqliteKysely<OperatorApprovalDatabase>(database.db);
  const records: OperatorApprovalRecord[] = [];
  const pageSize = resultLimit + 1;

  // Corrupt rows are skipped through the same decode-and-validate path used by
  // point lookups. Continue the keyset scan so one bad row cannot hide later
  // valid history.
  while (records.length < pageSize) {
    const batchLimit = pageSize - records.length;
    let query = stateDb
      .selectFrom("operator_approvals")
      .selectAll()
      .where("status", "!=", "pending")
      .where("resolved_at_ms", "is not", null)
      .where("resolved_at_ms", ">=", retentionCutoffMs)
      .orderBy("resolved_at_ms", "desc")
      .orderBy("approval_id", "desc")
      .limit(batchLimit);
    if (params.kind) {
      query = query.where("kind", "=", params.kind);
    }
    if (cursor) {
      const pageCursor = cursor;
      query = query.where((eb) =>
        eb.or([
          eb("resolved_at_ms", "<", pageCursor.resolvedAtMs),
          eb.and([
            eb("resolved_at_ms", "=", pageCursor.resolvedAtMs),
            eb("approval_id", "<", pageCursor.id),
          ]),
        ]),
      );
    }
    const rows = executeSqliteQuerySync(database.db, query).rows;
    for (const row of rows) {
      const record = decodeOperatorApprovalRow(row);
      if (record) {
        records.push(record);
      }
    }
    const last = rows.at(-1);
    if (rows.length < batchLimit || !last || last.resolved_at_ms === null) {
      break;
    }
    cursor = { resolvedAtMs: last.resolved_at_ms, id: last.approval_id };
  }

  const page = records.slice(0, resultLimit);
  const last = page.at(-1);
  return {
    records: page,
    ...(records.length > resultLimit && last && last.resolvedAtMs !== null
      ? {
          nextCursor: encodeOperatorApprovalHistoryCursor({
            resolvedAtMs: last.resolvedAtMs,
            id: last.id,
          }),
        }
      : {}),
  };
}
