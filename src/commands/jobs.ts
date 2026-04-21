import type { RuntimeEnv } from "../runtime.js";
import { normalizeOptionalString } from "../shared/string-coerce.js";
import type {
  DurableJobRecord,
  DurableJobStatus,
  DurableJobTransitionRecord,
} from "../tasks/durable-job-registry.types.js";
import {
  getDurableJobById,
  listDurableJobRecords,
  listDurableJobTransitions,
} from "../tasks/runtime-internal.js";
import { sanitizeTerminalText } from "../terminal/safe-text.js";
import { isRich, theme } from "../terminal/theme.js";

const ID_PAD = 12;
const STATUS_PAD = 11;
const OWNER_PAD = 24;
const WAKE_PAD = 16;
const FLOW_PAD = 12;
const UPDATED_PAD = 20;

function truncate(value: string, maxChars: number) {
  if (value.length <= maxChars) {
    return value;
  }
  if (maxChars <= 1) {
    return value.slice(0, maxChars);
  }
  return `${value.slice(0, maxChars - 1)}…`;
}

function safeText(value: string | undefined, maxChars?: number): string {
  const sanitized = sanitizeTerminalText(value ?? "").trim();
  if (!sanitized) {
    return "n/a";
  }
  return typeof maxChars === "number" ? truncate(sanitized, maxChars) : sanitized;
}

function shortToken(value: string | undefined, maxChars = ID_PAD): string {
  const trimmed = normalizeOptionalString(value);
  if (!trimmed) {
    return "n/a";
  }
  return truncate(trimmed, maxChars);
}

function formatTimestamp(value: number | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return "n/a";
  }
  return new Date(value).toISOString();
}

function formatStatusCell(status: DurableJobStatus, rich: boolean) {
  const padded = status.padEnd(STATUS_PAD);
  if (!rich) {
    return padded;
  }
  if (status === "completed") {
    return theme.success(padded);
  }
  if (status === "blocked") {
    return theme.warn(padded);
  }
  if (status === "cancelled" || status === "superseded") {
    return theme.error(padded);
  }
  if (status === "running") {
    return theme.accentBright(padded);
  }
  return theme.muted(padded);
}

function summarizeJob(job: DurableJobRecord): string {
  return safeText(job.currentStep ?? job.summary ?? job.goal, 72);
}

function formatJobRows(jobs: DurableJobRecord[], rich: boolean) {
  const header = [
    "Job".padEnd(ID_PAD),
    "Status".padEnd(STATUS_PAD),
    "Owner".padEnd(OWNER_PAD),
    "Next Wake".padEnd(WAKE_PAD),
    "TaskFlow".padEnd(FLOW_PAD),
    "Updated".padEnd(UPDATED_PAD),
    "Summary",
  ].join(" ");
  const lines = [rich ? theme.heading(header) : header];
  for (const job of jobs) {
    lines.push(
      [
        shortToken(job.jobId).padEnd(ID_PAD),
        formatStatusCell(job.status, rich),
        safeText(job.ownerSessionKey, OWNER_PAD).padEnd(OWNER_PAD),
        truncate(formatTimestamp(job.nextWakeAt), WAKE_PAD).padEnd(WAKE_PAD),
        shortToken(job.backing.taskFlowId, FLOW_PAD).padEnd(FLOW_PAD),
        truncate(formatTimestamp(job.audit.updatedAt), UPDATED_PAD).padEnd(UPDATED_PAD),
        summarizeJob(job),
      ]
        .join(" ")
        .trimEnd(),
    );
  }
  return lines;
}

function formatListSummary(jobs: DurableJobRecord[]) {
  const running = jobs.filter((job) => job.status === "running").length;
  const waiting = jobs.filter((job) => job.status === "waiting").length;
  const blocked = jobs.filter((job) => job.status === "blocked").length;
  return `${running} running · ${waiting} waiting · ${blocked} blocked · ${jobs.length} total`;
}

function formatTransition(transition: DurableJobTransitionRecord): string {
  const from = transition.from ?? "n/a";
  const reason = safeText(transition.reason, 80);
  const actor = safeText(transition.actor, 24);
  const disposition = safeText(transition.disposition?.kind, 24);
  const notification = safeText(transition.disposition?.notification?.status, 16);
  const wake = safeText(transition.disposition?.wake?.status, 16);
  return `${formatTimestamp(transition.at)} ${from} -> ${transition.to} actor=${actor} disposition=${disposition} notification=${notification} wake=${wake} reason=${reason}`;
}

export async function jobsListCommand(
  opts: { json?: boolean; status?: string; owner?: string },
  runtime: RuntimeEnv,
) {
  const statusFilter = opts.status?.trim();
  const ownerFilter = opts.owner?.trim();
  const jobs = listDurableJobRecords().filter((job) => {
    if (statusFilter && job.status !== statusFilter) {
      return false;
    }
    if (ownerFilter && job.ownerSessionKey !== ownerFilter) {
      return false;
    }
    return true;
  });

  if (opts.json) {
    runtime.log(
      JSON.stringify(
        {
          count: jobs.length,
          status: statusFilter ?? null,
          owner: ownerFilter ?? null,
          jobs,
        },
        null,
        2,
      ),
    );
    return;
  }

  runtime.log(theme.info(`Durable jobs: ${jobs.length}`));
  runtime.log(theme.info(`Job pressure: ${formatListSummary(jobs)}`));
  if (statusFilter) {
    runtime.log(theme.info(`Status filter: ${statusFilter}`));
  }
  if (ownerFilter) {
    runtime.log(theme.info(`Owner filter: ${ownerFilter}`));
  }
  if (jobs.length === 0) {
    runtime.log("No durable jobs found.");
    return;
  }
  const rich = isRich();
  for (const line of formatJobRows(jobs, rich)) {
    runtime.log(line);
  }
}

export async function jobsShowCommand(
  opts: { json?: boolean; jobId: string },
  runtime: RuntimeEnv,
) {
  const job = getDurableJobById(opts.jobId);
  if (!job) {
    runtime.error(`Durable job not found: ${opts.jobId}`);
    runtime.exit(1);
    return;
  }
  const history = listDurableJobTransitions(job.jobId);

  if (opts.json) {
    runtime.log(
      JSON.stringify(
        {
          ...job,
          history,
        },
        null,
        2,
      ),
    );
    return;
  }

  const lines = [
    "Durable job:",
    `jobId: ${job.jobId}`,
    `title: ${safeText(job.title)}`,
    `status: ${job.status}`,
    `ownerSessionKey: ${safeText(job.ownerSessionKey)}`,
    `goal: ${safeText(job.goal)}`,
    `currentStep: ${safeText(job.currentStep)}`,
    `summary: ${safeText(job.summary)}`,
    `nextWakeAt: ${formatTimestamp(job.nextWakeAt)}`,
    `taskFlowId: ${safeText(job.backing.taskFlowId)}`,
    `notifyPolicy: ${safeText(job.notifyPolicy.kind)}`,
    `stopCondition: ${safeText(job.stopCondition.kind)}${job.stopCondition.details ? ` (${safeText(job.stopCondition.details)})` : ""}`,
    `source: ${safeText(job.source?.kind)}`,
    `revision: ${job.audit.revision}`,
    `createdAt: ${formatTimestamp(job.audit.createdAt)}`,
    `updatedAt: ${formatTimestamp(job.audit.updatedAt)}`,
    `lastUserUpdateAt: ${formatTimestamp(job.lastUserUpdateAt)}`,
    `historyCount: ${history.length}`,
  ];
  for (const line of lines) {
    runtime.log(line);
  }
  if (history.length === 0) {
    runtime.log("Transitions: none");
    return;
  }
  runtime.log("Transitions:");
  for (const transition of history) {
    runtime.log(`- ${formatTransition(transition)}`);
  }
}
