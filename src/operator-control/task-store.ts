import { randomUUID } from "node:crypto";
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";
import { loadJsonFile, saveJsonFile } from "../infra/json-file.js";
import {
  OPERATOR_TASK_STATES,
  operatorExternalReceiptSchema,
  operatorTaskPatchSchema,
  outcomeRecordSchema,
  runReceiptSchema,
  taskEnvelopeSchema,
  validationReportSchema,
  type OperatorExternalReceipt,
  type OperatorOutcomeRecord,
  type OperatorRunReceipt,
  type OperatorTaskEnvelope,
  type OperatorTaskPatch,
  type OperatorTaskState,
  type OperatorValidationReport,
} from "./contracts.js";
import { resolveOperatorTaskEnvelope } from "./team-routing.js";

export type OperatorTaskEvent = {
  id: string;
  at: number;
  state: OperatorTaskState;
  note: string | null;
  owner: string | null;
  failureCode: string | null;
};

export type OperatorTaskRecord = {
  envelope: OperatorTaskEnvelope;
  receipt: OperatorRunReceipt;
  events: OperatorTaskEvent[];
  validation: OperatorValidationReport | null;
  outcome: OperatorOutcomeRecord | null;
};

type OperatorTaskStoreState = {
  version: 1;
  tasks: OperatorTaskRecord[];
};

export type OperatorTaskListFilters = {
  state?: OperatorTaskState | null;
  tier?: OperatorTaskEnvelope["tier"] | null;
  capability?: string | null;
  limit?: number;
};

const STORE_VERSION = 1 as const;
const TERMINAL_STATES = new Set<OperatorTaskState>(["completed", "dead-letter"]);
const TRANSITIONS: Record<OperatorTaskState, readonly OperatorTaskState[]> = {
  accepted: ["accepted", "queued", "blocked", "completed", "dead-letter"],
  queued: ["queued", "started", "retrying", "blocked", "completed", "dead-letter"],
  started: ["started", "retrying", "blocked", "completed", "dead-letter"],
  retrying: ["retrying", "queued", "started", "blocked", "completed", "dead-letter"],
  blocked: ["blocked", "queued", "started", "completed", "dead-letter"],
  completed: ["completed"],
  "dead-letter": ["dead-letter"],
};

function createDefaultStore(): OperatorTaskStoreState {
  return {
    version: STORE_VERSION,
    tasks: [],
  };
}

function resolveTaskStorePath(): string {
  return path.join(resolveStateDir(), "mission-control", "operator-control-tasks.json");
}

function loadStore(): OperatorTaskStoreState {
  const raw = loadJsonFile(resolveTaskStorePath());
  if (!raw || typeof raw !== "object" || !Array.isArray((raw as { tasks?: unknown }).tasks)) {
    return createDefaultStore();
  }
  const parsed = raw as OperatorTaskStoreState;
  return parsed.version === STORE_VERSION ? parsed : createDefaultStore();
}

function saveStore(store: OperatorTaskStoreState): void {
  saveJsonFile(resolveTaskStorePath(), store);
}

function createEvent(params: {
  state: OperatorTaskState;
  owner?: string | null;
  note?: string | null;
  failureCode?: string | null;
}): OperatorTaskEvent {
  return {
    id: randomUUID(),
    at: Date.now(),
    state: params.state,
    note: params.note?.trim() || null,
    owner: params.owner?.trim() || null,
    failureCode: params.failureCode?.trim() || null,
  };
}

function canTransition(from: OperatorTaskState, to: OperatorTaskState): boolean {
  return TRANSITIONS[from]?.includes(to) ?? false;
}

function normalizeTaskRecord(record: OperatorTaskRecord): OperatorTaskRecord {
  return {
    envelope: taskEnvelopeSchema.parse(record.envelope),
    receipt: runReceiptSchema.parse(record.receipt),
    events: Array.isArray(record.events)
      ? record.events.map((event) => ({
          id: typeof event.id === "string" && event.id.trim() ? event.id : randomUUID(),
          at:
            typeof event.at === "number" && Number.isFinite(event.at)
              ? Math.round(event.at)
              : Date.now(),
          state: OPERATOR_TASK_STATES.includes(event.state) ? event.state : "accepted",
          note: typeof event.note === "string" && event.note.trim() ? event.note.trim() : null,
          owner: typeof event.owner === "string" && event.owner.trim() ? event.owner.trim() : null,
          failureCode:
            typeof event.failureCode === "string" && event.failureCode.trim()
              ? event.failureCode.trim()
              : null,
        }))
      : [],
    validation: record.validation ? validationReportSchema.parse(record.validation) : null,
    outcome: record.outcome ? outcomeRecordSchema.parse(record.outcome) : null,
  };
}

function findExistingTask(
  store: OperatorTaskStoreState,
  envelope: OperatorTaskEnvelope,
): OperatorTaskRecord | null {
  const direct = store.tasks.find((task) => task.envelope.task_id === envelope.task_id);
  if (direct) {
    return normalizeTaskRecord(direct);
  }
  return (
    store.tasks.find(
      (task) =>
        task.envelope.idempotency_key === envelope.idempotency_key &&
        task.envelope.requester.id === envelope.requester.id &&
        task.envelope.target.capability === envelope.target.capability,
    ) ?? null
  );
}

function buildInitialTaskRecord(envelope: OperatorTaskEnvelope): OperatorTaskRecord {
  const now = Date.now();
  return {
    envelope,
    receipt: {
      schema: "RunReceiptV1",
      task_id: envelope.task_id,
      run_id: `task-${randomUUID()}`,
      state: "accepted",
      owner: envelope.requester.id,
      attempt: 0,
      created_at: now,
      updated_at: now,
      queue_latency_ms: null,
      execution: envelope.execution,
      artifacts: [],
      failure_code: null,
    },
    events: [
      createEvent({ state: "accepted", owner: envelope.requester.id, note: "task accepted" }),
    ],
    validation: null,
    outcome: null,
  };
}

export function submitOperatorTask(input: unknown): {
  created: boolean;
  task: OperatorTaskRecord;
} {
  const envelope = resolveOperatorTaskEnvelope(input);
  const store = loadStore();
  const existing = findExistingTask(store, envelope);
  if (existing) {
    return { created: false, task: normalizeTaskRecord(existing) };
  }
  const created = buildInitialTaskRecord(envelope);
  store.tasks.unshift(created);
  saveStore(store);
  return {
    created: true,
    task: created,
  };
}

export function listOperatorTasks(filters?: OperatorTaskListFilters): {
  tasks: OperatorTaskRecord[];
  summary: Record<OperatorTaskState, number>;
} {
  const store = loadStore();
  const limit = Math.min(200, Math.max(1, Math.round(filters?.limit ?? 50)));
  let tasks = store.tasks.map(normalizeTaskRecord);
  if (filters?.state) {
    tasks = tasks.filter((task) => task.receipt.state === filters.state);
  }
  if (filters?.tier) {
    tasks = tasks.filter((task) => task.envelope.tier === filters.tier);
  }
  if (filters?.capability?.trim()) {
    const needle = filters.capability.trim().toLowerCase();
    tasks = tasks.filter((task) => task.envelope.target.capability.toLowerCase() === needle);
  }
  const summary = Object.fromEntries(OPERATOR_TASK_STATES.map((state) => [state, 0])) as Record<
    OperatorTaskState,
    number
  >;
  for (const task of store.tasks) {
    const state = task.receipt.state;
    if (summary[state] !== undefined) {
      summary[state] += 1;
    }
  }
  return {
    tasks: tasks.slice(0, limit),
    summary,
  };
}

export function getOperatorTask(taskId: string): OperatorTaskRecord | null {
  const store = loadStore();
  const match = store.tasks.find((task) => task.envelope.task_id === taskId);
  return match ? normalizeTaskRecord(match) : null;
}

export function getOperatorTaskByRunId(runId: string): OperatorTaskRecord | null {
  const store = loadStore();
  const match = store.tasks.find((task) => task.receipt.run_id === runId);
  return match ? normalizeTaskRecord(match) : null;
}

export function patchOperatorTask(taskId: string, input: unknown): OperatorTaskRecord | null {
  const patch = operatorTaskPatchSchema.parse(input) satisfies OperatorTaskPatch;
  const store = loadStore();
  const index = store.tasks.findIndex((task) => task.envelope.task_id === taskId);
  if (index === -1) {
    return null;
  }
  const current = normalizeTaskRecord(store.tasks[index]);
  if (!canTransition(current.receipt.state, patch.state)) {
    throw new Error(`Invalid task transition: ${current.receipt.state} -> ${patch.state}`);
  }
  const nextAttempt =
    patch.state === "retrying" ? current.receipt.attempt + 1 : current.receipt.attempt;
  const nextReceipt: OperatorRunReceipt = {
    ...current.receipt,
    state: patch.state,
    owner: patch.owner ?? current.receipt.owner ?? null,
    updated_at: Date.now(),
    attempt: nextAttempt,
    queue_latency_ms:
      patch.queue_latency_ms !== undefined
        ? patch.queue_latency_ms
        : current.receipt.queue_latency_ms,
    artifacts: patch.artifacts ?? current.receipt.artifacts,
    failure_code: patch.failure_code ?? current.receipt.failure_code ?? null,
  };
  if (TERMINAL_STATES.has(patch.state) && !current.outcome && !patch.outcome) {
    nextReceipt.failure_code =
      patch.state === "dead-letter" ? (patch.failure_code ?? "dead-letter") : null;
  }
  const next: OperatorTaskRecord = {
    ...current,
    receipt: runReceiptSchema.parse(nextReceipt),
    events: [
      ...current.events,
      createEvent({
        state: patch.state,
        owner: nextReceipt.owner,
        note: patch.note ?? null,
        failureCode: nextReceipt.failure_code,
      }),
    ],
    validation: patch.validation
      ? validationReportSchema.parse(patch.validation)
      : current.validation,
    outcome: patch.outcome ? outcomeRecordSchema.parse(patch.outcome) : current.outcome,
  };
  store.tasks[index] = next;
  saveStore(store);
  return next;
}

export function applyOperatorExternalReceipt(
  taskId: string,
  input: unknown,
): OperatorTaskRecord | null {
  const receipt = operatorExternalReceiptSchema.parse(input) satisfies OperatorExternalReceipt;
  if (receipt.task_id !== taskId) {
    throw new Error(`receipt task_id mismatch: expected ${taskId}, received ${receipt.task_id}`);
  }
  const current = getOperatorTask(taskId);
  if (!current) {
    return null;
  }

  const noteParts = [receipt.summary?.trim() || null];
  const outputKeys = Object.keys(receipt.output ?? {});
  if (outputKeys.length > 0) {
    noteParts.push(`output keys: ${outputKeys.join(", ")}`);
  }

  const patch: OperatorTaskPatch = {
    state: receipt.state,
    owner:
      receipt.owner ??
      current.receipt.owner ??
      (receipt.schema === "AngelaTaskReceiptV1" ? "angela" : "2tony"),
    queue_latency_ms: receipt.queue_latency_ms ?? current.receipt.queue_latency_ms ?? null,
    artifacts: receipt.artifacts.length > 0 ? receipt.artifacts : current.receipt.artifacts,
    failure_code: receipt.failure_code ?? null,
    note: noteParts.filter((entry): entry is string => Boolean(entry)).join(" · ") || null,
  };

  if (receipt.state === "completed" || receipt.state === "dead-letter") {
    patch.outcome = {
      schema: "OutcomeRecordV1",
      task_id: current.envelope.task_id,
      run_id: current.receipt.run_id,
      outcome:
        receipt.result_status === "SUCCESS"
          ? "success"
          : receipt.state === "completed"
            ? "partial"
            : "fail",
      verification_status: "pending",
      rework_needed: receipt.result_status !== "SUCCESS",
      rework_reason: receipt.failure_code ?? receipt.summary ?? null,
      context_gap_detected: false,
      infrastructure_failure: receipt.state === "dead-letter",
      evidence_ref:
        typeof receipt.metadata?.evidence_ref === "string" && receipt.metadata.evidence_ref.trim()
          ? receipt.metadata.evidence_ref.trim()
          : null,
      recorded_at: receipt.updated_at,
    };
  }

  return patchOperatorTask(taskId, patch);
}

export function getOperatorTaskStorePath(): string {
  return resolveTaskStorePath();
}

export function getOperatorTaskStatusSummary(): {
  primaryOperator: "tonya";
  fallbackOperator: "tony";
  tasks: Record<OperatorTaskState, number>;
  totals: {
    total: number;
    terminal: number;
    active: number;
  };
} {
  const store = loadStore();
  const summary = Object.fromEntries(OPERATOR_TASK_STATES.map((state) => [state, 0])) as Record<
    OperatorTaskState,
    number
  >;
  const tasks = store.tasks.map(normalizeTaskRecord);
  for (const task of tasks) {
    const state = task.receipt.state;
    if (summary[state] !== undefined) {
      summary[state] += 1;
    }
  }
  const total = tasks.length;
  const terminal = tasks.filter((task) => TERMINAL_STATES.has(task.receipt.state)).length;
  return {
    primaryOperator: "tonya",
    fallbackOperator: "tony",
    tasks: summary,
    totals: {
      total,
      terminal,
      active: total - terminal,
    },
  };
}
