import type { SessionEventTarget } from "../../auto-reply/reply/session-event-contract.js";
/** Manual cron wake helper for queueing system events into sessions. */
import { formatErrorMessage } from "../../infra/errors.js";
import { isSubagentSessionKey, normalizeOptionalAgentId } from "../../routing/session-key.js";
import { isCronJobActive } from "../active-jobs.js";
import { CRON_AGENT_SELECTION_REQUIRED_MESSAGE } from "../agent-id.js";
import { resolveCronJobConfigRevision } from "../config-revision.js";
import type { CronJob } from "../types.js";
import {
  computeJobNextRunAtMs,
  hasScheduledNextRunAtMs,
  isJobEnabled,
  isTimeScheduledJob,
} from "./jobs-scheduling.js";
import {
  resolveCronNotificationQueueOwner,
  type CronNotificationJob,
  type CronNotificationRouting,
} from "./notification-intents.js";
import { resolveForcePreservedOneShotAtMs } from "./one-shot-schedule.js";
import type { CronServiceState } from "./state.js";

function resolveDeferredReceiverRunAt(job: CronJob, nowMs: number): number | undefined {
  const next = job.state.nextRunAtMs;
  if (
    !isJobEnabled(job) ||
    job.state.autoDisabled ||
    !isTimeScheduledJob(job) ||
    !hasScheduledNextRunAtMs(next)
  ) {
    return undefined;
  }
  // A skipped one-shot has no later occurrence to adopt its deferred notices.
  if (
    job.schedule.kind === "at" &&
    job.activeHours &&
    (job.activeHours.start !== "00:00" || job.activeHours.end !== "24:00")
  ) {
    return undefined;
  }
  if (typeof job.state.runningAtMs !== "number" && !isCronJobActive(job.id)) {
    return next;
  }
  if (job.schedule.kind === "at") {
    const preserved = resolveForcePreservedOneShotAtMs(job);
    return preserved !== undefined && preserved > nowMs ? preserved : undefined;
  }
  // Running jobs retain their current slot until settlement; only a later occurrence can receive.
  const future = computeJobNextRunAtMs(job, nowMs);
  return hasScheduledNextRunAtMs(future) ? Math.max(next, future) : undefined;
}

/** Internal Hook adapter; the public Cron facade retains its existing wake contract. */
export type DeferredHookWake = (opts: {
  text: string;
  agentId: string;
  expectedTarget?: SessionEventTarget;
  createIfMissing?: true;
  commitGuard: () => void;
}) => Promise<{ ok: true; eventOutcome: "queued" | "coalesced" } | { ok: false; reason?: string }>;

/** Keeps safety notices with their creator and limits failure routes to explicit origins. */
export async function enqueueCronNotification(
  state: CronServiceState,
  job: CronNotificationJob,
  text: string,
  kind: "auto-disabled" | "failure-alert",
  routing: CronNotificationRouting,
): Promise<void> {
  const owner = resolveCronNotificationQueueOwner(job, kind);
  const { sessionKey } = owner;
  const agentId = owner.agentId ?? normalizeOptionalAgentId(routing.defaultAgentId);
  if (!agentId) {
    throw new Error(CRON_AGENT_SELECTION_REQUIRED_MESSAGE);
  }
  const deliveryContext =
    sessionKey || (kind === "auto-disabled" && agentId)
      ? await state.deps.resolveOriginDeliveryContext?.({ agentId, sessionKey })
      : undefined;
  if (!state.deps.enqueueSessionEvent) {
    throw new Error("Session event execution is unavailable; restart the Gateway and retry");
  }
  const pending = state.deps.enqueueSessionEvent(text, {
    agentId,
    sessionKey,
    contextKey: `cron:${job.id}:${kind}`,
    ...(sessionKey ? {} : { createIfMissing: true as const }),
    ...(deliveryContext ? { deliveryContext } : {}),
  });
  // Post-commit notices report failed acceptance without blocking sibling jobs.
  pending
    ?.then((result) => {
      if (!result.ok) {
        throw new Error(result.error);
      }
    })
    .catch((error: unknown) => {
      state.deps.log.warn(
        { jobId: job.id, kind, error: formatErrorMessage(error) },
        "cron: notification admission failed",
      );
    });
}

/** The v4 wake adapter targets ordinary immediate or explicitly scheduled session work. */
export async function wake(
  state: CronServiceState,
  opts: {
    mode: "now" | "next-heartbeat";
    expectedTarget?: SessionEventTarget;
    createIfMissing?: true;
    commitGuard?: () => void;
    coalescing?: { onOutcome: (outcome: "queued" | "coalesced") => void };
    text: string;
    /**
     * Internal session key to enqueue the system event against. When omitted,
     * the dep resolves the configured system-agent target — wakes from a non-main
     * session would otherwise route to the wrong place. Callers wiring an
     * agent-tool `wake` should thread the resolved session key (e.g. from
     * `cron-tool`'s `resolveInternalSessionKey`) so the event lands on the
     * originating conversation lane.
     */
    sessionKey?: string;
    /** The agent that owns the targeted conversation, independent of the ambient default. */
    agentId?: string;
  },
) {
  opts.commitGuard?.();
  const text = opts.text.trim();
  if (!text) {
    return { ok: false } as const;
  }
  const sessionKey = opts.sessionKey?.trim() || undefined;
  const agentId = opts.agentId?.trim() || undefined;
  if (sessionKey && isSubagentSessionKey(sessionKey)) {
    return { ok: false, reason: "unwakeable-session-key" } as const;
  }
  // Carry the originating session's channel-correct delivery context (e.g. the
  // bound Telegram topic/thread) so a wake routes back into that thread instead
  // of the chat root. Only attempt this when an origin session is targeted; a
  // No-origin wakes keeps the empty option shape so the Gateway adapter can
  // resolve the current system-agent owner and session atomically.
  const originDeliveryContext =
    opts.expectedTarget?.deliveryContext ??
    (sessionKey || agentId
      ? await state.deps.resolveOriginDeliveryContext?.({ sessionKey, agentId })
      : undefined);
  const createIfMissing = opts.createIfMissing;
  const enqueueOpts = {
    ...(opts.expectedTarget ? { expectedTarget: opts.expectedTarget } : {}),
    ...(sessionKey ? { sessionKey } : {}),
    ...(agentId ? { agentId } : {}),
    ...(originDeliveryContext ? { deliveryContext: originDeliveryContext } : {}),
    createIfMissing,
    assertAcceptanceCurrent: opts.commitGuard,
  };
  if (opts.mode === "now" || sessionKey) {
    if (!state.deps.enqueueSessionEvent) {
      return {
        ok: false,
        reason: "Session event execution is unavailable; restart the Gateway",
      } as const;
    }
    opts.commitGuard?.();
    const pending = state.deps.enqueueSessionEvent(text, enqueueOpts);
    return pending
      ? pending.then((result) =>
          result.ok ? ({ ok: true } as const) : ({ ok: false, reason: result.error } as const),
        )
      : ({ ok: true } as const);
  }
  const capturedAgentId = normalizeOptionalAgentId(opts.expectedTarget?.agentId);
  const capturedSessionKey = opts.expectedTarget?.sessionKey?.trim() || undefined;
  const requestedTarget = { agentId, sessionKey: capturedSessionKey };
  if (capturedAgentId && agentId && normalizeOptionalAgentId(agentId) !== capturedAgentId) {
    return {
      ok: false,
      reason: "Captured wake target does not match the requested agent",
    } as const;
  }
  const target = state.deps.resolveSessionEventTarget?.(requestedTarget);
  if (
    (capturedAgentId && target?.agentId !== capturedAgentId) ||
    (capturedSessionKey && target?.sessionKey !== capturedSessionKey)
  ) {
    return {
      ok: false,
      reason: "Captured wake target no longer resolves to its destination",
    } as const;
  }
  const nowMs = state.deps.nowMs();
  let receiver: { job: CronJob; runAtMs: number } | undefined;
  for (const candidate of state.store?.jobs ?? []) {
    const runAtMs = resolveDeferredReceiverRunAt(candidate, nowMs);
    if (
      !target?.agentId ||
      !target.sessionKey ||
      (candidate.payload.kind !== "agentTurn" &&
        !(candidate.sessionTarget === "main" && candidate.payload.kind === "systemEvent")) ||
      !(candidate.sessionTarget === "main" || candidate.sessionTarget.startsWith("session:")) ||
      runAtMs === undefined
    ) {
      continue;
    }
    const jobTarget = state.deps.resolveSessionEventTarget?.({
      agentId: candidate.agentId,
      sessionKey: candidate.sessionTarget.startsWith("session:")
        ? candidate.sessionTarget.slice(8)
        : undefined,
    });
    if (
      jobTarget?.agentId === target.agentId &&
      jobTarget.sessionKey === target.sessionKey &&
      (!receiver ||
        runAtMs < receiver.runAtMs ||
        (runAtMs === receiver.runAtMs && candidate.id < receiver.job.id))
    ) {
      receiver = { job: candidate, runAtMs };
    }
  }
  if (!state.deps.cronEnabled || state.stopped || !receiver || !state.deps.deferSessionEvent) {
    return {
      ok: false,
      reason:
        "No enabled ordinary scheduled session job can receive this wake. Choose mode now or create an automation with a scheduled session turn.",
    } as const;
  }
  const { job, runAtMs } = receiver;
  const generation = state.lifecycleGeneration;
  const revision = resolveCronJobConfigRevision(job);
  const assertReceiverCurrent = () => {
    const currentJob = state.store?.jobs.find((candidate) => candidate.id === job.id);
    if (
      state.lifecycleGeneration !== generation ||
      !state.deps.cronEnabled ||
      state.stopped ||
      !currentJob ||
      resolveDeferredReceiverRunAt(currentJob, state.deps.nowMs()) === undefined ||
      resolveCronJobConfigRevision(currentJob) !== revision
    ) {
      throw new Error("Scheduled wake receiver changed during admission; retry the wake");
    }
    const currentTarget = state.deps.resolveSessionEventTarget?.(requestedTarget);
    const receiverTarget = state.deps.resolveSessionEventTarget?.({
      agentId: currentJob.agentId,
      sessionKey: currentJob.sessionTarget.startsWith("session:")
        ? currentJob.sessionTarget.slice(8)
        : undefined,
    });
    if (
      currentTarget?.agentId !== target?.agentId ||
      currentTarget?.sessionKey !== target?.sessionKey ||
      receiverTarget?.agentId !== target?.agentId ||
      receiverTarget?.sessionKey !== target?.sessionKey
    ) {
      throw new Error("Scheduled wake destination changed during admission; retry the wake");
    }
  };
  const assertCurrent = () => {
    opts.commitGuard?.();
    assertReceiverCurrent();
  };
  assertCurrent();
  const pending = state.deps.deferSessionEvent(
    text,
    job,
    opts.expectedTarget,
    assertCurrent,
    runAtMs,
    opts.coalescing
      ? { ...opts.coalescing, revision, assertCurrent: assertReceiverCurrent }
      : undefined,
    createIfMissing,
  );
  return pending ? pending.then(() => ({ ok: true }) as const) : ({ ok: true } as const);
}
