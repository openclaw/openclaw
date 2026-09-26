/** Static owner-native cron lifecycle projection for run inspection. */
import type { DatabaseSync } from "node:sqlite";
import type {
  DecisionReceiptV1,
  ExecutionIdentityContextV1,
} from "../../packages/gateway-protocol/src/index.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../infra/kysely-sync.js";
import { runSqliteDeferredTransactionSync } from "../infra/sqlite-transaction.js";
import type { DB as OpenClawStateDatabase } from "../state/openclaw-state-db.generated.js";
import { EXECUTION_OWNER_LIFECYCLE_BINDING_TABLE } from "./execution-owner-lifecycle-binding-store.js";

type WithSqliteRowId<Row> = Row & { rowid: number };
type OwnerLifecycleDatabase = {
  cron_run_receipts: WithSqliteRowId<OpenClawStateDatabase["cron_run_receipts"]>;
  execution_owner_lifecycle_bindings: OpenClawStateDatabase["execution_owner_lifecycle_bindings"];
};
/** Captured by the connection read-open/admission owner, never discovered while paging. */
export type OwnerLifecycleSchemaFacts = Readonly<{
  cronRunReceipts: boolean;
  executionOwnerLifecycleBindings: boolean;
}>;
export type OwnerLifecycleCursor = { occurredAt: number; rowId: number };
type OwnerLifecycleReceiptEntry = {
  receipt: DecisionReceiptV1;
  selectorId: string;
  displayProducer: "cron-lifecycle";
};
type OwnerLifecycleRow = {
  executionId: string | null;
  occurredAt: number;
  recordId: string;
  rowId: number;
  status: string;
};

const KNOWN_STATUSES = new Set(["running", "ok", "error", "skipped", "interrupted", "superseded"]);
const OWNER_LIFECYCLE_CURSOR_RETAINED_ERROR = "owner lifecycle cursor is no longer retained";

function assertRetainedCursor(params: {
  db: DatabaseSync;
  contextId: string;
  executionId: string;
  after?: OwnerLifecycleCursor;
}): void {
  if (!params.after) {
    return;
  }
  const kysely = getNodeSqliteKysely<OwnerLifecycleDatabase>(params.db);
  const ownerQuery = kysely
    .selectFrom("cron_run_receipts")
    .select("receipt_id as ownerId")
    .where("rowid", "=", params.after.rowId)
    .where("started_at_ms", "=", params.after.occurredAt);
  const owner = executeSqliteQueryTakeFirstSync(params.db, ownerQuery);
  // Admission binds at most one cron owner to an execution. The exact execution
  // match therefore rejects a different owner reusing this rowid.
  const binding = owner
    ? executeSqliteQueryTakeFirstSync(
        params.db,
        kysely
          .selectFrom(EXECUTION_OWNER_LIFECYCLE_BINDING_TABLE)
          .select("owner_id")
          .where("owner_kind", "=", "cron")
          .where("owner_id", "=", owner.ownerId)
          .where("context_id", "=", params.contextId)
          .where("execution_id", "=", params.executionId),
      )
    : undefined;
  if (!binding) {
    throw new Error(OWNER_LIFECYCLE_CURSOR_RETAINED_ERROR);
  }
}

function readRows(params: {
  db: DatabaseSync;
  schema: OwnerLifecycleSchemaFacts;
  contextId: string;
  executionId: string;
  after?: OwnerLifecycleCursor;
  offset?: number;
  limit: number;
}): OwnerLifecycleRow[] {
  if (!params.schema.cronRunReceipts || !params.schema.executionOwnerLifecycleBindings) {
    if (params.after) {
      throw new Error(OWNER_LIFECYCLE_CURSOR_RETAINED_ERROR);
    }
    return [];
  }
  assertRetainedCursor(params);
  const kysely = getNodeSqliteKysely<OwnerLifecycleDatabase>(params.db);
  let query = kysely
    .selectFrom("cron_run_receipts")
    .innerJoin(EXECUTION_OWNER_LIFECYCLE_BINDING_TABLE, (join) =>
      join
        .onRef("execution_owner_lifecycle_bindings.owner_id", "=", "cron_run_receipts.receipt_id")
        .on("execution_owner_lifecycle_bindings.owner_kind", "=", "cron"),
    )
    .select([
      "cron_run_receipts.receipt_id as recordId",
      "execution_owner_lifecycle_bindings.execution_id as executionId",
      "cron_run_receipts.started_at_ms as occurredAt",
      "cron_run_receipts.status",
      "cron_run_receipts.rowid as rowId",
    ])
    .where("execution_owner_lifecycle_bindings.context_id", "=", params.contextId)
    .orderBy("cron_run_receipts.started_at_ms", "asc")
    .orderBy("cron_run_receipts.rowid", "asc")
    .limit(params.limit);
  if (params.after) {
    query = query.where((eb) =>
      eb.or([
        eb("cron_run_receipts.started_at_ms", ">", params.after!.occurredAt),
        eb.and([
          eb("cron_run_receipts.started_at_ms", "=", params.after!.occurredAt),
          eb("cron_run_receipts.rowid", ">", params.after!.rowId),
        ]),
      ]),
    );
  } else if (params.offset) {
    query = query.offset(params.offset);
  }
  return executeSqliteQuerySync(params.db, query).rows;
}

function countRows(params: {
  db: DatabaseSync;
  schema: OwnerLifecycleSchemaFacts;
  contextId: string;
  executionId?: string;
}): number {
  if (!params.schema.cronRunReceipts || !params.schema.executionOwnerLifecycleBindings) {
    return 0;
  }
  const kysely = getNodeSqliteKysely<OwnerLifecycleDatabase>(params.db);
  const query = kysely
    .selectFrom("cron_run_receipts")
    .innerJoin(EXECUTION_OWNER_LIFECYCLE_BINDING_TABLE, (join) =>
      join
        .onRef("execution_owner_lifecycle_bindings.owner_id", "=", "cron_run_receipts.receipt_id")
        .on("execution_owner_lifecycle_bindings.owner_kind", "=", "cron"),
    )
    .select((eb) => eb.fn.countAll<number>().as("count"))
    .where("execution_owner_lifecycle_bindings.context_id", "=", params.contextId)
    .$if(params.executionId !== undefined, (qb) =>
      qb.where("execution_owner_lifecycle_bindings.execution_id", "=", params.executionId!),
    );
  return executeSqliteQueryTakeFirstSync(params.db, query)?.count ?? 0;
}

function projectReceipt(
  row: OwnerLifecycleRow,
  context: ExecutionIdentityContextV1,
): DecisionReceiptV1 {
  const exact = row.executionId === context.executionId;
  const known = KNOWN_STATUSES.has(row.status);
  const valid = exact && known;
  const missingEvidence = valid
    ? []
    : [exact ? "decision.cron_owner_status" : "decision.execution_link"];
  return {
    schemaVersion: 1,
    receiptId: `cron:${row.recordId}`,
    contextId: context.contextId,
    executionId: context.executionId,
    runId: context.runId,
    actionId: row.recordId,
    occurredAt: row.occurredAt,
    action: {
      family: "scheduled-run",
      operation: "lifecycle",
      summary: valid
        ? `Scheduled run lifecycle: ${row.status.replaceAll("_", "-")}.`
        : "Owner lifecycle evidence could not be matched exactly.",
    },
    decision: {
      outcome: valid ? "not-applicable" : "unknown",
      reasonCode: valid
        ? `cron_run_${row.status}`
        : exact
          ? "cron_run_status_unknown"
          : "cron_run_execution_link_mismatch",
    },
    enforcement: {
      coverageState: valid ? "attribution-only" : "unknown",
      evaluatorRef: "cron-lifecycle-owner",
      policyRefs: [],
      grantRefs: [],
      contextFieldsUsed: ["contextId", "executionId"],
    },
    source: {
      owner: "cron_run_receipts",
      recordRef: row.recordId,
      decisionBoundary: "cron.run.lifecycle",
    },
    missingEvidence,
    remediation: valid
      ? []
      : [
          {
            code: "inspect_owner_execution_binding",
            text: "Inspect the owner row and its exact admission binding before drawing a lifecycle conclusion.",
          },
        ],
  };
}

export function summarizeOwnerLifecycleReceiptsInDatabase(
  db: DatabaseSync,
  params: {
    schema: OwnerLifecycleSchemaFacts;
    context: ExecutionIdentityContextV1;
  },
): { count: number; coverageState?: "attribution-only" | "unknown"; missingEvidence: string[] } {
  const count = countRows({ db, schema: params.schema, contextId: params.context.contextId });
  const exactCount = countRows({
    db,
    schema: params.schema,
    contextId: params.context.contextId,
    executionId: params.context.executionId,
  });
  const mismatch = count !== exactCount;
  return {
    count,
    ...(count > 0
      ? { coverageState: mismatch ? ("unknown" as const) : ("attribution-only" as const) }
      : {}),
    missingEvidence: mismatch ? ["decision.execution_link"] : [],
  };
}

export function pageOwnerLifecycleReceiptsInDatabase(
  db: DatabaseSync,
  params: {
    schema: OwnerLifecycleSchemaFacts;
    context: ExecutionIdentityContextV1;
    after?: OwnerLifecycleCursor;
    offset?: number;
    limit: number;
  },
): { entries: OwnerLifecycleReceiptEntry[]; nextCursor?: OwnerLifecycleCursor } {
  const rows = runSqliteDeferredTransactionSync(
    db,
    () =>
      readRows({
        db,
        schema: params.schema,
        contextId: params.context.contextId,
        executionId: params.context.executionId,
        after: params.after,
        offset: params.offset,
        limit: params.limit + 1,
      }),
    { operationLabel: "owner lifecycle receipt page" },
  );
  const hasMore = rows.length > params.limit;
  const page = hasMore ? rows.slice(0, params.limit) : rows;
  const last = page.at(-1);
  return {
    entries: page.map((row) => ({
      receipt: projectReceipt(row, params.context),
      selectorId: `cron-lifecycle:${row.occurredAt}:${row.rowId}`,
      displayProducer: "cron-lifecycle",
    })),
    ...(hasMore && last ? { nextCursor: { occurredAt: last.occurredAt, rowId: last.rowId } } : {}),
  };
}
