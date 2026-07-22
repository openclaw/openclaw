import type { Insertable, Selectable } from "kysely";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../infra/kysely-sync.js";
import { redactSensitiveText } from "../logging/redact.js";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
// Persists monotonic machine evidence for detached task execution and supervision.
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";
import { sanitizeTaskStatusText } from "./task-status.js";

const TASK_EXECUTION_RECEIPT_KINDS = [
  "heartbeat",
  "tool_call",
  "branch",
  "diff",
  "commit",
  "tests",
  "pr",
  "deploy",
  "canary",
  "readback",
  "relay_health",
  "connector_health",
] as const;

export type TaskExecutionReceiptKind = (typeof TASK_EXECUTION_RECEIPT_KINDS)[number];
export type TaskExecutionReceiptStatus = "ok" | "error";

export type TaskExecutionReceipt = {
  taskId: string;
  sequence: number;
  kind: TaskExecutionReceiptKind;
  status: TaskExecutionReceiptStatus;
  recordedAt: number;
  summary?: string;
  detail?: Record<string, unknown>;
};

type TaskExecutionReceiptsTable = OpenClawStateKyselyDatabase["task_execution_receipts"];
type TaskExecutionReceiptDatabase = Pick<
  OpenClawStateKyselyDatabase,
  "task_execution_receipts" | "task_runs"
>;
type ReceiptRow = Selectable<TaskExecutionReceiptsTable>;

function redactReceiptDetailValue(value: unknown): unknown {
  if (typeof value === "string") {
    return redactSensitiveText(value, { mode: "tools" });
  }
  if (Array.isArray(value)) {
    return value.map(redactReceiptDetailValue);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, nestedValue]) => [
        key,
        redactReceiptDetailValue(nestedValue),
      ]),
    );
  }
  return value;
}

function redactReceiptDetail(detail: Record<string, unknown>): Record<string, unknown> {
  const recursivelyRedacted = redactReceiptDetailValue(detail);
  const redactedJson = redactSensitiveText(JSON.stringify(recursivelyRedacted), { mode: "tools" });
  const parsed = JSON.parse(redactedJson) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Task execution receipt detail must remain a JSON object after redaction");
  }
  return parsed as Record<string, unknown>;
}

function parseReceiptRow(row: ReceiptRow): TaskExecutionReceipt {
  const kind = TASK_EXECUTION_RECEIPT_KINDS.find((value) => value === row.kind);
  if (!kind || (row.status !== "ok" && row.status !== "error")) {
    throw new Error(`Invalid task execution receipt ${row.task_id}:${row.sequence}`);
  }
  let detail: Record<string, unknown> | undefined;
  if (row.detail_json) {
    const parsed = JSON.parse(row.detail_json) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      detail = parsed as Record<string, unknown>;
    }
  }
  return {
    taskId: row.task_id,
    sequence: row.sequence,
    kind,
    status: row.status,
    recordedAt: row.recorded_at,
    ...(row.summary ? { summary: row.summary } : {}),
    ...(detail ? { detail } : {}),
  };
}

/** Appends one receipt under an immediate transaction so sequence never forks. */
export function recordTaskExecutionReceipt(params: {
  taskId: string;
  kind: TaskExecutionReceiptKind;
  status: TaskExecutionReceiptStatus;
  recordedAt?: number;
  summary?: string;
  detail?: Record<string, unknown>;
}): TaskExecutionReceipt {
  const taskId = params.taskId.trim();
  if (!taskId) {
    throw new Error("Task execution receipt requires taskId");
  }
  const recordedAt = params.recordedAt ?? Date.now();
  const summary = redactSensitiveText(
    sanitizeTaskStatusText(params.summary, {
      errorContext: params.status === "error",
    }),
    { mode: "tools" },
  );
  const detail = params.detail === undefined ? undefined : redactReceiptDetail(params.detail);
  const detailJson = detail === undefined ? null : JSON.stringify(detail);
  return runOpenClawStateWriteTransaction(
    ({ db }) => {
      const kysely = getNodeSqliteKysely<TaskExecutionReceiptDatabase>(db);
      const task = executeSqliteQueryTakeFirstSync(
        db,
        kysely.selectFrom("task_runs").select("task_id").where("task_id", "=", taskId),
      );
      if (!task) {
        throw new Error(`Task execution receipt references missing task: ${taskId}`);
      }
      const current = executeSqliteQueryTakeFirstSync(
        db,
        kysely
          .selectFrom("task_execution_receipts")
          .select((eb) => eb.fn.max<number>("sequence").as("sequence"))
          .where("task_id", "=", taskId),
      );
      const sequence = (current?.sequence ?? 0) + 1;
      const row: Insertable<TaskExecutionReceiptsTable> = {
        task_id: taskId,
        sequence,
        kind: params.kind,
        status: params.status,
        recorded_at: recordedAt,
        summary: summary || null,
        detail_json: detailJson,
      };
      executeSqliteQuerySync(db, kysely.insertInto("task_execution_receipts").values(row));
      return {
        taskId,
        sequence,
        kind: params.kind,
        status: params.status,
        recordedAt,
        ...(summary ? { summary } : {}),
        ...(detail ? { detail: structuredClone(detail) } : {}),
      };
    },
    {},
    { operationLabel: "task.execution-receipt.append" },
  );
}

export function listTaskExecutionReceipts(taskIdInput: string): TaskExecutionReceipt[] {
  const taskId = taskIdInput.trim();
  if (!taskId) {
    return [];
  }
  const { db } = openOpenClawStateDatabase();
  const kysely = getNodeSqliteKysely<TaskExecutionReceiptDatabase>(db);
  const rows = executeSqliteQuerySync(
    db,
    kysely
      .selectFrom("task_execution_receipts")
      .selectAll()
      .where("task_id", "=", taskId)
      .orderBy("sequence", "asc"),
  ).rows;
  return rows.map(parseReceiptRow);
}

export type TaskExecutionGate = "healthy" | "running_code" | "built" | "delivered" | "green";

/** Fail-closed machine gate; later health receipts supersede older failures. */
export function evaluateTaskExecutionGate(params: {
  taskId: string;
  gate: TaskExecutionGate;
  now?: number;
  supervisionPeriodMs?: number;
}): { ok: boolean; missing: string[] } {
  const receipts = listTaskExecutionReceipts(params.taskId);
  const latest = new Map<TaskExecutionReceiptKind, TaskExecutionReceipt>();
  for (const receipt of receipts) {
    latest.set(receipt.kind, receipt);
  }
  const missing: string[] = [];
  const requireOk = (kind: TaskExecutionReceiptKind) => {
    if (latest.get(kind)?.status !== "ok") {
      missing.push(kind);
    }
  };
  if (
    params.gate === "running_code" ||
    params.gate === "built" ||
    params.gate === "delivered" ||
    params.gate === "green"
  ) {
    requireOk("branch");
    const diff = latest.get("diff");
    if (diff?.status !== "ok" || diff.detail?.readable !== true) {
      missing.push("readable_diff");
    }
  }
  if (params.gate === "built" || params.gate === "delivered" || params.gate === "green") {
    requireOk("commit");
    requireOk("tests");
  }
  if (params.gate === "delivered" || params.gate === "green") {
    requireOk("pr");
  }
  if (params.gate === "healthy" || params.gate === "green") {
    requireOk("relay_health");
    requireOk("connector_health");
    const heartbeat = latest.get("heartbeat");
    const period = params.supervisionPeriodMs ?? 60_000;
    if (heartbeat?.status !== "ok" || (params.now ?? Date.now()) - heartbeat.recordedAt > period) {
      missing.push("fresh_heartbeat");
    }
  }
  if (params.gate === "green") {
    requireOk("deploy");
    requireOk("canary");
    requireOk("readback");
  }
  return { ok: missing.length === 0, missing };
}
