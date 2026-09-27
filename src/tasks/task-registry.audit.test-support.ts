import {
  listTaskAuditFindings,
  summarizeRetainedLostTaskAuditFindings,
  summarizeTaskAuditFindings,
} from "./task-registry.audit.js";
import { summarizeTaskRecords, type TaskStatusSummary } from "./task-registry.summary.js";
import type { TaskRecord } from "./task-registry.types.js";

/** Reference projection from full inspection, independent of streamed summary accumulation. */
export function summarizeFullTaskInspection(tasks: TaskRecord[], now: number): TaskStatusSummary {
  const findings = listTaskAuditFindings({ tasks, now });
  const taskAudit = summarizeTaskAuditFindings(findings);
  const taskAuditRetainedLost = summarizeRetainedLostTaskAuditFindings(findings, { now });
  const taskSummary = summarizeTaskRecords(tasks);
  taskSummary.failures -= taskAuditRetainedLost.count;
  taskAudit.total -= taskAuditRetainedLost.count;
  taskAudit.warnings -= taskAuditRetainedLost.count;
  taskAudit.byCode.lost -= taskAuditRetainedLost.count;
  return { tasks: taskSummary, taskAudit, taskAuditRetainedLost };
}
