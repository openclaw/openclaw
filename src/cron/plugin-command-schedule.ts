import { MAX_DATE_TIMESTAMP_MS } from "@openclaw/normalization-core/number-coercion";
import { z } from "zod";
import { decodeQueuedOperatorRecoverySource } from "../gateway/operator-run-recovery-source.codec.js";
import { getFileLockProcessStartTime } from "../shared/pid-alive.js";
import {
  PLUGIN_COMMAND_SCHEDULE_MESSAGE,
  type PluginCommandSchedule,
  type PluginCommandScheduleBinding,
  type PluginCommandScheduleHost,
} from "./plugin-command-schedule.types.js";
import type { CronStoredJob } from "./types.js";

const MAX_PLUGIN_COMMAND_SCHEDULE_BYTES = 65_536;
export const MAX_PLUGIN_COMMAND_SCHEDULE_DURATION_MS = 7 * 24 * 60 * 60 * 1000;
export const MAX_PLUGIN_COMMAND_SCHEDULES_PER_INVOCATION = 4;
export const MAX_ACTIVE_PLUGIN_COMMAND_SCHEDULES_PER_PARENT = 8;
export const MAX_PLUGIN_COMMAND_SCHEDULE_TOOLS = 256;
export const PLUGIN_COMMAND_SCHEDULE_TOOL_NAME = /^[a-zA-Z0-9_.:/-]+$/;

let cachedHostProcessId: string | undefined;
/**
 * The Gateway process that minted the plugin incarnation. Incarnations are process-local, so a
 * different process proves the bound instance is gone before any attempt is spent; the claim
 * then re-arms a restartable schedule onto a matching loaded instance or retires it. Without a
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

const bindingSchema = z.strictObject({
  hostProcessId: boundedString,
  pluginIncarnation: boundedString,
  sourceDigest: boundedString,
});

/**
 * The process and plugin instance serving a schedule. A schedule accepted without restart
 * continuity stays bound to its creating process and instance, as older hosts read it.
 */
export function resolvePluginCommandScheduleBinding(
  job: Pick<CronStoredJob, "state">,
  schedule: PluginCommandSchedule,
): Omit<PluginCommandScheduleBinding, "sourceDigest"> &
  ({ restartable: false } | { restartable: true; sourceDigest: string }) {
  const stored = job.state.pluginCommandBinding;
  if (stored === undefined) {
    return {
      hostProcessId: schedule.hostProcessId,
      pluginIncarnation: schedule.pluginIncarnation,
      restartable: false,
    };
  }
  return { ...bindingSchema.parse(stored), restartable: true };
}

/**
 * The loaded instance runs the same code that accepted the schedule: the same plugin location
 * and metadata, the exact captured source digest, and the target command still registered.
 * Metadata alone is not code identity; a reload with the same metadata can run different code.
 */
function servesPluginCommandSchedule(
  host: PluginCommandScheduleHost,
  schedule: PluginCommandSchedule,
  sourceDigest: string,
): boolean {
  return (
    host.pluginId === schedule.pluginId &&
    host.pluginSource === schedule.pluginSource &&
    host.pluginRoot === schedule.pluginRoot &&
    host.pluginVersion === schedule.pluginVersion &&
    host.sourceDigest === sourceDigest &&
    host.commands.includes(schedule.command)
  );
}

/**
 * Restart continuity, applied by the durable queue owner inside its launch-claim transaction. A
 * restartable schedule left by an earlier Gateway process is re-armed onto the loaded instance of
 * the same plugin code, if any, before the budget check. The claim is the only writer, so a
 * restart and a recovery retry cannot both rebind or launch one occurrence. Disabled, removed,
 * expired or exhausted schedules are never rebound; without a matching loaded plugin the budget
 * check retires the schedule.
 */
export function rebindPluginCommandSchedule(
  job: CronStoredJob,
  nowMs: number,
  hostProcessId: string | undefined,
  hosts: readonly PluginCommandScheduleHost[] | undefined,
): void {
  if (!job.pluginCommand || job.state.pluginCommandBinding === undefined || !hostProcessId) {
    return;
  }
  let schedule: PluginCommandSchedule;
  let binding: ReturnType<typeof resolvePluginCommandScheduleBinding>;
  try {
    schedule = decodePluginCommandSchedule(job.pluginCommand);
    binding = resolvePluginCommandScheduleBinding(job, schedule);
  } catch {
    return;
  }
  if (!binding.restartable) {
    return;
  }
  const { sourceDigest } = binding;
  const runs = job.state.pluginCommandRuns;
  const host = hosts?.find((candidate) =>
    servesPluginCommandSchedule(candidate, schedule, sourceDigest),
  );
  if (
    binding.hostProcessId === hostProcessId ||
    !job.enabled ||
    nowMs >= schedule.deadlineAtMs ||
    !Number.isSafeInteger(runs) ||
    runs === undefined ||
    runs < 0 ||
    runs >= schedule.maxRuns ||
    !host
  ) {
    return;
  }
  job.state.pluginCommandBinding = {
    hostProcessId,
    pluginIncarnation: host.pluginIncarnation,
    sourceDigest,
  };
}

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
 * Enabled schedules that can still run plugin code count toward the active cap: those bound to the
 * same live plugin instance in this Gateway process, and unexpired restartable schedules of the
 * same plugin code (`sourceDigest` of the new schedule's instance) left by an earlier process,
 * which a later claim can re-arm. Schedules bound to a replaced instance or other code, or not
 * restartable from an earlier process, retire at their next occurrence and do not block
 * re-enrollment.
 */
export function isPluginCommandScheduleCapPeer(
  job: Pick<CronStoredJob, "enabled" | "pluginCommand" | "state">,
  schedule: PluginCommandSchedule,
  nowMs: number,
  sourceDigest: string | undefined,
): boolean {
  const peer = job.pluginCommand;
  if (
    !job.enabled ||
    peer?.pluginId !== schedule.pluginId ||
    peer.parent.sessionKey !== schedule.parent.sessionKey
  ) {
    return false;
  }
  let binding: ReturnType<typeof resolvePluginCommandScheduleBinding>;
  try {
    binding = resolvePluginCommandScheduleBinding(job, peer);
  } catch {
    return false;
  }
  if (binding.hostProcessId === schedule.hostProcessId) {
    return binding.pluginIncarnation === schedule.pluginIncarnation;
  }
  return (
    binding.restartable &&
    binding.sourceDigest === sourceDigest &&
    nowMs < peer.deadlineAtMs &&
    peer.pluginSource === schedule.pluginSource &&
    peer.pluginRoot === schedule.pluginRoot &&
    peer.pluginVersion === schedule.pluginVersion
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
  if (nowMs >= schedule.deadlineAtMs) {
    return "cron: plugin command schedule deadline expired";
  }
  if (count >= schedule.maxRuns) {
    return "cron: plugin command schedule maxRuns exhausted";
  }
  let binding: ReturnType<typeof resolvePluginCommandScheduleBinding>;
  try {
    binding = resolvePluginCommandScheduleBinding(job, schedule);
  } catch {
    return "cron: plugin command schedule binding is invalid";
  }
  if (binding.hostProcessId !== hostProcessId) {
    // The claim already tried to re-arm a restartable schedule onto a loaded instance.
    return binding.restartable
      ? "cron: plugin command schedule has no matching loaded plugin after Gateway restart"
      : "cron: plugin command schedule ended with its Gateway process";
  }
  return undefined;
}
