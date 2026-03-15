import crypto from "node:crypto";
import { normalizeAgentId } from "../../routing/session-key.js";
import { parseAbsoluteTimeMs } from "../parse.js";
import {
  coerceFiniteScheduleNumber,
  computeNextRunAtMs,
  computePreviousRunAtMs,
} from "../schedule.js";
import {
  normalizeCronStaggerMs,
  resolveCronStaggerMs,
  resolveDefaultCronStaggerMs,
} from "../stagger.js";
import type {
  CronDelivery,
  CronDeliveryPatch,
  CronFailureAlert,
  CronJob,
  CronJobCreate,
  CronJobPatch,
  CronPayload,
  CronPayloadPatch,
} from "../types.js";
import { normalizeHttpWebhookUrl } from "../webhook-url.js";
import { resolveInitialCronDelivery } from "./initial-delivery.js";
import {
  normalizeOptionalAgentId,
  normalizeOptionalSessionKey,
  normalizeOptionalText,
  normalizePayloadToSystemText,
  normalizeRequiredName,
} from "./normalize.js";
import type { CronServiceState } from "./state.js";

const STUCK_RUN_MS = 2 * 60 * 60 * 1000;
const STAGGER_OFFSET_CACHE_MAX = 4096;
const staggerOffsetCache = new Map<string, number>();

function isFiniteTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function resolveStableCronOffsetMs(jobId: string, staggerMs: number) {
  if (staggerMs <= 1) {
    return 0;
  }
  const cacheKey = `${staggerMs}:${jobId}`;
  const cached = staggerOffsetCache.get(cacheKey);
  if (cached !== undefined) {
    return cached;
  }
  const digest = crypto.createHash("sha256").update(jobId).digest();
  const offset = digest.readUInt32BE(0) % staggerMs;
  if (staggerOffsetCache.size >= STAGGER_OFFSET_CACHE_MAX) {
    const first = staggerOffsetCache.keys().next();
    if (!first.done) {
      staggerOffsetCache.delete(first.value);
    }
  }
  staggerOffsetCache.set(cacheKey, offset);
  return offset;
}

function computeStaggeredCronNextRunAtMs(job: CronJob, nowMs: number) {
  if (job.schedule.kind !== "cron") {
    return computeNextRunAtMs(job.schedule, nowMs);
  }

  const staggerMs = resolveCronStaggerMs(job.schedule);
  const offsetMs = resolveStableCronOffsetMs(job.id, staggerMs);
  if (offsetMs <= 0) {
    return computeNextRunAtMs(job.schedule, nowMs);
  }

  // Shift the schedule cursor backwards by the per-job offset so we can still
  // target the current schedule window if its staggered slot has not passed yet.
  let cursorMs = Math.max(0, nowMs - offsetMs);
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const baseNext = computeNextRunAtMs(job.schedule, cursorMs);
    if (baseNext === undefined) {
      return undefined;
    }
    const shifted = baseNext + offsetMs;
    if (shifted > nowMs) {
      return shifted;
    }
    cursorMs = Math.max(cursorMs + 1, baseNext + 1_000);
  }
  return undefined;
}

function computeStaggeredCronPreviousRunAtMs(job: CronJob, nowMs: number) {
  if (job.schedule.kind !== "cron") {
    return undefined;
  }

  const staggerMs = resolveCronStaggerMs(job.schedule);
  const offsetMs = resolveStableCronOffsetMs(job.id, staggerMs);
  if (offsetMs <= 0) {
    return computePreviousRunAtMs(job.schedule, nowMs);
  }

  // Shift the cursor backwards by the same per-job offset used for next-run
  // math so previous-run lookup matches the effective staggered schedule.
  let cursorMs = Math.max(0, nowMs - offsetMs);
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const basePrevious = computePreviousRunAtMs(job.schedule, cursorMs);
    if (basePrevious === undefined) {
      return undefined;
    }
    const shifted = basePrevious + offsetMs;
    if (shifted <= nowMs) {
      return shifted;
    }
    cursorMs = Math.max(0, basePrevious - 1_000);
  }
  return undefined;
}

function resolveEveryAnchorMs(params: {
  schedule: { everyMs: number; anchorMs?: number };
  fallbackAnchorMs: number;
}) {
  const coerced = coerceFiniteScheduleNumber(params.schedule.anchorMs);
  if (coerced !== undefined) {
    return Math.max(0, Math.floor(coerced));
  }
  if (isFiniteTimestamp(params.fallbackAnchorMs)) {
    return Math.max(0, Math.floor(params.fallbackAnchorMs));
  }
  return 0;
}

export function assertSupportedJobSpec(job: Pick<CronJob, "sessionTarget" | "payload">) {
  const isIsolatedLike =
    job.sessionTarget === "isolated" ||
    job.sessionTarget === "current" ||
    job.sessionTarget.startsWith("session:");
  if (job.sessionTarget === "main" && job.payload.kind !== "systemEvent") {
    throw new Error('main cron jobs require payload.kind="systemEvent"');
  }
  if (isIsolatedLike && job.payload.kind !== "agentTurn") {
    throw new Error('isolated/current/session cron jobs require payload.kind="agentTurn"');
  }
}

function assertMainSessionAgentId(
  job: Pick<CronJob, "sessionTarget" | "agentId">,
  defaultAgentId: string | undefined,
) {
  if (job.sessionTarget !== "main") {
    return;
  }
  if (!job.agentId) {
    return;
  }
  const normalized = normalizeAgentId(job.agentId);
  const normalizedDefault = normalizeAgentId(defaultAgentId);
  if (normalized !== normalizedDefault) {
    throw new Error(
      `cron: sessionTarget "main" is only valid for the default agent. Use sessionTarget "isolated" with payload.kind "agentTurn" for non-default agents (agentId: ${job.agentId})`,
    );
  }
}

const TELEGRAM_TME_URL_REGEX = /^https?:\/\/t\.me\/|t\.me\//i;
const TELEGRAM_SLASH_TOPIC_REGEX = /^-?\d+\/\d+$/;

function validateTelegramDeliveryTarget(to: string | undefined): string | undefined {
  if (!to) {
    return undefined;
  }
  const trimmed = to.trim();
  if (TELEGRAM_TME_URL_REGEX.test(trimmed)) {
    return undefined;
  }
  if (TELEGRAM_SLASH_TOPIC_REGEX.test(trimmed)) {
    return `Invalid Telegram delivery target "${to}". Use colon (:) as delimiter for topics, not slash. Valid formats: -1001234567890, -1001234567890:123, -1001234567890:topic:123, @username, https://t.me/username`;
  }
  return undefined;
}

function assertDeliverySupport(job: Pick<CronJob, "sessionTarget" | "delivery">) {
  // No delivery object or mode is "none" -- nothing to validate.
  if (!job.delivery || job.delivery.mode === "none") {
    return;
  }
  // Webhook delivery is allowed for any session target
  if (job.delivery.mode === "webhook") {
    const target = normalizeHttpWebhookUrl(job.delivery.to);
    if (!target) {
      throw new Error("cron webhook delivery requires delivery.to to be a valid http(s) URL");
    }
    job.delivery.to = target;
    return;
  }
  const isIsolatedLike =
    job.sessionTarget === "isolated" ||
    job.sessionTarget === "current" ||
    job.sessionTarget.startsWith("session:");
  if (!isIsolatedLike) {
    throw new Error('cron channel delivery config is only supported for sessionTarget="isolated"');
  }
  if (job.delivery.channel === "telegram") {
    const telegramError = validateTelegramDeliveryTarget(job.delivery.to);
    if (telegramError) {
      throw new Error(telegramError);
    }
  }
}

function assertFailureDestinationSupport(job: Pick<CronJob, "sessionTarget" | "delivery">) {
  const failureDestination = job.delivery?.failureDestination;
  if (!failureDestination) {
    return;
  }
  if (job.sessionTarget === "main" && job.delivery?.mode !== "webhook") {
    throw new Error(
      'cron delivery.failureDestination is only supported for sessionTarget="isolated" unless delivery.mode="webhook"',
    );
  }
  if (failureDestination.mode === "webhook") {
    const target = normalizeHttpWebhookUrl(failureDestination.to);
    if (!target) {
      throw new Error(
        "cron failure destination webhook requires delivery.failureDestination.to to be a valid http(s) URL",
      );
    }
    failureDestination.to = target;
  }
}

export function findJobOrThrow(state: CronServiceState, id: string) {
  // Exact match first
  let job = state.store?.jobs.find((j) => j.id === id);
  if (!job) {
    // Prefix match (like git short hashes)
    const matches = state.store?.jobs.filter((j) => j.id.startsWith(id)) ?? [];
    if (matches.length === 1) {
      job = matches[0];
    } else if (matches.length > 1) {
      const ids = matches.map((j) => j.id).join(", ");
      throw new Error(
        `ambiguous cron job id prefix "${id}" matches ${matches.length} jobs: ${ids}`,
      );
    }
  }
  if (!job) {
    throw new Error(`unknown cron job id: ${id}`);
  }
  return job;
}

export function computeJobNextRunAtMs(job: CronJob, nowMs: number): number | undefined {
  if (!job.enabled) {
    return undefined;
  }
  if (job.schedule.kind === "every") {
    const everyMsRaw = coerceFiniteScheduleNumber(job.schedule.everyMs);
    if (everyMsRaw === undefined) {
      return undefined;
    }
    const everyMs = Math.max(1, Math.floor(everyMsRaw));
    const lastRunAtMs = job.state.lastRunAtMs;
    if (typeof lastRunAtMs === "number" && Number.isFinite(lastRunAtMs)) {
      const nextFromLastRun = Math.floor(lastRunAtMs) + everyMs;
      if (nextFromLastRun > nowMs) {
        return nextFromLastRun;
      }
    }
    const fallbackAnchorMs = isFiniteTimestamp(job.createdAtMs) ? job.createdAtMs : nowMs;
    const anchorMs = resolveEveryAnchorMs({
      schedule: job.schedule,
      fallbackAnchorMs,
    });
    const next = computeNextRunAtMs({ ...job.schedule, everyMs, anchorMs }, nowMs);
    return isFiniteTimestamp(next) ? next : undefined;
  }
  if (job.schedule.kind === "at") {
    // Handle both canonical `at` (string) and legacy `atMs` (number) fields.
    // The store migration should convert atMs→at, but be defensive in case
    // the migration hasn't run yet or was bypassed.
    const schedule = job.schedule as { at?: string; atMs?: number | string };
    const atMs =
      typeof schedule.atMs === "number" && Number.isFinite(schedule.atMs) && schedule.atMs > 0
        ? schedule.atMs
        : typeof schedule.atMs === "string"
          ? parseAbsoluteTimeMs(schedule.atMs)
          : typeof schedule.at === "string"
            ? parseAbsoluteTimeMs(schedule.at)
            : null;
    // One-shot jobs stay due until they successfully finish, but if the
    // schedule was updated to a time after the last run, re-arm the job.
    if (job.state.lastStatus === "ok" && job.state.lastRunAtMs) {
      if (atMs !== null && Number.isFinite(atMs) && atMs > job.state.lastRunAtMs) {
        return atMs;
      }
      return undefined;
    }
    return atMs !== null && Number.isFinite(atMs) ? atMs : undefined;
  }
  const next = computeStaggeredCronNextRunAtMs(job, nowMs);
  if (next === undefined && job.schedule.kind === "cron") {
    const nextSecondMs = Math.floor(nowMs / 1000) * 1000 + 1000;
    return computeStaggeredCronNextRunAtMs(job, nextSecondMs);
  }
  return isFiniteTimestamp(next) ? next : undefined;
}

export function computeJobPreviousRunAtMs(job: CronJob, nowMs: number): number | undefined {
  if (!job.enabled || job.schedule.kind !== "cron") {
    return undefined;
  }
  const previous = computeStaggeredCronPreviousRunAtMs(job, nowMs);
  return isFiniteTimestamp(previous) ? previous : undefined;
}

/** Maximum consecutive schedule errors before auto-disabling a job. */
const MAX_SCHEDULE_ERRORS = 3;

export function recordScheduleComputeError(params: {
  state: CronServiceState;
  job: CronJob;
  err: unknown;
}): boolean {
  const { state, job, err } = params;
  const errorCount = (job.state.scheduleErrorCount ?? 0) + 1;
  const errText = String(err);

  job.state.scheduleErrorCount = errorCount;
  job.state.nextRunAtMs = undefined;
  job.state.lastError = `schedule error: ${errText}`;

  if (errorCount >= MAX_SCHEDULE_ERRORS) {
    job.enabled = false;
    state.deps.log.error(
      { jobId: job.id, name: job.name, errorCount, err: errText },
      "cron: auto-disabled job after repeated schedule errors",
    );

    // Notify the user so the auto-disable is not silent (#28861).
    const notifyText = `⚠️ Cron job "${job.name}" has been auto-disabled after ${errorCount} consecutive schedule errors. Last error: ${errText}`;
    state.deps.enqueueSystemEvent(notifyText, {
      agentId: job.agentId,
      sessionKey: job.sessionKey,
      contextKey: `cron:${job.id}:auto-disabled`,
    });
    state.deps.requestHeartbeatNow({
      reason: `cron:${job.id}:auto-disabled`,
      agentId: job.agentId,
      sessionKey: job.sessionKey,
    });
  } else {
    state.deps.log.warn(
      { jobId: job.id, name: job.name, errorCount, err: errText },
      "cron: failed to compute next run for job (skipping)",
    );
  }

  return true;
}

function normalizeJobTickState(params: { state: CronServiceState; job: CronJob; nowMs: number }): {
  changed: boolean;
  skip: boolean;
} {
  const { state, job, nowMs } = params;
  let changed = false;

  if (!job.state) {
    job.state = {};
    changed = true;
  }

  if (!job.enabled) {
    if (job.state.nextRunAtMs !== undefined) {
      job.state.nextRunAtMs = undefined;
      changed = true;
    }
    if (job.state.runningAtMs !== undefined) {
      job.state.runningAtMs = undefined;
      changed = true;
    }
    return { changed, skip: true };
  }

  if (!isFiniteTimestamp(job.state.nextRunAtMs) && job.state.nextRunAtMs !== undefined) {
    job.state.nextRunAtMs = undefined;
    changed = true;
  }

  const runningAt = job.state.runningAtMs;
  if (typeof runningAt === "number" && nowMs - runningAt > STUCK_RUN_MS) {
    state.deps.log.warn(
      { jobId: job.id, runningAtMs: runningAt },
      "cron: clearing stuck running marker",
    );
    job.state.runningAtMs = undefined;
    changed = true;
  }

  return { changed, skip: false };
}

function walkSchedulableJobs(
  state: CronServiceState,
  fn: (params: { job: CronJob; nowMs: number }) => boolean,
  nowMs = state.deps.nowMs(),
): boolean {
  if (!state.store) {
    return false;
  }
  let changed = false;
  for (const job of state.store.jobs) {
    const tick = normalizeJobTickState({ state, job, nowMs });
    if (tick.changed) {
      changed = true;
    }
    if (tick.skip) {
      continue;
    }
    if (fn({ job, nowMs })) {
      changed = true;
    }
  }
  return changed;
}

function recomputeJobNextRunAtMs(params: { state: CronServiceState; job: CronJob; nowMs: number }) {
  let changed = false;
  try {
    const newNext = computeJobNextRunAtMs(params.job, params.nowMs);
    if (params.job.state.nextRunAtMs !== newNext) {
      params.job.state.nextRunAtMs = newNext;
      changed = true;
    }
    // Clear schedule error count on successful computation.
    if (params.job.state.scheduleErrorCount) {
      params.job.state.scheduleErrorCount = undefined;
      changed = true;
    }
  } catch (err) {
    if (recordScheduleComputeError({ state: params.state, job: params.job, err })) {
      changed = true;
    }
  }
  return changed;
}

export function recomputeNextRuns(state: CronServiceState): boolean {
  return walkSchedulableJobs(state, ({ job, nowMs: now }) => {
    let changed = false;
    // Only recompute if nextRunAtMs is missing or already past-due.
    // Preserving a still-future nextRunAtMs avoids accidentally advancing
    // a job that hasn't fired yet (e.g. during restart recovery).
    const nextRun = job.state.nextRunAtMs;
    const isDueOrMissing = !isFiniteTimestamp(nextRun) || now >= nextRun;
    if (isDueOrMissing) {
      if (recomputeJobNextRunAtMs({ state, job, nowMs: now })) {
        changed = true;
      }
    }
    return changed;
  });
}

/**
 * Maintenance-only version of recomputeNextRuns that handles disabled jobs
 * and stuck markers, but does NOT recompute nextRunAtMs for enabled jobs
 * with existing values. Used during timer ticks when no due jobs were found
 * to prevent silently advancing past-due nextRunAtMs values without execution
 * (see #13992).
 */
export function recomputeNextRunsForMaintenance(
  state: CronServiceState,
  opts?: { recomputeExpired?: boolean; nowMs?: number },
): boolean {
  const recomputeExpired = opts?.recomputeExpired ?? false;
  return walkSchedulableJobs(
    state,
    ({ job, nowMs: now }) => {
      let changed = false;
      if (!isFiniteTimestamp(job.state.nextRunAtMs)) {
        // Missing or invalid nextRunAtMs is always repaired.
        if (recomputeJobNextRunAtMs({ state, job, nowMs: now })) {
          changed = true;
        }
      } else if (
        recomputeExpired &&
        now >= job.state.nextRunAtMs &&
        typeof job.state.runningAtMs !== "number"
      ) {
        // Only advance when the expired slot was already executed.
        // If not, preserve the past-due value so the job can still run.
        const lastRun = job.state.lastRunAtMs;
        const alreadyExecutedSlot = isFiniteTimestamp(lastRun) && lastRun >= job.state.nextRunAtMs;
        if (alreadyExecutedSlot) {
          if (recomputeJobNextRunAtMs({ state, job, nowMs: now })) {
            changed = true;
          }
        }
      }
      return changed;
    },
    opts?.nowMs,
  );
}

export function nextWakeAtMs(state: CronServiceState) {
  const jobs = state.store?.jobs ?? [];
  const enabled = jobs.filter((j) => j.enabled && isFiniteTimestamp(j.state.nextRunAtMs));
  if (enabled.length === 0) {
    return undefined;
  }
  const first = enabled[0]?.state.nextRunAtMs;
  if (!isFiniteTimestamp(first)) {
    return undefined;
  }
  return enabled.reduce((min, j) => {
    const next = j.state.nextRunAtMs;
    return isFiniteTimestamp(next) ? Math.min(min, next) : min;
  }, first);
}

export function createJob(state: CronServiceState, input: CronJobCreate): CronJob {
  const now = state.deps.nowMs();
  const id = crypto.randomUUID();
  const schedule =
    input.schedule.kind === "every"
      ? {
          ...input.schedule,
          anchorMs: resolveEveryAnchorMs({
            schedule: input.schedule,
            fallbackAnchorMs: now,
          }),
        }
      : input.schedule.kind === "cron"
        ? (() => {
            const explicitStaggerMs = normalizeCronStaggerMs(input.schedule.staggerMs);
            if (explicitStaggerMs !== undefined) {
              return { ...input.schedule, staggerMs: explicitStaggerMs };
            }
            const defaultStaggerMs = resolveDefaultCronStaggerMs(input.schedule.expr);
            return defaultStaggerMs !== undefined
              ? { ...input.schedule, staggerMs: defaultStaggerMs }
              : input.schedule;
          })()
        : input.schedule;
  const deleteAfterRun =
    typeof input.deleteAfterRun === "boolean"
      ? input.deleteAfterRun
      : schedule.kind === "at"
        ? true
        : undefined;
  const enabled = typeof input.enabled === "boolean" ? input.enabled : true;
  const job: CronJob = {
    id,
    agentId: normalizeOptionalAgentId(input.agentId),
    sessionKey: normalizeOptionalSessionKey((input as { sessionKey?: unknown }).sessionKey),
    name: normalizeRequiredName(input.name),
    description: normalizeOptionalText(input.description),
    enabled,
    deleteAfterRun,
    createdAtMs: now,
    updatedAtMs: now,
    schedule,
    sessionTarget: input.sessionTarget,
    wakeMode: input.wakeMode,
    payload: input.payload,
    delivery: resolveInitialCronDelivery(input),
    failureAlert: input.failureAlert,
    state: {
      ...input.state,
    },
  };
  assertSupportedJobSpec(job);
  assertMainSessionAgentId(job, state.deps.defaultAgentId);
  assertDeliverySupport(job);
  assertFailureDestinationSupport(job);
  job.state.nextRunAtMs = computeJobNextRunAtMs(job, now);
  return job;
}

export function applyJobPatch(
  job: CronJob,
  patch: CronJobPatch,
  opts?: { defaultAgentId?: string },
) {
  if ("name" in patch) {
    job.name = normalizeRequiredName(patch.name);
  }
  if ("description" in patch) {
    job.description = normalizeOptionalText(patch.description);
  }
  if (typeof patch.enabled === "boolean") {
    job.enabled = patch.enabled;
  }
  if (typeof patch.deleteAfterRun === "boolean") {
    job.deleteAfterRun = patch.deleteAfterRun;
  }
  if (patch.schedule) {
    if (patch.schedule.kind === "cron") {
      const explicitStaggerMs = normalizeCronStaggerMs(patch.schedule.staggerMs);
      if (explicitStaggerMs !== undefined) {
        job.schedule = { ...patch.schedule, staggerMs: explicitStaggerMs };
      } else if (job.schedule.kind === "cron") {
        job.schedule = { ...patch.schedule, staggerMs: job.schedule.staggerMs };
      } else {
        const defaultStaggerMs = resolveDefaultCronStaggerMs(patch.schedule.expr);
        job.schedule =
          defaultStaggerMs !== undefined
            ? { ...patch.schedule, staggerMs: defaultStaggerMs }
            : patch.schedule;
      }
    } else {
      job.schedule = patch.schedule;
    }
  }
  if (patch.sessionTarget) {
    job.sessionTarget = patch.sessionTarget;
  }
  if (patch.wakeMode) {
    job.wakeMode = patch.wakeMode;
  }
  if (patch.payload) {
    job.payload = mergeCronPayload(job.payload, patch.payload);
  }
  if (!patch.delivery && patch.payload?.kind === "agentTurn") {
    // Back-compat: legacy clients still update delivery via payload fields.
    const legacyDeliveryPatch = buildLegacyDeliveryPatch(patch.payload);
    const isIsolatedLike =
      job.sessionTarget === "isolated" ||
      job.sessionTarget === "current" ||
      job.sessionTarget.startsWith("session:");
    if (legacyDeliveryPatch && isIsolatedLike && job.payload.kind === "agentTurn") {
      job.delivery = mergeCronDelivery(job.delivery, legacyDeliveryPatch);
    }
  }
  if (patch.delivery) {
    job.delivery = mergeCronDelivery(job.delivery, patch.delivery);
  }
  if ("failureAlert" in patch) {
    job.failureAlert = mergeCronFailureAlert(job.failureAlert, patch.failureAlert);
  }
  if (
    job.sessionTarget === "main" &&
    job.delivery?.mode !== "webhook" &&
    job.delivery?.failureDestination
  ) {
    throw new Error(
      'cron delivery.failureDestination is only supported for sessionTarget="isolated" unless delivery.mode="webhook"',
    );
  }
  if (job.sessionTarget === "main" && job.delivery?.mode !== "webhook") {
    job.delivery = undefined;
  }
  if (patch.state) {
    job.state = { ...job.state, ...patch.state };
  }
  if ("agentId" in patch) {
    job.agentId = normalizeOptionalAgentId((patch as { agentId?: unknown }).agentId);
  }
  if ("sessionKey" in patch) {
    job.sessionKey = normalizeOptionalSessionKey((patch as { sessionKey?: unknown }).sessionKey);
  }
  assertSupportedJobSpec(job);
  assertMainSessionAgentId(job, opts?.defaultAgentId);
  assertDeliverySupport(job);
  assertFailureDestinationSupport(job);
}

function mergeCronPayload(existing: CronPayload, patch: CronPayloadPatch): CronPayload {
  if (patch.kind !== existing.kind) {
    return buildPayloadFromPatch(patch);
  }

  if (patch.kind === "systemEvent") {
    if (existing.kind !== "systemEvent") {
      return buildPayloadFromPatch(patch);
    }
    const text = typeof patch.text === "string" ? patch.text : existing.text;
    return { kind: "systemEvent", text };
  }

  if (existing.kind !== "agentTurn") {
    return buildPayloadFromPatch(patch);
  }

  const next: Extract<CronPayload, { kind: "agentTurn" }> = { ...existing };
  if (typeof patch.message === "string") {
    next.message = patch.message;
  }
  if (typeof patch.model === "string") {
    next.model = patch.model;
  }
  if (typeof patch.thinking === "string") {
    next.thinking = patch.thinking;
  }
  if (typeof patch.timeoutSeconds === "number") {
    next.timeoutSeconds = patch.timeoutSeconds;
  }
  if (typeof patch.lightContext === "boolean") {
    next.lightContext = patch.lightContext;
  }
  if (typeof patch.allowUnsafeExternalContent === "boolean") {
    next.allowUnsafeExternalContent = patch.allowUnsafeExternalContent;
  }
  if (typeof patch.deliver === "boolean") {
    next.deliver = patch.deliver;
  }
  if (typeof patch.channel === "string") {
    next.channel = patch.channel;
  }
  if (typeof patch.to === "string") {
    next.to = patch.to;
  }
  if (typeof patch.bestEffortDeliver === "boolean") {
    next.bestEffortDeliver = patch.bestEffortDeliver;
  }
  return next;
}

function buildLegacyDeliveryPatch(
  payload: Extract<CronPayloadPatch, { kind: "agentTurn" }>,
): CronDeliveryPatch | null {
  const deliver = payload.deliver;
  const toRaw = typeof payload.to === "string" ? payload.to.trim() : "";
  const hasLegacyHints =
    typeof deliver === "boolean" ||
    typeof payload.bestEffortDeliver === "boolean" ||
    Boolean(toRaw);
  if (!hasLegacyHints) {
    return null;
  }

  const patch: CronDeliveryPatch = {};
  let hasPatch = false;

  if (deliver === false) {
    patch.mode = "none";
    hasPatch = true;
  } else if (deliver === true || toRaw) {
    patch.mode = "announce";
    hasPatch = true;
  }

  if (typeof payload.channel === "string") {
    const channel = payload.channel.trim().toLowerCase();
    patch.channel = channel ? channel : undefined;
    hasPatch = true;
  }
  if (typeof payload.to === "string") {
    patch.to = payload.to.trim();
    hasPatch = true;
  }
  if (typeof payload.bestEffortDeliver === "boolean") {
    patch.bestEffort = payload.bestEffortDeliver;
    hasPatch = true;
  }

  return hasPatch ? patch : null;
}

function buildPayloadFromPatch(patch: CronPayloadPatch): CronPayload {
  if (patch.kind === "systemEvent") {
    if (typeof patch.text !== "string" || patch.text.length === 0) {
      throw new Error('cron.update payload.kind="systemEvent" requires text');
    }
    return { kind: "systemEvent", text: patch.text };
  }

  if (typeof patch.message !== "string" || patch.message.length === 0) {
    throw new Error('cron.update payload.kind="agentTurn" requires message');
  }

  return {
    kind: "agentTurn",
    message: patch.message,
    model: patch.model,
    thinking: patch.thinking,
    timeoutSeconds: patch.timeoutSeconds,
    lightContext: patch.lightContext,
    allowUnsafeExternalContent: patch.allowUnsafeExternalContent,
    deliver: patch.deliver,
    channel: patch.channel,
    to: patch.to,
    bestEffortDeliver: patch.bestEffortDeliver,
  };
}

function normalizeOptionalTrimmedString(value: unknown): string | undefined {
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed ? trimmed : undefined;
}

function mergeCronDelivery(
  existing: CronDelivery | undefined,
  patch: CronDeliveryPatch,
): CronDelivery {
  const next: CronDelivery = {
    mode: existing?.mode ?? "none",
    channel: existing?.channel,
    to: existing?.to,
    accountId: existing?.accountId,
    bestEffort: existing?.bestEffort,
    failureDestination: existing?.failureDestination,
  };

  if (typeof patch.mode === "string") {
    next.mode = (patch.mode as string) === "deliver" ? "announce" : patch.mode;
  }
  if ("channel" in patch) {
    next.channel = normalizeOptionalTrimmedString(patch.channel);
  }
  if ("to" in patch) {
    next.to = normalizeOptionalTrimmedString(patch.to);
  }
  if ("accountId" in patch) {
    next.accountId = normalizeOptionalTrimmedString(patch.accountId);
  }
  if (typeof patch.bestEffort === "boolean") {
    next.bestEffort = patch.bestEffort;
  }
  if ("failureDestination" in patch) {
    if (patch.failureDestination === undefined) {
      next.failureDestination = undefined;
    } else {
      const existingFd = next.failureDestination;
      const patchFd = patch.failureDestination;
      const nextFd: typeof next.failureDestination = {
        channel: existingFd?.channel,
        to: existingFd?.to,
        accountId: existingFd?.accountId,
        mode: existingFd?.mode,
      };
      if (patchFd) {
        if ("channel" in patchFd) {
          const channel = typeof patchFd.channel === "string" ? patchFd.channel.trim() : "";
          nextFd.channel = channel ? channel : undefined;
        }
        if ("to" in patchFd) {
          const to = typeof patchFd.to === "string" ? patchFd.to.trim() : "";
          nextFd.to = to ? to : undefined;
        }
        if ("accountId" in patchFd) {
          const accountId = typeof patchFd.accountId === "string" ? patchFd.accountId.trim() : "";
          nextFd.accountId = accountId ? accountId : undefined;
        }
        if ("mode" in patchFd) {
          const mode = typeof patchFd.mode === "string" ? patchFd.mode.trim() : "";
          nextFd.mode = mode === "announce" || mode === "webhook" ? mode : undefined;
        }
      }
      next.failureDestination = nextFd;
    }
  }

  return next;
}

function mergeCronFailureAlert(
  existing: CronFailureAlert | false | undefined,
  patch: CronFailureAlert | false | undefined,
): CronFailureAlert | false | undefined {
  if (patch === false) {
    return false;
  }
  if (patch === undefined) {
    return existing;
  }
  const base = existing === false || existing === undefined ? {} : existing;
  const next: CronFailureAlert = { ...base };

  if ("after" in patch) {
    const after = typeof patch.after === "number" && Number.isFinite(patch.after) ? patch.after : 0;
    next.after = after > 0 ? Math.floor(after) : undefined;
  }
  if ("channel" in patch) {
    next.channel = normalizeOptionalTrimmedString(patch.channel);
  }
  if ("to" in patch) {
    next.to = normalizeOptionalTrimmedString(patch.to);
  }
  if ("cooldownMs" in patch) {
    const cooldownMs =
      typeof patch.cooldownMs === "number" && Number.isFinite(patch.cooldownMs)
        ? patch.cooldownMs
        : -1;
    next.cooldownMs = cooldownMs >= 0 ? Math.floor(cooldownMs) : undefined;
  }
  if ("mode" in patch) {
    const mode = typeof patch.mode === "string" ? patch.mode.trim() : "";
    next.mode = mode === "announce" || mode === "webhook" ? mode : undefined;
  }
  if ("accountId" in patch) {
    const accountId = typeof patch.accountId === "string" ? patch.accountId.trim() : "";
    next.accountId = accountId ? accountId : undefined;
  }

  return next;
}

export function isJobDue(job: CronJob, nowMs: number, opts: { forced: boolean }) {
  if (!job.state) {
    job.state = {};
  }
  if (typeof job.state.runningAtMs === "number") {
    return false;
  }
  if (opts.forced) {
    return true;
  }
  return job.enabled && typeof job.state.nextRunAtMs === "number" && nowMs >= job.state.nextRunAtMs;
}

export function resolveJobPayloadTextForMain(job: CronJob): string | undefined {
  if (job.payload.kind !== "systemEvent") {
    return undefined;
  }
  const text = normalizePayloadToSystemText(job.payload);
  return text.trim() ? text : undefined;
}
