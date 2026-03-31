import { loadConfig } from "../config/config.js";
import { info } from "../globals.js";
import type { RuntimeEnv } from "../runtime.js";
import { getFlowById, listFlowRecords, resolveFlowForLookupToken } from "../tasks/flow-registry.js";
import type { FlowRecord, FlowStatus } from "../tasks/flow-registry.types.js";
import { cancelFlowById, getFlowTaskSummary } from "../tasks/task-executor.js";
import { listTasksForFlowId } from "../tasks/task-registry.js";
import { isRich, theme } from "../terminal/theme.js";

const ID_PAD = 10;
const STATUS_PAD = 10;
const SHAPE_PAD = 12;

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

function formatFlowStatusCell(status: FlowStatus, rich: boolean) {
  const padded = status.padEnd(STATUS_PAD);
  if (!rich) {
    return padded;
  }
  if (status === "succeeded") {
    return theme.success(padded);
  }
  if (status === "failed" || status === "lost") {
    return theme.error(padded);
  }
  if (status === "running") {
    return theme.accentBright(padded);
  }
  if (status === "blocked") {
    return theme.warn(padded);
  }
  return theme.muted(padded);
}

function formatFlowRows(flows: FlowRecord[], rich: boolean) {
  const header = [
    "Flow".padEnd(ID_PAD),
    "Shape".padEnd(SHAPE_PAD),
    "Status".padEnd(STATUS_PAD),
    "Owner".padEnd(24),
    "Tasks".padEnd(14),
    "Goal",
  ].join(" ");
  const lines = [rich ? theme.heading(header) : header];
  for (const flow of flows) {
    const taskSummary = getFlowTaskSummary(flow.flowId);
    const counts = `${taskSummary.active} active/${taskSummary.total} total`;
    lines.push(
      [
        shortToken(flow.flowId).padEnd(ID_PAD),
        flow.shape.padEnd(SHAPE_PAD),
        formatFlowStatusCell(flow.status, rich),
        truncate(flow.ownerSessionKey, 24).padEnd(24),
        counts.padEnd(14),
        truncate(flow.goal, 80),
      ].join(" "),
    );
  }
  return lines;
}

function formatFlowListSummary(flows: FlowRecord[]) {
  const active = flows.filter(
    (flow) => flow.status === "queued" || flow.status === "running",
  ).length;
  const blocked = flows.filter((flow) => flow.status === "blocked").length;
  return `${active} active · ${blocked} blocked · ${flows.length} total`;
}

export async function flowsListCommand(
  opts: { json?: boolean; status?: string },
  runtime: RuntimeEnv,
) {
  const statusFilter = opts.status?.trim();
  const flows = listFlowRecords().filter((flow) => {
    if (statusFilter && flow.status !== statusFilter) {
      return false;
    }
    return true;
  });

  if (opts.json) {
    runtime.log(
      JSON.stringify(
        {
          count: flows.length,
          status: statusFilter ?? null,
          flows: flows.map((flow) => ({
            ...flow,
            tasks: listTasksForFlowId(flow.flowId),
            taskSummary: getFlowTaskSummary(flow.flowId),
          })),
        },
        null,
        2,
      ),
    );
    return;
  }

  runtime.log(info(`Flows: ${flows.length}`));
  runtime.log(info(`Flow pressure: ${formatFlowListSummary(flows)}`));
  if (statusFilter) {
    runtime.log(info(`Status filter: ${statusFilter}`));
  }
  if (flows.length === 0) {
    runtime.log("No flows found.");
    return;
  }
  const rich = isRich();
  for (const line of formatFlowRows(flows, rich)) {
    runtime.log(line);
  }
}

export async function flowsShowCommand(
  opts: { json?: boolean; lookup: string },
  runtime: RuntimeEnv,
) {
  const flow = resolveFlowForLookupToken(opts.lookup);
  if (!flow) {
    runtime.error(`Flow not found: ${opts.lookup}`);
    runtime.exit(1);
    return;
  }
  const tasks = listTasksForFlowId(flow.flowId);
  const taskSummary = getFlowTaskSummary(flow.flowId);

  if (opts.json) {
    runtime.log(
      JSON.stringify(
        {
          ...flow,
          tasks,
          taskSummary,
        },
        null,
        2,
      ),
    );
    return;
  }

  const lines = [
    "Flow:",
    `flowId: ${flow.flowId}`,
    `shape: ${flow.shape}`,
    `status: ${flow.status}`,
    `notify: ${flow.notifyPolicy}`,
    `ownerSessionKey: ${flow.ownerSessionKey}`,
    `goal: ${flow.goal}`,
    `currentStep: ${flow.currentStep ?? "n/a"}`,
    `blockedTaskId: ${flow.blockedTaskId ?? "n/a"}`,
    `blockedSummary: ${flow.blockedSummary ?? "n/a"}`,
    `createdAt: ${new Date(flow.createdAt).toISOString()}`,
    `updatedAt: ${new Date(flow.updatedAt).toISOString()}`,
    `endedAt: ${flow.endedAt ? new Date(flow.endedAt).toISOString() : "n/a"}`,
    `tasks: ${taskSummary.total} total · ${taskSummary.active} active · ${taskSummary.failures} issues`,
  ];
  for (const line of lines) {
    runtime.log(line);
  }
  if (tasks.length === 0) {
    runtime.log("Linked tasks: none");
    return;
  }
  runtime.log("Linked tasks:");
  for (const task of tasks) {
    runtime.log(
      `- ${task.taskId} ${task.status} ${task.runId ?? "n/a"} ${task.label ?? task.task}`,
    );
  }
}

export async function flowsCancelCommand(opts: { lookup: string }, runtime: RuntimeEnv) {
  const flow = resolveFlowForLookupToken(opts.lookup);
  if (!flow) {
    runtime.error(`Flow not found: ${opts.lookup}`);
    runtime.exit(1);
    return;
  }
  const result = await cancelFlowById({
    cfg: loadConfig(),
    flowId: flow.flowId,
  });
  if (!result.found) {
    runtime.error(result.reason ?? `Flow not found: ${opts.lookup}`);
    runtime.exit(1);
    return;
  }
  if (!result.cancelled) {
    runtime.error(result.reason ?? `Could not cancel flow: ${opts.lookup}`);
    runtime.exit(1);
    return;
  }
  const updated = getFlowById(flow.flowId) ?? result.flow ?? flow;
  runtime.log(`Cancelled ${updated.flowId} (${updated.shape}) with status ${updated.status}.`);
}
