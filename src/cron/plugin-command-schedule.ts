import { MAX_DATE_TIMESTAMP_MS } from "@openclaw/normalization-core/number-coercion";
import { z } from "zod";
import { decodeQueuedOperatorRecoverySource } from "../gateway/operator-run-recovery-source.codec.js";
import { getFileLockProcessStartTime } from "../shared/pid-alive.js";
import {
  PLUGIN_COMMAND_SCHEDULE_MESSAGE,
  type PluginCommandSchedule,
} from "./plugin-command-schedule.types.js";
import type { CronStoredJob } from "./types.js";

export const MAX_PLUGIN_COMMAND_SCHEDULE_BYTES = 65_536;
export const MAX_PLUGIN_COMMAND_SCHEDULE_DURATION_MS = 7 * 24 * 60 * 60 * 1000;
export const MAX_PLUGIN_COMMAND_SCHEDULES_PER_INVOCATION = 4;
export const MAX_ACTIVE_PLUGIN_COMMAND_SCHEDULES_PER_PARENT = 8;
export const MAX_PLUGIN_COMMAND_SCHEDULE_TOOLS = 256;
export const PLUGIN_COMMAND_SCHEDULE_TOOL_NAME = /^[a-zA-Z0-9_.:/-]+$/;

let cachedHostProcessId: string | undefined;
/**
 * The Gateway process that minted the plugin incarnation. Incarnations are process-local, so a
 * different process proves the bound instance is gone before any attempt is spent. Without a
 * readable start time this degrades to the PID; the live incarnation check still fails closed.
 * Read it on the Gateway thread and pass it to the queue worker: the worker must not probe the
 * process inside its write transaction, and both sides must compare one cached value.
 */
export function currentPluginCommandHostProcessId(): string {
  return (cachedHostProcessId ??= `${process.pid}:${getFileLockProcessStartTime(process.pid) ?? "unknown"}`);
}

const boundedString = z
  .string()
  .min(1)
  .max(4096)
  .refine((value) => value.trim().length > 0);
const scheduleSchema = z.strictObject({
  version: z.literal(1),
  pluginId: boundedString,
  pluginIncarnation: boundedString,
  hostProcessId: boundedString,
  pluginSource: boundedString,
  pluginRoot: boundedString.optional(),
  pluginVersion: boundedString.optional(),
  command: z
    .string()
    .max(256)
    .regex(/^[a-z][a-z0-9_-]*$/),
  args: z
    .string()
    .min(1)
    .max(32_768)
    .refine((value) => value.trim().length > 0)
    .optional(),
  channel: boundedString,
  parent: z.strictObject({
    agentId: boundedString,
    sessionKey: boundedString,
    sessionId: boundedString,
    lifecycleRevision: boundedString.optional(),
  }),
  sourceRunId: boundedString,
  operatorSource: z.unknown(),
  toolsAllow: z
    .array(z.string().min(1).max(256).regex(PLUGIN_COMMAND_SCHEDULE_TOOL_NAME))
    .min(2)
    .max(MAX_PLUGIN_COMMAND_SCHEDULE_TOOLS)
    .refine((tools) => tools.includes("sessions_spawn") && tools.includes("agents_wait")),
  deadlineAtMs: z.number().int().min(1).max(MAX_DATE_TIMESTAMP_MS),
  maxRuns: z.number().int().min(1).max(100),
});

/** Decode once at creation/load boundaries; a stored source is not live authorization. */
export function decodePluginCommandSchedule(value: unknown): PluginCommandSchedule {
  const json = JSON.stringify(value);
  if (!json || Buffer.byteLength(json, "utf8") > MAX_PLUGIN_COMMAND_SCHEDULE_BYTES) {
    throw new Error("Plugin command schedule exceeds its storage bound.");
  }
  const parsed = scheduleSchema.parse(JSON.parse(json));
  const operatorSource = decodeQueuedOperatorRecoverySource(parsed.operatorSource);
  if (operatorSource.kind === "unavailable") {
    throw new Error("Plugin command schedule requires an available operator recovery source.");
  }
  return { ...parsed, operatorSource };
}

/** Private command schedules, or a stray reserved sentinel, never take an ordinary prompt route. */
export function isPluginCommandCronJob(
  job: Pick<CronStoredJob, "pluginCommand"> & { payload?: CronStoredJob["payload"] },
): boolean {
  return (
    job.pluginCommand !== undefined ||
    (job.payload?.kind === "agentTurn" && job.payload.message === PLUGIN_COMMAND_SCHEDULE_MESSAGE)
  );
}

/** Terminal command schedules stay inspectable but never wake or force-run again. */
export function retirePluginCommandJob(job: CronStoredJob, nowMs: number): void {
  job.enabled = false;
  job.updatedAtMs = nowMs;
  delete job.state.nextRunAtMs;
  delete job.state.startupCatchupAtMs;
  delete job.state.pacedNextRunAtMs;
  delete job.state.forcePreservedNextRunAtMs;
}

/**
 * Only schedules bound to the same live plugin instance in this Gateway process count toward the
 * active cap. Older schedules can never run plugin code again and retire at their next occurrence.
 */
export function isPluginCommandScheduleCapPeer(
  job: Pick<CronStoredJob, "enabled" | "pluginCommand">,
  schedule: PluginCommandSchedule,
): boolean {
  return (
    job.enabled &&
    job.pluginCommand?.pluginId === schedule.pluginId &&
    job.pluginCommand.parent.sessionKey === schedule.parent.sessionKey &&
    job.pluginCommand.pluginIncarnation === schedule.pluginIncarnation &&
    job.pluginCommand.hostProcessId === schedule.hostProcessId
  );
}

/**
 * The durable queue owner calls this immediately before its atomic launch claim. Every error is
 * terminal: the caller retires the job in the same transaction instead of waking it again.
 */
export function getPluginCommandRunBudgetError(
  job: Pick<CronStoredJob, "pluginCommand" | "state"> & { payload?: CronStoredJob["payload"] },
  nowMs: number,
  hostProcessId: string | undefined,
): string | undefined {
  if (!isPluginCommandCronJob(job) && job.state.pluginCommandRuns === undefined) {
    return undefined;
  }
  let schedule: PluginCommandSchedule;
  try {
    schedule = decodePluginCommandSchedule(job.pluginCommand);
  } catch {
    return "cron: plugin command schedule budget is missing or invalid";
  }
  const count = job.state.pluginCommandRuns;
  if (!Number.isSafeInteger(count) || count === undefined || count < 0 || count > 100) {
    return "cron: plugin command run counter is missing or invalid";
  }
  if (!Number.isSafeInteger(nowMs) || nowMs < 0 || nowMs > MAX_DATE_TIMESTAMP_MS) {
    return "cron: plugin command launch time is invalid";
  }
  if (schedule.hostProcessId !== hostProcessId) {
    return "cron: plugin command schedule ended with its Gateway process";
  }
  if (nowMs >= schedule.deadlineAtMs) {
    return "cron: plugin command schedule deadline expired";
  }
  if (count >= schedule.maxRuns) {
    return "cron: plugin command schedule maxRuns exhausted";
  }
  return undefined;
}
