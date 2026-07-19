/** Builds stable identities for cron scheduling inputs. */
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { sha256Hex } from "../infra/crypto-digest.js";
import { parseCronPacingBounds } from "./pacing.js";
import { coerceFiniteScheduleNumber } from "./schedule-number.js";
import { normalizeCronStaggerMs } from "./stagger.js";
import type { CronJobState } from "./types.js";

type CronScheduleIdentityInput = { schedule?: unknown; enabled?: unknown } & Record<
  string,
  unknown
>;

type CronRunSchedulePayload =
  | ReturnType<typeof schedulePayloadFromRecord>
  | { kind: "on-exit"; command: string; cwd?: string };

function readString(record: Record<string, unknown>, key: string): string | undefined {
  return normalizeOptionalString(record[key]);
}

function readNumber(record: Record<string, unknown>, key: string): number | undefined {
  return coerceFiniteScheduleNumber(record[key]);
}

function readStaggerMs(record: Record<string, unknown>): number | undefined {
  return normalizeCronStaggerMs(record.staggerMs);
}

function schedulePayloadFromRecord(
  schedule: Record<string, unknown>,
):
  | { kind: "at"; at: string }
  | { kind: "every"; everyMs: number; anchorMs?: number }
  | { kind: "cron"; expr: string; tz?: string; staggerMs?: number }
  | undefined {
  const rawKind = readString(schedule, "kind")?.toLowerCase();
  const expr = readString(schedule, "expr");
  const at = readString(schedule, "at");
  const everyMs = readNumber(schedule, "everyMs");
  const anchorMs = readNumber(schedule, "anchorMs");
  const tz = readString(schedule, "tz");
  const staggerMs = readStaggerMs(schedule);
  const kind =
    // Infer legacy shorthand schedule shapes when kind is missing so timer
    // identity remains stable across old persisted jobs and normalized jobs.
    rawKind === "at" || rawKind === "every" || rawKind === "cron"
      ? rawKind
      : at
        ? "at"
        : everyMs !== undefined
          ? "every"
          : expr
            ? "cron"
            : undefined;

  if (kind === "at") {
    return at ? { kind: "at", at } : undefined;
  }
  if (kind === "every" && everyMs !== undefined) {
    return { kind: "every", everyMs, anchorMs };
  }
  if (kind === "cron" && expr) {
    return { kind: "cron", expr, tz, staggerMs };
  }
  return undefined;
}

function resolveSchedulePayload(
  job: CronScheduleIdentityInput,
): ReturnType<typeof schedulePayloadFromRecord> {
  if (job.schedule && typeof job.schedule === "object" && !Array.isArray(job.schedule)) {
    return schedulePayloadFromRecord(job.schedule as Record<string, unknown>);
  }
  return undefined;
}

function resolveRunSchedulePayload(job: CronScheduleIdentityInput): CronRunSchedulePayload {
  if (!job.schedule || typeof job.schedule !== "object" || Array.isArray(job.schedule)) {
    return undefined;
  }
  const schedule = job.schedule as Record<string, unknown>;
  if (readString(schedule, "kind")?.toLowerCase() !== "on-exit") {
    return schedulePayloadFromRecord(schedule);
  }
  const command = readString(schedule, "command");
  if (!command) {
    return undefined;
  }
  return { kind: "on-exit", command, cwd: readString(schedule, "cwd") };
}

function resolveTriggerPayload(
  job: CronScheduleIdentityInput,
): { script: string; once: boolean } | null | undefined {
  if (job.trigger === undefined || job.trigger === null) {
    return undefined;
  }
  if (typeof job.trigger !== "object" || Array.isArray(job.trigger)) {
    return null;
  }
  const trigger = job.trigger as Record<string, unknown>;
  const script = readString(trigger, "script");
  return script ? { script, once: trigger.once === true } : null;
}

function resolveStateWriterScript(job: CronScheduleIdentityInput): string | null | undefined {
  if (job.payload === undefined || job.payload === null) {
    return undefined;
  }
  if (typeof job.payload !== "object" || Array.isArray(job.payload)) {
    return null;
  }
  const payload = job.payload as Record<string, unknown>;
  if (readString(payload, "kind")?.toLowerCase() !== "script") {
    return undefined;
  }
  return readString(payload, "script") ?? null;
}

function resolvePacingPayload(
  job: CronScheduleIdentityInput,
): { minMs?: number; maxMs?: number } | null | undefined {
  if (job.pacing === undefined || job.pacing === null) {
    return undefined;
  }
  if (typeof job.pacing !== "object" || Array.isArray(job.pacing)) {
    return null;
  }
  const pacing = job.pacing as Record<string, unknown>;
  const min = normalizeOptionalString(pacing.min);
  const max = normalizeOptionalString(pacing.max);
  try {
    return parseCronPacingBounds({ min, max });
  } catch {
    return null;
  }
}

function resolveInstanceId(job: CronScheduleIdentityInput): string | undefined {
  if (!job.state || typeof job.state !== "object" || Array.isArray(job.state)) {
    return undefined;
  }
  return normalizeOptionalString((job.state as Record<string, unknown>).instanceId);
}

/** Compares the concrete persisted job generation independently from editable fields. */
export function cronRunInstanceInputsEqual(
  previous: CronScheduleIdentityInput,
  next: CronScheduleIdentityInput,
): boolean {
  return resolveInstanceId(previous) === resolveInstanceId(next);
}

/** Hashes the concrete job generation for durable run-ownership recovery. */
export function tryCronRunInstanceIdentity(job: CronScheduleIdentityInput): string | undefined {
  const instanceId = resolveInstanceId(job);
  return instanceId ? `sha256:${sha256Hex(`cron-instance-v1\0${instanceId}`)}` : undefined;
}

function tryCronRunTriggerValueIdentity(
  job: CronScheduleIdentityInput,
  revision?: number,
): string | undefined {
  const trigger = resolveTriggerPayload(job);
  if (!trigger) {
    return undefined;
  }
  return `sha256:${sha256Hex(
    JSON.stringify({
      version: 1,
      instanceId: resolveInstanceId(job),
      ...(revision !== undefined ? { revision } : {}),
      trigger,
    }),
  )}`;
}

/** Identifies the immutable trigger definition independently from shared state writers. */
export function tryCronRunTriggerIdentity(job: CronScheduleIdentityInput): string | undefined {
  return tryCronRunTriggerValueIdentity(job, resolveTriggerRevision(job));
}

/** Compares trigger lifecycle ownership without coupling it to payload/script state. */
export function cronRunTriggerInputsEqual(
  previous: CronScheduleIdentityInput,
  next: CronScheduleIdentityInput,
): boolean {
  const previousIdentity = tryCronRunTriggerIdentity(previous);
  return previousIdentity !== undefined && previousIdentity === tryCronRunTriggerIdentity(next);
}

/** Compares trigger definitions while ignoring their monotonic lifecycle revision. */
export function cronRunTriggerDefinitionsEqual(
  previous: CronScheduleIdentityInput,
  next: CronScheduleIdentityInput,
): boolean {
  const previousTrigger = resolveTriggerPayload(previous);
  const nextTrigger = resolveTriggerPayload(next);
  if (previousTrigger === undefined || nextTrigger === undefined) {
    return previousTrigger === undefined && nextTrigger === undefined;
  }
  const previousIdentity = tryCronRunTriggerValueIdentity(previous);
  return (
    previousIdentity !== undefined && previousIdentity === tryCronRunTriggerValueIdentity(next)
  );
}

/** Captures the exact owners that may finalize one admitted run after restart. */
export function createCronActiveRunOwnershipState(
  job: CronScheduleIdentityInput,
  mode: "advance" | "preserve",
): Pick<
  CronJobState,
  | "activeRunInstanceIdentity"
  | "activeRunScheduleIdentity"
  | "activeRunScheduleMode"
  | "activeRunStateIdentity"
> {
  return {
    activeRunInstanceIdentity: tryCronRunInstanceIdentity(job),
    activeRunScheduleIdentity: tryCronRunScheduleIdentity(job),
    activeRunScheduleMode: mode,
    activeRunStateIdentity: tryCronRunStateIdentity(job),
  };
}

/** Clears durable admission ownership together with its running marker. */
export function clearCronActiveRunOwnershipState(state: CronJobState): void {
  state.activeRunInstanceIdentity = undefined;
  state.activeRunScheduleIdentity = undefined;
  state.activeRunScheduleMode = undefined;
  state.activeRunStateIdentity = undefined;
}

function resolveScheduleRevision(job: CronScheduleIdentityInput): number {
  if (!job.state || typeof job.state !== "object" || Array.isArray(job.state)) {
    return 0;
  }
  const revision = (job.state as Record<string, unknown>).scheduleRevision;
  return typeof revision === "number" && Number.isFinite(revision)
    ? Math.max(0, Math.floor(revision))
    : 0;
}

function resolveStateRevision(job: CronScheduleIdentityInput): number {
  if (!job.state || typeof job.state !== "object" || Array.isArray(job.state)) {
    return 0;
  }
  const revision = (job.state as Record<string, unknown>).stateRevision;
  return typeof revision === "number" && Number.isFinite(revision)
    ? Math.max(0, Math.floor(revision))
    : 0;
}

function resolveTriggerRevision(job: CronScheduleIdentityInput): number {
  if (!job.state || typeof job.state !== "object" || Array.isArray(job.state)) {
    return 0;
  }
  const revision = (job.state as Record<string, unknown>).triggerRevision;
  return typeof revision === "number" && Number.isFinite(revision)
    ? Math.max(0, Math.floor(revision))
    : 0;
}

/** Builds a stable scheduling identity for deciding whether stored timer state is still valid. */
export function tryCronScheduleIdentity(job: CronScheduleIdentityInput): string | undefined {
  const schedule = resolveSchedulePayload(job);
  const pacing = resolvePacingPayload(job);
  if (!schedule || pacing === null) {
    return undefined;
  }
  return JSON.stringify({
    version: 2,
    enabled: typeof job.enabled === "boolean" ? job.enabled : true,
    schedule,
    pacing,
    hasTrigger: job.trigger !== undefined && job.trigger !== null,
  });
}

function tryCronRunScheduleValueIdentity(
  job: CronScheduleIdentityInput,
  revision?: number,
): string | undefined {
  const schedule = resolveRunSchedulePayload(job);
  const pacing = resolvePacingPayload(job);
  const trigger = resolveTriggerPayload(job);
  if (!schedule || pacing === null || trigger === null) {
    return undefined;
  }
  const canonical = JSON.stringify({
    version: 1,
    instanceId: resolveInstanceId(job),
    enabled: typeof job.enabled === "boolean" ? job.enabled : true,
    ...(revision !== undefined ? { revision } : {}),
    schedule,
    pacing,
    trigger,
  });
  return `sha256:${sha256Hex(canonical)}`;
}

/** Identifies the scheduling inputs and owner revision of one in-flight run. */
export function tryCronRunScheduleIdentity(job: CronScheduleIdentityInput): string | undefined {
  return tryCronRunScheduleValueIdentity(job, resolveScheduleRevision(job));
}

/** Compares every immutable scheduling field owned by an in-flight run. */
export function cronRunSchedulingInputsEqual(
  previous: CronScheduleIdentityInput,
  next: CronScheduleIdentityInput,
): boolean {
  const previousIdentity = tryCronRunScheduleValueIdentity(previous);
  return (
    previousIdentity !== undefined && previousIdentity === tryCronRunScheduleValueIdentity(next)
  );
}

function tryCronRunStateValueIdentity(
  job: CronScheduleIdentityInput,
  revision?: number,
): string | undefined {
  const trigger = resolveTriggerPayload(job);
  const script = resolveStateWriterScript(job);
  if (trigger === null || script === null) {
    return undefined;
  }
  return `sha256:${sha256Hex(
    JSON.stringify({
      version: 1,
      instanceId: resolveInstanceId(job),
      ...(revision !== undefined ? { revision } : {}),
      trigger,
      script,
    }),
  )}`;
}

/** Identifies trigger and payload-script definitions allowed to write shared state. */
export function tryCronRunStateIdentity(job: CronScheduleIdentityInput): string | undefined {
  return tryCronRunStateValueIdentity(job, resolveStateRevision(job));
}

/** Compares immutable definitions allowed to write shared trigger/script state. */
export function cronRunStateInputsEqual(
  previous: CronScheduleIdentityInput,
  next: CronScheduleIdentityInput,
): boolean {
  const previousIdentity = tryCronRunStateIdentity(previous);
  return previousIdentity !== undefined && previousIdentity === tryCronRunStateIdentity(next);
}

/** Compares state-writer definitions while ignoring their monotonic owner revision. */
export function cronRunStateDefinitionsEqual(
  previous: CronScheduleIdentityInput,
  next: CronScheduleIdentityInput,
): boolean {
  const previousIdentity = tryCronRunStateValueIdentity(previous);
  return previousIdentity !== undefined && previousIdentity === tryCronRunStateValueIdentity(next);
}

/** Compares two cron jobs by the normalized inputs that affect next-run computation. */
export function cronSchedulingInputsEqual(
  previous: CronScheduleIdentityInput,
  next: CronScheduleIdentityInput,
): boolean {
  const previousIdentity = tryCronScheduleIdentity(previous);
  const nextIdentity = tryCronScheduleIdentity(next);
  return (
    previousIdentity !== undefined &&
    nextIdentity !== undefined &&
    previousIdentity === nextIdentity
  );
}
