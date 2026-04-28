import type { TaskRecord } from "./task-registry.types.js";

export type TaskAuditSeverity = "warn" | "error";
export type TaskAuditCode =
  | "stale_queued"
  | "stale_running"
  | "stale_awaiting_approval"
  | "stale_waiting_external"
  | "lost"
  | "delivery_failed"
  | "missing_cleanup"
  | "inconsistent_timestamps";

export type TaskAuditFinding = {
  severity: TaskAuditSeverity;
  code: TaskAuditCode;
  task: TaskRecord;
  ageMs?: number;
  detail: string;
};

export type TaskAuditSummary = {
  total: number;
  warnings: number;
  errors: number;
  byCode: Record<TaskAuditCode, number>;
};

export function createEmptyTaskAuditSummary(): TaskAuditSummary {
  return {
    total: 0,
    warnings: 0,
    errors: 0,
    byCode: {
      stale_queued: 0,
      stale_running: 0,
      stale_awaiting_approval: 0,
      stale_waiting_external: 0,
      lost: 0,
      delivery_failed: 0,
      missing_cleanup: 0,
      inconsistent_timestamps: 0,
    },
  };
}
