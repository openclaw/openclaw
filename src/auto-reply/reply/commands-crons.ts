import type { CronJob } from "../../cron/types.js";
import { callGateway } from "../../gateway/call.js";
import { logVerbose } from "../../globals.js";
import { formatDurationHuman } from "../../infra/format-time/format-duration.ts";
import { isInternalMessageChannel } from "../../utils/message-channel.js";
import { rejectUnauthorizedCommand } from "./command-gates.js";
import type { CommandHandler, CommandHandlerResult } from "./commands-types.js";

const COMMAND = "/crons";
const USAGE_TEXT = "Usage: /crons [all|delete|delete-inactive]";
const EMPTY_STATE_TEXT = "No cron jobs scheduled or active.";
const CRON_LIST_LIMIT = 200;

type CronsAction = "list" | "all" | "delete" | "delete-inactive";

type ParsedCronsCommand = { ok: true; action: CronsAction } | { ok: false; error: string } | null;

type CronListPage = {
  jobs?: CronJob[];
  hasMore?: boolean;
  nextOffset?: number | null;
};

function parseCronsCommand(normalized: string): ParsedCronsCommand {
  const trimmed = normalized.trim();
  if (trimmed === COMMAND) {
    return { ok: true, action: "list" };
  }
  if (!trimmed.startsWith(`${COMMAND} `)) {
    return null;
  }

  const tokens = trimmed.slice(COMMAND.length).trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) {
    return { ok: true, action: "list" };
  }

  const [action] = tokens;
  if (tokens.length > 1) {
    return { ok: false, error: USAGE_TEXT };
  }

  if (action === "list") {
    return { ok: true, action: "list" };
  }
  if (action === "all") {
    return { ok: true, action: "all" };
  }
  if (action === "delete") {
    return { ok: true, action: "delete" };
  }
  if (action === "delete-inactive") {
    return { ok: true, action: "delete-inactive" };
  }

  return { ok: false, error: USAGE_TEXT };
}

function truncateSummary(text: string, maxLength = 80): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return "(no details)";
  }
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

function summarizeSchedule(job: CronJob): string {
  const schedule = job.schedule;
  if (schedule.kind === "at") {
    return "one-time";
  }
  if (schedule.kind === "every") {
    return `every ${formatDurationHuman(schedule.everyMs)}`;
  }
  const tzSuffix = schedule.tz ? ` (${schedule.tz})` : "";
  return `cron ${schedule.expr}${tzSuffix}`;
}

function summarizePayload(job: CronJob): string {
  if (job.description?.trim()) {
    return truncateSummary(job.description);
  }

  if (job.payload.kind === "systemEvent") {
    return `reminder: ${truncateSummary(job.payload.text)}`;
  }

  return `task: ${truncateSummary(job.payload.message)}`;
}

function formatLocalTimestamp(timestampMs: number | undefined): string {
  if (typeof timestampMs !== "number" || !Number.isFinite(timestampMs)) {
    return "Not scheduled";
  }

  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZoneName: "short",
  }).format(new Date(timestampMs));
}

function formatCronListReply(params: { jobs: CronJob[]; includeDisabled: boolean }): string {
  const { jobs, includeDisabled } = params;
  if (jobs.length === 0) {
    return EMPTY_STATE_TEXT;
  }

  const heading = includeDisabled
    ? `Cron jobs (including inactive) (${jobs.length}):`
    : `Active cron jobs (${jobs.length}):`;

  const lines = jobs.map((job, index) => {
    const name = job.enabled ? job.name : `${job.name} (inactive)`;
    const nextRunLabel = job.enabled ? formatLocalTimestamp(job.state.nextRunAtMs) : "Inactive";
    const summary = `${summarizeSchedule(job)} • ${summarizePayload(job)}`;

    return `${index + 1}. ${name}\n   Next: ${nextRunLabel}\n   Summary: ${summary}`;
  });

  return `${heading}\n\n${lines.join("\n\n")}`;
}

async function listCronJobs(params: {
  enabled: "enabled" | "all" | "disabled";
}): Promise<CronJob[]> {
  const allJobs: CronJob[] = [];
  let offset = 0;

  for (let page = 0; page < 10_000; page += 1) {
    const response = await callGateway<CronListPage>({
      method: "cron.list",
      params: {
        enabled: params.enabled,
        sortBy: "nextRunAtMs",
        sortDir: "asc",
        offset,
        limit: CRON_LIST_LIMIT,
      },
    });

    const jobs = Array.isArray(response?.jobs) ? response.jobs : [];
    allJobs.push(...jobs);

    if (response?.hasMore !== true) {
      break;
    }

    const nextOffset =
      typeof response.nextOffset === "number" && Number.isFinite(response.nextOffset)
        ? response.nextOffset
        : null;
    if (nextOffset === null || nextOffset <= offset || jobs.length === 0) {
      break;
    }
    offset = nextOffset;
  }

  return allJobs;
}

async function removeCronJobs(jobs: CronJob[]): Promise<{
  removedCount: number;
  failed: Array<{ id: string; error: string }>;
}> {
  let removedCount = 0;
  const failed: Array<{ id: string; error: string }> = [];

  for (const job of jobs) {
    try {
      const result = await callGateway<{ removed?: boolean }>({
        method: "cron.remove",
        params: { id: job.id },
      });
      if (result?.removed) {
        removedCount += 1;
      } else {
        failed.push({ id: job.id, error: "not removed" });
      }
    } catch (err) {
      failed.push({ id: job.id, error: err instanceof Error ? err.message : String(err) });
    }
  }

  return { removedCount, failed };
}

function formatDeletionReply(params: {
  removedCount: number;
  failed: Array<{ id: string; error: string }>;
  label: "cron jobs" | "inactive cron jobs";
}): string {
  const { removedCount, failed, label } = params;
  if (failed.length === 0) {
    return `✅ Deleted ${removedCount} ${label}.`;
  }

  const failureSummary = failed
    .slice(0, 3)
    .map((entry) => `${entry.id} (${entry.error})`)
    .join(", ");
  const overflow = failed.length > 3 ? ` (+${failed.length - 3} more)` : "";

  return `⚠️ Deleted ${removedCount} ${label}, failed ${failed.length}: ${failureSummary}${overflow}`;
}

function rejectNonAdminGatewayClient(
  params: Parameters<CommandHandler>[0],
): CommandHandlerResult | null {
  if (!isInternalMessageChannel(params.command.channel)) {
    return null;
  }
  const scopes = params.ctx.GatewayClientScopes ?? [];
  if (scopes.includes("operator.admin")) {
    return null;
  }
  logVerbose("Ignoring /crons from gateway client missing operator.admin.");
  return {
    shouldContinue: false,
    reply: {
      text: "❌ /crons requires operator.admin for gateway clients.",
    },
  };
}

export const handleCronsCommand: CommandHandler = async (params, allowTextCommands) => {
  if (!allowTextCommands) {
    return null;
  }

  const parsed = parseCronsCommand(params.command.commandBodyNormalized);
  if (!parsed) {
    return null;
  }

  const unauthorized = rejectUnauthorizedCommand(params, COMMAND);
  if (unauthorized) {
    return unauthorized;
  }

  const adminRequired = rejectNonAdminGatewayClient(params);
  if (adminRequired) {
    return adminRequired;
  }

  if (!parsed.ok) {
    return {
      shouldContinue: false,
      reply: { text: parsed.error },
    };
  }

  try {
    if (parsed.action === "list" || parsed.action === "all") {
      const includeDisabled = parsed.action === "all";
      const jobs = await listCronJobs({ enabled: includeDisabled ? "all" : "enabled" });
      return {
        shouldContinue: false,
        reply: {
          text: formatCronListReply({ jobs, includeDisabled }),
        },
      };
    }

    if (parsed.action === "delete") {
      const jobs = await listCronJobs({ enabled: "all" });
      if (jobs.length === 0) {
        return {
          shouldContinue: false,
          reply: { text: EMPTY_STATE_TEXT },
        };
      }
      const { removedCount, failed } = await removeCronJobs(jobs);
      return {
        shouldContinue: false,
        reply: {
          text: formatDeletionReply({ removedCount, failed, label: "cron jobs" }),
        },
      };
    }

    const inactiveJobs = await listCronJobs({ enabled: "disabled" });
    if (inactiveJobs.length === 0) {
      return {
        shouldContinue: false,
        reply: { text: "No inactive cron jobs to delete." },
      };
    }
    const { removedCount, failed } = await removeCronJobs(inactiveJobs);
    return {
      shouldContinue: false,
      reply: {
        text: formatDeletionReply({ removedCount, failed, label: "inactive cron jobs" }),
      },
    };
  } catch (err) {
    return {
      shouldContinue: false,
      reply: {
        text: `❌ Failed to process /crons: ${err instanceof Error ? err.message : String(err)}`,
      },
    };
  }
};
