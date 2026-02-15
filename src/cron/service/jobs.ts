import crypto from "node:crypto";
import type {
  CronDelivery,
  CronDeliveryPatch,
  CronJob,
  CronJobCreate,
  CronJobPatch,
  CronPayload,
  CronPayloadPatch,
} from "../types.js";
import type { CronServiceState } from "./state.js";
import { parseAbsoluteTimeMs } from "../parse.js";
import { computeNextRunAtMs } from "../schedule.js";
import {
  normalizeOptionalAgentId,
  normalizeOptionalText,
  normalizePayloadToSystemText,
  normalizeRequiredName,
} from "./normalize.js";

const STUCK_RUN_MS = 2 * 60 * 60 * 1000;

function resolveEveryAnchorMs(params: {
  schedule: { everyMs: number; anchorMs?: number };
  fallbackAnchorMs: number;
}) {
  const raw = params.schedule.anchorMs;
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return Math.max(0, Math.floor(raw));
  }
  return Math.max(0, Math.floor(params.fallbackAnchorMs));
}

export function assertSupportedJobSpec(job: Pick<CronJob, "sessionTarget" | "payload">) {
  if (job.sessionTarget === "main" && job.payload.kind !== "systemEvent") {
    throw new Error('main cron jobs require payload.kind="systemEvent"');
  }
  if (job.sessionTarget === "isolated" && job.payload.kind !== "agentTurn") {
    throw new Error('isolated cron jobs require payload.kind="agentTurn"');
  }
}

function assertDeliverySupport(job: Pick<CronJob, "sessionTarget" | "delivery">) {
  if (job.delivery && job.sessionTarget !== "isolated") {
    throw new Error('cron delivery config is only supported for sessionTarget="isolated"');
  }
}

export function findJobOrThrow(state: CronServiceState, id: string) {
  const job = state.store?.jobs.find((j) => j.id === id);
  if (!job) {
    throw new Error(`unknown cron job id: ${id}`);
  }
  return job;
}

export function computeJobNextRunAtMs(job: CronJob, nowMs: number): number | undefined {
  if (job.enabled === false) {
    return undefined;
  }
  if (job.schedule.kind === "every") {
    const anchorMs = resolveEveryAnchorMs({
      schedule: job.schedule,
      fallbackAnchorMs: job.createdAtMs,
    });
    return computeNextRunAtMs({ ...job.schedule, anchorMs }, nowMs);
  }
  if (job.schedule.kind === "at") {
    // One-shot jobs stay due until they successfully finish.
    if (job.state.lastStatus === "ok" && job.state.lastRunAtMs) {
      return undefined;
    }
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
    return atMs !== null ? atMs : undefined;
  }
  return computeNextRunAtMs(job.schedule, nowMs);
}

/** Maximum consecutive schedule errors before auto-disabling a job. */
const MAX_SCHEDULE_ERRORS = 3;

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

  if (job.enabled === false) {
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

export function recomputeNextRuns(state: CronServiceState): boolean {
  if (!state.store) {
    return false;
  }
  let changed = false;
  const now = state.deps.nowMs();
  for (const job of state.store.jobs) {
    const tick = normalizeJobTickState({ state, job, nowMs: now });
    if (tick.changed) {
      changed = true;
    }
    if (tick.skip) {
      continue;
    }
    // Only recompute if nextRunAtMs is missing or already past-due.
    // Preserving a still-future nextRunAtMs avoids accidentally advancing
    // a job that hasn't fired yet (e.g. during restart recovery).
    const nextRun = job.state.nextRunAtMs;
    const isDueOrMissing = nextRun === undefined || now >= nextRun;
    if (isDueOrMissing) {
      try {
        const newNext = computeJobNextRunAtMs(job, now);
        if (job.state.nextRunAtMs !== newNext) {
          job.state.nextRunAtMs = newNext;
          changed = true;
        }
        // Clear schedule error count on successful computation.
        if (job.state.scheduleErrorCount) {
          job.state.scheduleErrorCount = undefined;
          changed = true;
        }
      } catch (err) {
        const errorCount = (job.state.scheduleErrorCount ?? 0) + 1;
        job.state.scheduleErrorCount = errorCount;
        job.state.nextRunAtMs = undefined;
        job.state.lastError = `schedule error: ${String(err)}`;
        changed = true;

        if (errorCount >= MAX_SCHEDULE_ERRORS) {
          job.enabled = false;
          state.deps.log.error(
            { jobId: job.id, name: job.name, errorCount, err: String(err) },
            "cron: auto-disabled job after repeated schedule errors",
          );
        } else {
          state.deps.log.warn(
            { jobId: job.id, name: job.name, errorCount, err: String(err) },
            "cron: failed to compute next run for job (skipping)",
          );
        }
      }
    }
  }
  return changed;
}

/**
 * Maintenance-only version of recomputeNextRuns that handles disabled jobs
 * and stuck markers, but does NOT recompute nextRunAtMs for enabled jobs
 * with existing values. Used during timer ticks when no due jobs were found
 * to prevent silently advancing past-due nextRunAtMs values without execution
 * (see #13992).
 */
export function recomputeNextRunsForMaintenance(state: CronServiceState): boolean {
  if (!state.store) {
    return false;
  }
  let changed = false;
  const now = state.deps.nowMs();
  for (const job of state.store.jobs) {
    const tick = normalizeJobTickState({ state, job, nowMs: now });
    if (tick.changed) {
      changed = true;
    }
    if (tick.skip) {
      continue;
    }
    // Only compute missing nextRunAtMs, do NOT recompute existing ones.
    // If a job was past-due but not found by findDueJobs, recomputing would
    // cause it to be silently skipped.
    if (job.state.nextRunAtMs === undefined) {
      const newNext = computeJobNextRunAtMs(job, now);
      if (newNext !== undefined) {
        job.state.nextRunAtMs = newNext;
        changed = true;
      }
    }
  }
  return changed;
}

export function nextWakeAtMs(state: CronServiceState) {
  const jobs = state.store?.jobs ?? [];
  const enabled = jobs.filter(
    (j) => j.enabled !== false && typeof j.state.nextRunAtMs === "number",
  );
  if (enabled.length === 0) {
    return undefined;
  }
  return enabled.reduce(
    (min, j) => Math.min(min, j.state.nextRunAtMs as number),
    enabled[0].state.nextRunAtMs as number,
  );
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
    delivery: input.delivery,
    state: {
      ...input.state,
    },
  };
  assertSupportedJobSpec(job);
  assertDeliverySupport(job);
  job.state.nextRunAtMs = computeJobNextRunAtMs(job, now);
  return job;
}

export function applyJobPatch(job: CronJob, patch: CronJobPatch) {
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
    job.schedule = patch.schedule;
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
    if (
      legacyDeliveryPatch &&
      job.sessionTarget === "isolated" &&
      job.payload.kind === "agentTurn"
    ) {
      job.delivery = mergeCronDelivery(job.delivery, legacyDeliveryPatch);
    }
  }
  if (patch.delivery) {
    job.delivery = mergeCronDelivery(job.delivery, patch.delivery);
  }
  if (job.sessionTarget === "main" && job.delivery) {
    job.delivery = undefined;
  }
  if (patch.state) {
    job.state = { ...job.state, ...patch.state };
  }
  if ("agentId" in patch) {
    job.agentId = normalizeOptionalAgentId((patch as { agentId?: unknown }).agentId);
  }
  assertSupportedJobSpec(job);
  assertDeliverySupport(job);
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
    allowUnsafeExternalContent: patch.allowUnsafeExternalContent,
    deliver: patch.deliver,
    channel: patch.channel,
    to: patch.to,
    bestEffortDeliver: patch.bestEffortDeliver,
  };
}

function mergeCronDelivery(
  existing: CronDelivery | undefined,
  patch: CronDeliveryPatch,
): CronDelivery {
  const next: CronDelivery = {
    mode: existing?.mode ?? "none",
    channel: existing?.channel,
    to: existing?.to,
    bestEffort: existing?.bestEffort,
  };

  if (typeof patch.mode === "string") {
    next.mode = (patch.mode as string) === "deliver" ? "announce" : patch.mode;
  }
  if ("channel" in patch) {
    const channel = typeof patch.channel === "string" ? patch.channel.trim() : "";
    next.channel = channel ? channel : undefined;
  }
  if ("to" in patch) {
    const to = typeof patch.to === "string" ? patch.to.trim() : "";
    next.to = to ? to : undefined;
  }
  if (typeof patch.bestEffort === "boolean") {
    next.bestEffort = patch.bestEffort;
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
  return (
    job.enabled !== false &&
    typeof job.state.nextRunAtMs === "number" &&
    nowMs >= job.state.nextRunAtMs
  );
}

export function resolveJobPayloadTextForMain(job: CronJob): string | undefined {
  if (job.payload.kind !== "systemEvent") {
    return undefined;
  }
  const text = normalizePayloadToSystemText(job.payload);
  return text.trim() ? text : undefined;
}
