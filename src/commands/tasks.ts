import { loadConfig } from "../config/config.js";
import { info } from "../globals.js";
import type { RuntimeEnv } from "../runtime.js";
import {
  listTaskAuditFindings,
  summarizeTaskAuditFindings,
  type TaskAuditCode,
  type TaskAuditFinding,
  type TaskAuditSeverity,
} from "../tasks/task-registry.audit.js";
import { cancelTaskById, getTaskById, updateTaskNotifyPolicyById } from "../tasks/task-registry.js";
import {
  reconcileInspectableTasks,
  reconcileTaskLookupToken,
} from "../tasks/task-registry.reconcile.js";
import { summarizeTaskRecords } from "../tasks/task-registry.summary.js";
import type { TaskNotifyPolicy, TaskRecord } from "../tasks/task-registry.types.js";
import { isRich, theme } from "../terminal/theme.js";

const RUNTIME_PAD = 8;
const STATUS_PAD = 10;
const DELIVERY_PAD = 14;
const ID_PAD = 10;
const RUN_PAD = 10;

function truncate(value: string, maxChars: number) {
  if (value.length <= maxChars) {
    return value;
  }
  if (maxChars <= 1) {
    return value.slice(0, maxChars);
  }
  return `${value.slice(0, maxChars - 1)}…`;
}

function shortToken(value: string | undefined, maxChars = ID_PAD): string {
  const trimmed = value?.trim();
  if (!trimmed) {
    return "n/a";
  }
  return truncate(trimmed, maxChars);
}

function formatTaskStatusCell(status: string, rich: boolean) {
  const padded = status.padEnd(STATUS_PAD);
  if (!rich) {
    return padded;
  }
  if (status === "succeeded") {
    return theme.success(padded);
  }
  if (status === "failed" || status === "lost" || status === "timed_out") {
    return theme.error(padded);
  }
  if (status === "running") {
    return theme.accentBright(padded);
  }
  return theme.muted(padded);
}

function formatTaskRows(tasks: TaskRecord[], rich: boolean) {
  const header = [
    "Task".padEnd(ID_PAD),
    "Kind".padEnd(RUNTIME_PAD),
    "Status".padEnd(STATUS_PAD),
    "Delivery".padEnd(DELIVERY_PAD),
    "Run".padEnd(RUN_PAD),
    "Child Session",
    "Summary",
  ].join(" ");
  const lines = [rich ? theme.heading(header) : header];
  for (const task of tasks) {
    const summary = truncate(
      task.terminalSummary?.trim() ||
        task.progressSummary?.trim() ||
        task.label?.trim() ||
        task.task.trim(),
      80,
    );
    const line = [
      shortToken(task.taskId).padEnd(ID_PAD),
      task.runtime.padEnd(RUNTIME_PAD),
      formatTaskStatusCell(task.status, rich),
      task.deliveryStatus.padEnd(DELIVERY_PAD),
      shortToken(task.runId, RUN_PAD).padEnd(RUN_PAD),
      truncate(task.childSessionKey?.trim() || "n/a", 36).padEnd(36),
      summary,
    ].join(" ");
    lines.push(line.trimEnd());
  }
  return lines;
}

function formatTaskListSummary(tasks: TaskRecord[]) {
  const summary = summarizeTaskRecords(tasks);
  return `${summary.byStatus.queued} queued · ${summary.byStatus.running} running · ${summary.failures} issues`;
}

function formatAgeMs(ageMs: number | undefined): string {
  if (typeof ageMs !== "number" || ageMs < 1000) {
    return "fresh";
  }
  const totalSeconds = Math.floor(ageMs / 1000);
  const days = Math.floor(totalSeconds / 86_400);
  const hours = Math.floor((totalSeconds % 86_400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  if (days > 0) {
    return `${days}d${hours}h`;
  }
  if (hours > 0) {
    return `${hours}h${minutes}m`;
  }
  if (minutes > 0) {
    return `${minutes}m`;
  }
  return `${totalSeconds}s`;
}

function formatAuditRows(findings: TaskAuditFinding[], rich: boolean) {
  const header = [
    "Severity".padEnd(8),
    "Code".padEnd(22),
    "Task".padEnd(ID_PAD),
    "Status".padEnd(STATUS_PAD),
    "Age".padEnd(8),
    "Detail",
  ].join(" ");
  const lines = [rich ? theme.heading(header) : header];
  for (const finding of findings) {
    const severity = finding.severity.padEnd(8);
    const status = formatTaskStatusCell(finding.task.status, rich);
    const severityCell = !rich
      ? severity
      : finding.severity === "error"
        ? theme.error(severity)
        : theme.warn(severity);
    lines.push(
      [
        severityCell,
        finding.code.padEnd(22),
        shortToken(finding.task.taskId).padEnd(ID_PAD),
        status,
        formatAgeMs(finding.ageMs).padEnd(8),
        truncate(finding.detail, 88),
      ]
        .join(" ")
        .trimEnd(),
    );
  }
  return lines;
}

export async function tasksListCommand(
  opts: { json?: boolean; runtime?: string; status?: string },
  runtime: RuntimeEnv,
) {
  const runtimeFilter = opts.runtime?.trim();
  const statusFilter = opts.status?.trim();
  const tasks = reconcileInspectableTasks().filter((task) => {
    if (runtimeFilter && task.runtime !== runtimeFilter) {
      return false;
    }
    if (statusFilter && task.status !== statusFilter) {
      return false;
    }
    return true;
  });

  if (opts.json) {
    runtime.log(
      JSON.stringify(
        {
          count: tasks.length,
          runtime: runtimeFilter ?? null,
          status: statusFilter ?? null,
          tasks,
        },
        null,
        2,
      ),
    );
    return;
  }

  runtime.log(info(`Background tasks: ${tasks.length}`));
  runtime.log(info(`Task pressure: ${formatTaskListSummary(tasks)}`));
  if (runtimeFilter) {
    runtime.log(info(`Runtime filter: ${runtimeFilter}`));
  }
  if (statusFilter) {
    runtime.log(info(`Status filter: ${statusFilter}`));
  }
  if (tasks.length === 0) {
    runtime.log("No background tasks found.");
    return;
  }
  const rich = isRich();
  for (const line of formatTaskRows(tasks, rich)) {
    runtime.log(line);
  }
}

export async function tasksShowCommand(
  opts: { json?: boolean; lookup: string },
  runtime: RuntimeEnv,
) {
  const task = reconcileTaskLookupToken(opts.lookup);
  if (!task) {
    runtime.error(`Task not found: ${opts.lookup}`);
    runtime.exit(1);
    return;
  }

  if (opts.json) {
    runtime.log(JSON.stringify(task, null, 2));
    return;
  }

  const lines = [
    "Background task:",
    `taskId: ${task.taskId}`,
    `kind: ${task.runtime}`,
    `sourceId: ${task.sourceId ?? "n/a"}`,
    `status: ${task.status}`,
    `result: ${task.terminalOutcome ?? "n/a"}`,
    `delivery: ${task.deliveryStatus}`,
    `notify: ${task.notifyPolicy}`,
    `requesterSessionKey: ${task.requesterSessionKey}`,
    `childSessionKey: ${task.childSessionKey ?? "n/a"}`,
    `parentTaskId: ${task.parentTaskId ?? "n/a"}`,
    `agentId: ${task.agentId ?? "n/a"}`,
    `runId: ${task.runId ?? "n/a"}`,
    `label: ${task.label ?? "n/a"}`,
    `task: ${task.task}`,
    `createdAt: ${new Date(task.createdAt).toISOString()}`,
    `startedAt: ${task.startedAt ? new Date(task.startedAt).toISOString() : "n/a"}`,
    `endedAt: ${task.endedAt ? new Date(task.endedAt).toISOString() : "n/a"}`,
    `lastEventAt: ${task.lastEventAt ? new Date(task.lastEventAt).toISOString() : "n/a"}`,
    `cleanupAfter: ${task.cleanupAfter ? new Date(task.cleanupAfter).toISOString() : "n/a"}`,
    ...(task.error ? [`error: ${task.error}`] : []),
    ...(task.progressSummary ? [`progressSummary: ${task.progressSummary}`] : []),
    ...(task.terminalSummary ? [`terminalSummary: ${task.terminalSummary}`] : []),
    ...(task.recentEvents?.length
      ? task.recentEvents.map(
          (event, index) =>
            `recentEvent[${index}]: ${new Date(event.at).toISOString()} ${event.kind}${
              event.summary ? ` ${event.summary}` : ""
            }`,
        )
      : []),
  ];
  for (const line of lines) {
    runtime.log(line);
  }
}

export async function tasksNotifyCommand(
  opts: { lookup: string; notify: TaskNotifyPolicy },
  runtime: RuntimeEnv,
) {
  const task = reconcileTaskLookupToken(opts.lookup);
  if (!task) {
    runtime.error(`Task not found: ${opts.lookup}`);
    runtime.exit(1);
    return;
  }
  const updated = updateTaskNotifyPolicyById({
    taskId: task.taskId,
    notifyPolicy: opts.notify,
  });
  if (!updated) {
    runtime.error(`Task not found: ${opts.lookup}`);
    runtime.exit(1);
    return;
  }
  runtime.log(`Updated ${updated.taskId} notify policy to ${updated.notifyPolicy}.`);
}

export async function tasksCancelCommand(opts: { lookup: string }, runtime: RuntimeEnv) {
  const task = reconcileTaskLookupToken(opts.lookup);
  if (!task) {
    runtime.error(`Task not found: ${opts.lookup}`);
    runtime.exit(1);
    return;
  }
  const result = await cancelTaskById({
    cfg: loadConfig(),
    taskId: task.taskId,
  });
  if (!result.found) {
    runtime.error(result.reason ?? `Task not found: ${opts.lookup}`);
    runtime.exit(1);
    return;
  }
  if (!result.cancelled) {
    runtime.error(result.reason ?? `Could not cancel task: ${opts.lookup}`);
    runtime.exit(1);
    return;
  }
  const updated = getTaskById(task.taskId);
  runtime.log(
    `Cancelled ${updated?.taskId ?? task.taskId} (${updated?.runtime ?? task.runtime})${updated?.runId ? ` run ${updated.runId}` : ""}.`,
  );
}

export async function tasksAuditCommand(
  opts: {
    json?: boolean;
    severity?: TaskAuditSeverity;
    code?: TaskAuditCode;
    limit?: number;
  },
  runtime: RuntimeEnv,
) {
  const severityFilter = opts.severity?.trim() as TaskAuditSeverity | undefined;
  const codeFilter = opts.code?.trim() as TaskAuditCode | undefined;
  const findings = listTaskAuditFindings().filter((finding) => {
    if (severityFilter && finding.severity !== severityFilter) {
      return false;
    }
    if (codeFilter && finding.code !== codeFilter) {
      return false;
    }
    return true;
  });
  const limit = typeof opts.limit === "number" && opts.limit > 0 ? opts.limit : undefined;
  const displayed = limit ? findings.slice(0, limit) : findings;
  const summary = summarizeTaskAuditFindings(findings);

  if (opts.json) {
    runtime.log(
      JSON.stringify(
        {
          count: findings.length,
          displayed: displayed.length,
          filters: {
            severity: severityFilter ?? null,
            code: codeFilter ?? null,
            limit: limit ?? null,
          },
          summary,
          findings: displayed,
        },
        null,
        2,
      ),
    );
    return;
  }

  runtime.log(
    info(
      `Task audit: ${summary.total} findings · ${summary.errors} errors · ${summary.warnings} warnings`,
    ),
  );
  if (severityFilter) {
    runtime.log(info(`Severity filter: ${severityFilter}`));
  }
  if (codeFilter) {
    runtime.log(info(`Code filter: ${codeFilter}`));
  }
  if (limit) {
    runtime.log(info(`Limit: ${limit}`));
  }
  if (displayed.length === 0) {
    runtime.log("No task audit findings.");
    return;
  }
  const rich = isRich();
  for (const line of formatAuditRows(displayed, rich)) {
    runtime.log(line);
  }
}
