import { getRuntimeConfig } from "../config/config.js";
import { resolveCronStorePath } from "../cron/store.js";
import { writeRuntimeJson, type RuntimeEnv } from "../runtime.js";
import { normalizeOptionalString } from "../shared/string-coerce.js";
import { classifyActionRequest } from "../tasks/decision-policy.js";
import {
  listWorkRoutingExplanations,
  summarizeDurableRunFromArtifacts,
} from "../tasks/durable-work-supervision.js";
import {
  loadPendingDecisionQueue,
  projectAllowedActionRecord,
  projectPendingDecisionRecord,
  registerAllowedActionAudit,
  registerPendingDecision,
} from "../tasks/pending-decision-queue.js";
import { buildPhoneControlReply } from "../tasks/phone-reply.js";
import { getTaskById, updateTaskNotifyPolicyById } from "../tasks/runtime-internal.js";
import {
  blockSafeTask,
  completeSafeTask,
  findSafeTask,
  loadSafeTaskIndex,
  projectSafeTaskIndex,
  projectSafeTaskRecord,
  type SafeTaskRisk,
  SAFE_TASK_RISKS,
  upsertSafeTask,
} from "../tasks/safe-task-index.js";
import { cancelDetachedTaskRunById } from "../tasks/task-executor.js";
import {
  listTaskFlowAuditFindings,
  summarizeTaskFlowAuditFindings,
  type TaskFlowAuditCode,
  type TaskFlowAuditSeverity,
} from "../tasks/task-flow-registry.audit.js";
import {
  getInspectableTaskFlowAuditSummary,
  previewTaskFlowRegistryMaintenance,
  runTaskFlowRegistryMaintenance,
} from "../tasks/task-flow-registry.maintenance.js";
import type { TaskFlowRecord } from "../tasks/task-flow-registry.types.js";
import {
  listTaskAuditFindings,
  summarizeTaskAuditFindings,
  type TaskAuditCode,
  type TaskAuditSeverity,
} from "../tasks/task-registry.audit.js";
import { compareTaskAuditFindingSortKeys } from "../tasks/task-registry.audit.shared.js";
import {
  getInspectableTaskAuditSummary,
  getInspectableTaskRegistrySummary,
  configureTaskRegistryMaintenance,
  previewTaskRegistryMaintenance,
  runTaskRegistryMaintenance,
} from "../tasks/task-registry.maintenance.js";
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

const info = theme.info;

async function loadTaskCancelConfig() {
  return getRuntimeConfig();
}

function configureTaskMaintenanceFromConfig(): void {
  const cfg = getRuntimeConfig();
  configureTaskRegistryMaintenance({
    cronStorePath: resolveCronStorePath(cfg.cron?.store),
  });
}

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
  const trimmed = normalizeOptionalString(value);
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
      normalizeOptionalString(task.terminalSummary) ||
        normalizeOptionalString(task.progressSummary) ||
        normalizeOptionalString(task.label) ||
        task.task.trim(),
      80,
    );
    const line = [
      shortToken(task.taskId).padEnd(ID_PAD),
      task.runtime.padEnd(RUNTIME_PAD),
      formatTaskStatusCell(task.status, rich),
      task.deliveryStatus.padEnd(DELIVERY_PAD),
      shortToken(task.runId, RUN_PAD).padEnd(RUN_PAD),
      truncate(normalizeOptionalString(task.childSessionKey) || "n/a", 36).padEnd(36),
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

type TaskSystemAuditCode = TaskAuditCode | TaskFlowAuditCode;
type TaskSystemAuditSeverity = TaskAuditSeverity | TaskFlowAuditSeverity;

type TaskSystemAuditFinding = {
  kind: "task" | "task_flow";
  severity: TaskSystemAuditSeverity;
  code: TaskSystemAuditCode;
  detail: string;
  ageMs?: number;
  status?: string;
  token?: string;
  task?: TaskRecord;
  flow?: TaskFlowRecord;
};

function compareSystemAuditFindings(left: TaskSystemAuditFinding, right: TaskSystemAuditFinding) {
  return compareTaskAuditFindingSortKeys(
    {
      severity: left.severity,
      ageMs: left.ageMs,
      createdAt: left.task?.createdAt ?? left.flow?.createdAt ?? 0,
    },
    {
      severity: right.severity,
      ageMs: right.ageMs,
      createdAt: right.task?.createdAt ?? right.flow?.createdAt ?? 0,
    },
  );
}

function formatAuditRows(findings: TaskSystemAuditFinding[], rich: boolean) {
  const header = [
    "Scope".padEnd(8),
    "Severity".padEnd(8),
    "Code".padEnd(22),
    "Item".padEnd(ID_PAD),
    "Status".padEnd(STATUS_PAD),
    "Age".padEnd(8),
    "Detail",
  ].join(" ");
  const lines = [rich ? theme.heading(header) : header];
  for (const finding of findings) {
    const severity = finding.severity.padEnd(8);
    const status = formatTaskStatusCell(finding.status ?? "n/a", rich);
    const severityCell = !rich
      ? severity
      : finding.severity === "error"
        ? theme.error(severity)
        : theme.warn(severity);
    const scope = finding.kind === "task" ? "Task" : "TaskFlow";
    lines.push(
      [
        scope.padEnd(8),
        severityCell,
        finding.code.padEnd(22),
        shortToken(finding.token).padEnd(ID_PAD),
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

function toSystemAuditFindings(params: {
  severityFilter?: TaskSystemAuditSeverity;
  codeFilter?: TaskSystemAuditCode;
}) {
  const taskFindings = listTaskAuditFindings({ tasks: reconcileInspectableTasks() });
  const flowFindings = listTaskFlowAuditFindings();
  const allFindings: TaskSystemAuditFinding[] = [
    ...taskFindings.map((finding) => ({
      kind: "task" as const,
      severity: finding.severity,
      code: finding.code,
      detail: finding.detail,
      ageMs: finding.ageMs,
      status: finding.task.status,
      token: finding.task.taskId,
      task: finding.task,
    })),
    ...flowFindings.map((finding) => ({
      kind: "task_flow" as const,
      severity: finding.severity,
      code: finding.code,
      detail: finding.detail,
      ageMs: finding.ageMs,
      status: finding.flow?.status ?? "n/a",
      token: finding.flow?.flowId,
      ...(finding.flow ? { flow: finding.flow } : {}),
    })),
  ];
  const filteredFindings = allFindings
    .filter((finding) => {
      if (params.severityFilter && finding.severity !== params.severityFilter) {
        return false;
      }
      if (params.codeFilter && finding.code !== params.codeFilter) {
        return false;
      }
      return true;
    })
    .toSorted(compareSystemAuditFindings);
  const sortedAllFindings = [...allFindings].toSorted(compareSystemAuditFindings);
  return {
    allFindings: sortedAllFindings,
    filteredFindings,
    taskFindings,
    flowFindings,
    summary: {
      total: sortedAllFindings.length,
      errors: sortedAllFindings.filter((finding) => finding.severity === "error").length,
      warnings: sortedAllFindings.filter((finding) => finding.severity !== "error").length,
      tasks: summarizeTaskAuditFindings(taskFindings),
      taskFlows: summarizeTaskFlowAuditFindings(flowFindings),
    },
  };
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
    `ownerKey: ${task.ownerKey}`,
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
  ];
  for (const line of lines) {
    runtime.log(line);
  }
}

function parseAllowedActions(value: string | undefined): string[] | undefined {
  const actions = value
    ?.split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  return actions && actions.length > 0 ? actions : undefined;
}

function parseSafeTaskRisk(
  value: string | undefined,
  runtime: RuntimeEnv,
): SafeTaskRisk | undefined {
  if (value === undefined || value.trim() === "") {
    return undefined;
  }
  const risk = value.trim();
  if (SAFE_TASK_RISKS.includes(risk as SafeTaskRisk)) {
    return risk as SafeTaskRisk;
  }
  runtime.error(`Invalid safe task risk: ${risk}`);
  runtime.exit(1);
  return undefined;
}

function writeSafeTaskIndexJson(runtime: RuntimeEnv, value: unknown): void {
  writeRuntimeJson(runtime, value);
}

export async function tasksMetadataExportCommand(opts: { json?: boolean }, runtime: RuntimeEnv) {
  const loaded = loadSafeTaskIndex();
  if (opts.json) {
    writeSafeTaskIndexJson(runtime, {
      ...projectSafeTaskIndex(loaded.index),
      loadErrors: loaded.loadErrors,
    });
    return;
  }
  runtime.log(info(`Safe task metadata: ${loaded.index.tasks.length} records`));
  if (loaded.loadErrors.length > 0) {
    runtime.log(`Load errors: ${loaded.loadErrors.join("; ")}`);
  }
  if (loaded.index.tasks.length === 0) {
    runtime.log("No safe task metadata records found.");
    return;
  }
  for (const task of loaded.index.tasks) {
    runtime.log(`${task.task_id} ${task.status} ${task.risk} ${task.title}`);
  }
}

export async function tasksMetadataShowCommand(
  opts: { lookup: string; json?: boolean },
  runtime: RuntimeEnv,
) {
  const loaded = loadSafeTaskIndex();
  const task = findSafeTask(loaded.index, opts.lookup);
  if (!task) {
    runtime.error(`Safe task metadata not found: ${opts.lookup}`);
    runtime.exit(1);
    return;
  }
  if (opts.json) {
    writeSafeTaskIndexJson(runtime, {
      task: projectSafeTaskRecord(task),
      loadErrors: loaded.loadErrors,
    });
    return;
  }
  const lines = [
    "Safe task metadata:",
    `taskId: ${task.task_id}`,
    `title: ${task.title}`,
    `workspace: ${task.workspace}`,
    `source: ${task.source}`,
    `status: ${task.status}`,
    `risk: ${task.risk}`,
    `owner: ${task.owner}`,
    `allowedActions: ${task.allowed_actions.join(", ") || "n/a"}`,
    `handoff: ${task.handoff.state}`,
    `createdAt: ${task.created_at}`,
    `updatedAt: ${task.updated_at}`,
    ...(task.started_at ? [`startedAt: ${task.started_at}`] : []),
    ...(task.ended_at ? [`endedAt: ${task.ended_at}`] : []),
    ...(task.blocked_reason ? [`blockedReason: ${task.blocked_reason}`] : []),
    ...(task.completed_summary ? [`completedSummary: ${task.completed_summary}`] : []),
  ];
  for (const line of lines) {
    runtime.log(line);
  }
}

export async function tasksMetadataStartCommand(
  opts: {
    taskId: string;
    title?: string;
    workspace?: string;
    source?: string;
    owner?: string;
    risk?: string;
    allowedActions?: string;
    json?: boolean;
  },
  runtime: RuntimeEnv,
) {
  const risk = parseSafeTaskRisk(opts.risk, runtime);
  const index = upsertSafeTask({
    taskId: opts.taskId,
    title: opts.title,
    workspace: opts.workspace,
    source: opts.source,
    owner: opts.owner,
    risk,
    allowedActions: parseAllowedActions(opts.allowedActions),
  });
  const task = findSafeTask(index, opts.taskId);
  if (opts.json) {
    writeSafeTaskIndexJson(runtime, {
      task: task ? projectSafeTaskRecord(task) : undefined,
      index: projectSafeTaskIndex(index),
    });
    return;
  }
  runtime.log(`Started safe task metadata ${task?.task_id ?? opts.taskId}.`);
}

export async function tasksMetadataBlockCommand(
  opts: { taskId: string; reason: string; needsDecision?: boolean; risk?: string; json?: boolean },
  runtime: RuntimeEnv,
) {
  const risk = parseSafeTaskRisk(opts.risk, runtime);
  const index = blockSafeTask({
    taskId: opts.taskId,
    reason: opts.reason,
    needsDecision: Boolean(opts.needsDecision),
    risk,
  });
  const task = findSafeTask(index, opts.taskId);
  if (opts.json) {
    writeSafeTaskIndexJson(runtime, {
      task: task ? projectSafeTaskRecord(task) : undefined,
      index: projectSafeTaskIndex(index),
    });
    return;
  }
  runtime.log(`Blocked safe task metadata ${task?.task_id ?? opts.taskId}.`);
}

export async function tasksMetadataCompleteCommand(
  opts: { taskId: string; summary?: string; json?: boolean },
  runtime: RuntimeEnv,
) {
  const index = completeSafeTask({ taskId: opts.taskId, summary: opts.summary });
  const task = findSafeTask(index, opts.taskId);
  if (opts.json) {
    writeSafeTaskIndexJson(runtime, {
      task: task ? projectSafeTaskRecord(task) : undefined,
      index: projectSafeTaskIndex(index),
    });
    return;
  }
  runtime.log(`Completed safe task metadata ${task?.task_id ?? opts.taskId}.`);
}

export async function tasksDecisionsListCommand(opts: { json?: boolean }, runtime: RuntimeEnv) {
  const loaded = loadPendingDecisionQueue();
  const decisions = loaded.queue.decisions.map(projectPendingDecisionRecord);
  if (opts.json) {
    writeRuntimeJson(runtime, {
      ...loaded.queue,
      decisions,
      allowed_actions: loaded.queue.allowed_actions.map(projectAllowedActionRecord),
      loadErrors: loaded.loadErrors,
    });
    return;
  }
  runtime.log(info(`Pending decisions: ${decisions.length}`));
  if (loaded.loadErrors.length > 0) {
    runtime.log(`Load errors: ${loaded.loadErrors.join("; ")}`);
  }
  if (decisions.length === 0) {
    runtime.log("No pending decisions found.");
    return;
  }
  for (const decision of decisions) {
    runtime.log(`${decision.id} ${decision.risk} ${decision.title}`);
  }
}

export async function tasksDecisionsClassifyCommand(
  opts: {
    action: string;
    title?: string;
    reason?: string;
    taskId?: string;
    workspace?: string;
    json?: boolean;
  },
  runtime: RuntimeEnv,
) {
  const classification = classifyActionRequest({
    action: opts.action,
    title: opts.title,
    reason: opts.reason,
  });
  const queue =
    classification.decision === "needs_decision"
      ? registerPendingDecision({
          classification,
          title: opts.title,
          taskId: opts.taskId,
          workspace: opts.workspace,
        })
      : undefined;
  const audit =
    classification.decision === "allowed"
      ? registerAllowedActionAudit({
          classification,
          title: opts.title,
          workspace: opts.workspace,
        })
      : undefined;
  if (opts.json) {
    writeRuntimeJson(runtime, {
      classification,
      ...(queue
        ? {
            pendingDecision: projectPendingDecisionRecord(
              queue.decisions[queue.decisions.length - 1],
            ),
          }
        : {}),
      ...(audit
        ? {
            allowedAction: projectAllowedActionRecord(
              audit.allowed_actions[audit.allowed_actions.length - 1],
            ),
          }
        : {}),
    });
    return;
  }
  runtime.log(`${classification.decision}: ${classification.reason}`);
  if (queue) {
    const pending = queue.decisions[queue.decisions.length - 1];
    runtime.log(`Pending decision: ${pending.id}`);
  }
}

export async function tasksPhoneProbeCommand(
  opts: {
    text: string;
    json?: boolean;
  },
  runtime: RuntimeEnv,
) {
  const reply = buildPhoneControlReply(opts.text);
  if (opts.json) {
    writeRuntimeJson(runtime, reply);
    return;
  }
  runtime.log(reply.text);
  runtime.log("No live phone delivery was attempted.");
}

export async function tasksSupervisionCommand(
  opts: { json?: boolean; runRoot?: string },
  runtime: RuntimeEnv,
) {
  const runRoot = opts.runRoot?.trim() || process.env.OPENCLAW_RUN_HARNESS_RUN_ROOT?.trim();
  if (!runRoot) {
    runtime.error("Run Harness run root is required.");
    runtime.exit(1);
    return;
  }
  const summary = summarizeDurableRunFromArtifacts({ runRoot });
  if (opts.json) {
    writeRuntimeJson(runtime, summary);
    return;
  }
  runtime.log(info(`Durable run: ${summary.runId}`));
  runtime.log(
    info(
      `Stages: ${summary.stages.length} · tasks: ${summary.tasks.length} · blockers: ${summary.blockers.length} · gates: ${summary.gates.length}`,
    ),
  );
  runtime.log(
    info(
      `Evidence: ${summary.evidence.receipts.length} receipts · ${summary.evidence.reviews.length} reviews · ${summary.evidence.verification.length} verification`,
    ),
  );
  runtime.log("Routing lanes:");
  for (const lane of listWorkRoutingExplanations()) {
    runtime.log(`- ${lane.label}: ${lane.useWhen}`);
  }
  if (summary.blockers.length === 0) {
    runtime.log("No blockers found in allowed Run Harness artifacts.");
  } else {
    runtime.log("Blockers and gates:");
    for (const blocker of summary.blockers) {
      runtime.log(
        `- ${blocker.kind} ${blocker.id}${blocker.status ? ` (${blocker.status})` : ""}: ${blocker.title}`,
      );
    }
  }
  if (summary.loadErrors.length > 0) {
    runtime.log(`Load errors: ${summary.loadErrors.join("; ")}`);
  }
  runtime.log("Gate policy: pending gates are surfaced only; OpenClaw never auto-approves them.");
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
  const result = await cancelDetachedTaskRunById({
    cfg: await loadTaskCancelConfig(),
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
    severity?: TaskSystemAuditSeverity;
    code?: TaskSystemAuditCode;
    limit?: number;
  },
  runtime: RuntimeEnv,
) {
  configureTaskMaintenanceFromConfig();
  const severityFilter = opts.severity?.trim() as TaskSystemAuditSeverity | undefined;
  const codeFilter = opts.code?.trim() as TaskSystemAuditCode | undefined;
  const { allFindings, filteredFindings, taskFindings, summary } = toSystemAuditFindings({
    severityFilter,
    codeFilter,
  });
  const limit = typeof opts.limit === "number" && opts.limit > 0 ? opts.limit : undefined;
  const displayed = limit ? filteredFindings.slice(0, limit) : filteredFindings;

  if (opts.json) {
    const legacySummary = summarizeTaskAuditFindings(taskFindings);
    runtime.log(
      JSON.stringify(
        {
          count: allFindings.length,
          filteredCount: filteredFindings.length,
          displayed: displayed.length,
          filters: {
            severity: severityFilter ?? null,
            code: codeFilter ?? null,
            limit: limit ?? null,
          },
          summary: {
            ...legacySummary,
            taskFlows: summary.taskFlows,
            combined: {
              total: summary.total,
              errors: summary.errors,
              warnings: summary.warnings,
            },
          },
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
      `Tasks audit: ${summary.total} findings · ${summary.errors} errors · ${summary.warnings} warnings`,
    ),
  );
  if (severityFilter || codeFilter) {
    runtime.log(info(`Showing ${filteredFindings.length} matching findings.`));
  }
  if (severityFilter) {
    runtime.log(info(`Severity filter: ${severityFilter}`));
  }
  if (codeFilter) {
    runtime.log(info(`Code filter: ${codeFilter}`));
  }
  if (limit) {
    runtime.log(info(`Limit: ${limit}`));
  }
  runtime.log(
    info(`Task findings: ${summary.tasks.total} · TaskFlow findings: ${summary.taskFlows.total}`),
  );
  if (displayed.length === 0) {
    runtime.log("No tasks audit findings.");
    return;
  }
  const rich = isRich();
  for (const line of formatAuditRows(displayed, rich)) {
    runtime.log(line);
  }
}

export async function tasksMaintenanceCommand(
  opts: { json?: boolean; apply?: boolean },
  runtime: RuntimeEnv,
) {
  configureTaskMaintenanceFromConfig();
  const auditBefore = getInspectableTaskAuditSummary();
  const flowAuditBefore = getInspectableTaskFlowAuditSummary();
  const taskMaintenance = opts.apply
    ? await runTaskRegistryMaintenance()
    : previewTaskRegistryMaintenance();
  const flowMaintenance = opts.apply
    ? await runTaskFlowRegistryMaintenance()
    : previewTaskFlowRegistryMaintenance();
  const summary = getInspectableTaskRegistrySummary();
  const auditAfter = opts.apply ? getInspectableTaskAuditSummary() : auditBefore;
  const flowAuditAfter = opts.apply ? getInspectableTaskFlowAuditSummary() : flowAuditBefore;

  if (opts.json) {
    runtime.log(
      JSON.stringify(
        {
          mode: opts.apply ? "apply" : "preview",
          maintenance: {
            tasks: taskMaintenance,
            taskFlows: flowMaintenance,
          },
          tasks: summary,
          auditBefore: {
            ...auditBefore,
            taskFlows: flowAuditBefore,
          },
          auditAfter: {
            ...auditAfter,
            taskFlows: flowAuditAfter,
          },
        },
        null,
        2,
      ),
    );
    return;
  }

  runtime.log(
    info(
      `Tasks maintenance (${opts.apply ? "applied" : "preview"}): tasks ${taskMaintenance.reconciled} reconcile · ${taskMaintenance.recovered} recovered · ${taskMaintenance.cleanupStamped} cleanup stamp · ${taskMaintenance.pruned} prune; task-flows ${flowMaintenance.reconciled} reconcile · ${flowMaintenance.pruned} prune`,
    ),
  );
  runtime.log(
    info(
      `${opts.apply ? "Tasks health after apply" : "Tasks health"}: ${summary.byStatus.queued} queued · ${summary.byStatus.running} running · ${auditAfter.errors + flowAuditAfter.errors} audit errors · ${auditAfter.warnings + flowAuditAfter.warnings} audit warnings`,
    ),
  );
  if (opts.apply) {
    runtime.log(
      info(
        `Tasks health before apply: ${auditBefore.errors + flowAuditBefore.errors} audit errors · ${auditBefore.warnings + flowAuditBefore.warnings} audit warnings`,
      ),
    );
  }
  if (!opts.apply) {
    runtime.log("Dry run only. Re-run with `openclaw tasks maintenance --apply` to write changes.");
  }
}
