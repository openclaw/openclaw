// Restart sentinels publish update outcomes without launching agent work.
import {
  resolveCorrelatedSubagentDelivery,
  settleCorrelatedSubagentDelivery,
} from "../agents/subagents/completion/subagent-completion-delivery.js";
import type { CliDeps } from "../cli/deps.types.js";
import { getRuntimeConfig } from "../config/io.js";
import { resolveSystemMainSessionTarget } from "../config/sessions.js";
import { appendAssistantMessageToSessionTranscript } from "../config/sessions/transcript.js";
import { removeCronRunContinuationSessionIfIdle } from "../cron/run-continuation-cleanup.js";
import {
  captureDeliveryQueueStateContext,
  type DeliveryQueueStateContext,
} from "../infra/delivery-queue-state-context.js";
import { formatErrorMessage } from "../infra/errors.js";
import type { GatewayScheduler } from "../infra/gateway-scheduler.js";
import {
  clearRestartSentinelIfRevision,
  formatRestartSentinelMessage,
  summarizeRestartSentinel,
} from "../infra/restart-sentinel.js";
import {
  recoverPendingSessionDeliveries,
  type SessionDeliveryRecoveryLogger,
  type SettleSessionDeliveryFn,
} from "../infra/session-delivery-queue-recovery.js";
import type { QueuedSessionDelivery } from "../infra/session-delivery-queue.records.js";
import { isPendingControlPlaneUpdateRestartSentinel } from "../infra/update-control-plane-sentinel.js";
import { renderUpdateRunSummary } from "../infra/update-run-notice.js";
import { updateRunReportInputFromSentinel } from "../infra/update-run-report.js";
import { recordUpdateRunVerificationAsync as recordUpdateRunVerification } from "../infra/update-run-write.async.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { runWithGatewayIndependentRootWorkAdmission } from "../process/gateway-work-admission.js";
import type { OpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.types.js";
import { deliverQueuedGeneratedMediaCompletion } from "./server-restart-sentinel-agent-delivery.js";
import {
  deliverRestartSentinelNotice,
  enqueueRestartSentinelNotice,
} from "./server-restart-sentinel-notice.js";
import {
  readRestartSentinelStartupSnapshot,
  type PendingUpdateSentinelIdentity,
} from "./server-restart-sentinel-snapshot.js";
import { finalizeRestartUpdateRun } from "./server-restart-update-run.js";
import { recordLatestUpdateRestartSentinel } from "./server-update-sentinel.js";
import { findCanonicalStoreMatch } from "./session-utils-store-selection.js";
import { resolveGatewaySessionStoreTargetInWorker } from "./session-utils-store-worker.js";
import { runStartupTasks, type StartupTask } from "./startup-tasks.js";
import {
  recordUpdateRunNoticeSkipped,
  resolveUpdateRunNoticeTarget,
} from "./update-run-notice-target.js";
import { appendUpdateRunFinishedNotice } from "./update-run-notice.runtime.js";

const log = createSubsystemLogger("gateway/restart-sentinel");
const CONTROL_PLANE_UPDATE_PENDING_RETRY_DELAY_MS = 2_000;
const CONTROL_PLANE_UPDATE_PENDING_MAX_ATTEMPTS = 900;

/** Settles every queue entry through its durable producer before cron cleanup. */
export const settleQueuedSessionDelivery: SettleSessionDeliveryFn = async (
  entry,
  outcome,
  queueContext,
) => {
  await settleCorrelatedSubagentDelivery(entry, outcome, queueContext);
  await removeCronRunContinuationSessionIfIdle(entry.sessionKey, entry.id, queueContext);
};

export async function deliverQueuedSessionDelivery(params: {
  deps: CliDeps;
  entry: QueuedSessionDelivery;
  queueContext: OpenClawStateWorkerContext;
  resolveGatewayContext?: import("./server-methods/types.js").GatewayContextResolver;
}) {
  params.queueContext.admission.assertCurrent();
  // Legacy inference rows are intentionally inert. Only already-produced media
  // belongs to the delivery queue; graceful restart resumption has one owner.
  if (params.entry.kind !== "agentTurn" || !params.entry.expectedMediaUrls?.length) {
    return;
  }
  const queuedEntry = resolveCorrelatedSubagentDelivery(params.entry);
  if (queuedEntry.kind !== "agentTurn") {
    return;
  }
  if (queuedEntry.requesterBinding) {
    await deliverQueuedGeneratedMediaCompletion({
      ...params,
      ...queuedEntry.requesterBinding,
      entry: queuedEntry,
      canonicalKey: queuedEntry.requesterBinding.sessionKey,
    });
    return;
  }
  const cfg = getRuntimeConfig();
  const { agentId, store, storeKeys, storePath, canonicalKey } =
    await resolveGatewaySessionStoreTargetInWorker({
      cfg,
      key: queuedEntry.sessionKey,
      env: params.queueContext.environment,
      assertActive: () => params.queueContext.admission.assertCurrent(),
    });
  params.queueContext.admission.assertCurrent();
  await deliverQueuedGeneratedMediaCompletion({
    ...params,
    entry: queuedEntry,
    canonicalKey,
    agentId,
    storePath,
    sessionEntry: findCanonicalStoreMatch(store, storeKeys)?.entry,
  });
}

export async function recoverPendingProducedSessionDeliveries(params: {
  deps: CliDeps;
  queueContext: OpenClawStateWorkerContext;
  log?: SessionDeliveryRecoveryLogger;
  maxEnqueuedAt?: number;
  resolveGatewayContext?: import("./server-methods/types.js").GatewayContextResolver;
}) {
  await recoverPendingSessionDeliveries({
    queueContext: params.queueContext,
    deliver: (entry, { queueContext }) =>
      deliverQueuedSessionDelivery({ ...params, entry, queueContext }),
    log: params.log ?? log,
    maxEnqueuedAt: params.maxEnqueuedAt,
    onSettled: settleQueuedSessionDelivery,
  });
}

async function loadRestartSentinelStartupTask(params: {
  scheduler: GatewayScheduler;
  signal: AbortSignal;
  deps: CliDeps;
  attempt?: number;
  context: DeliveryQueueStateContext;
  shouldRun?: () => boolean;
  pendingUpdate?: PendingUpdateSentinelIdentity;
  trackWork?: (work: Promise<unknown>) => void;
}): Promise<StartupTask | null> {
  const noticeContext = params.context;
  const queueContext = noticeContext.workerContext;
  const env = queueContext.environment;
  const snapshot = await readRestartSentinelStartupSnapshot(params);
  if (!snapshot) {
    return null;
  }
  const { sentinel, pendingUpdate, pendingSnapshotSuperseded } = snapshot;
  let { updateRun } = snapshot;
  const payload = sentinel.payload;
  const sentinelRevision = sentinel.revision;
  if (payload.kind === "update") {
    recordLatestUpdateRestartSentinel(payload);
  }
  const sessionKey = payload.sessionKey?.trim();
  const message = formatRestartSentinelMessage(payload);
  const updateRunId = updateRun?.runId;
  let noticeMessage =
    payload.kind === "update"
      ? renderUpdateRunSummary(updateRun ?? updateRunReportInputFromSentinel(payload))
      : message;
  const summary = summarizeRestartSentinel(payload);

  const run = async () => {
    if (params.signal.aborted || params.shouldRun?.() === false) {
      return { status: "skipped" as const, reason: "gateway-stopped" };
    }
    let routedSessionKey = sessionKey;
    let wakeAgentId: string | undefined;
    if (isPendingControlPlaneUpdateRestartSentinel(payload) && !pendingSnapshotSuperseded) {
      const attempt = params.attempt ?? 0;
      if (attempt < CONTROL_PLANE_UPDATE_PENDING_MAX_ATTEMPTS) {
        const cancel = () => retry.cancel();
        const retry = params.scheduler.schedule({
          id: "restart-sentinel:pending-update",
          delayMs: CONTROL_PLANE_UPDATE_PENDING_RETRY_DELAY_MS,
          run: () => {
            params.signal.removeEventListener("abort", cancel);
            if (params.signal.aborted || params.shouldRun?.() === false) {
              return undefined;
            }
            const work = runWithGatewayIndependentRootWorkAdmission(
              () =>
                scheduleRestartSentinelWake({
                  ...params,
                  attempt: attempt + 1,
                  ...(pendingUpdate ? { pendingUpdate } : {}),
                }),
              "restart-sentinel:wake",
              params.signal,
            ).catch((err: unknown) => {
              if (!params.signal.aborted) {
                log.warn(
                  `restart sentinel pending update retry failed: ${formatErrorMessage(err)}`,
                );
              }
            });
            params.trackWork?.(work);
            return work;
          },
        });
        params.signal.addEventListener("abort", cancel, { once: true });
        return { status: "skipped" as const, reason: "update-restart-pending" };
      }
      log.warn(`${summary}: update restart sentinel remained pending after retry window`, {
        sessionKey,
        reason: payload.stats?.reason ?? null,
      });
      if (updateRunId) {
        // Expiry bounds notice delivery, not CLI verification. Only Gateway-owned
        // runs finish here; first-terminal-wins preserves completed CLI results.
        updateRun = await finalizeRestartUpdateRun(payload, true, noticeContext);
        if (updateRun) {
          noticeMessage = renderUpdateRunSummary(updateRun);
        }
      }
    }

    // A pending owner can outlive this retry window. Reserving the permanent
    // finished-notice key now would suppress its eventual verified report.
    if (updateRun?.status === "running") {
      return { status: "skipped" as const, reason: "update-restart-pending" };
    }

    if (!routedSessionKey) {
      if (
        updateRun?.trigger === "control-ui" &&
        !updateRun.origin.sessionKey &&
        !updateRun.origin.deliveryContext
      ) {
        await recordUpdateRunNoticeSkipped(updateRun.runId, "no delivery target", env);
        await clearRestartSentinelIfRevision(sentinelRevision, env);
        return { status: "ran" as const };
      }
      const targetlessCliOutcome =
        payload.kind === "update" &&
        updateRun?.trigger === "cli" &&
        !updateRun.origin.sessionKey &&
        !updateRun.origin.deliveryContext;
      const controlPlaneOnlyAcknowledgement =
        (payload.kind === "config-patch" ||
          payload.kind === "config-apply" ||
          targetlessCliOutcome) &&
        (typeof payload.message !== "string" || payload.message.trim().length === 0) &&
        !payload.deliveryContext &&
        payload.threadId == null;
      if (controlPlaneOnlyAcknowledgement) {
        // A targetless control-plane/CLI acknowledgement has no agent turn to
        // resume. An inferred wake can bootstrap an unrelated workspace on boot.
        const consumed = await clearRestartSentinelIfRevision(sentinelRevision, env);
        if (!consumed) {
          log.info(`${summary}: newer restart sentinel preserved while consuming acknowledgement`);
        }
        return { status: "ran" as const };
      }
      const systemTarget = resolveSystemMainSessionTarget(getRuntimeConfig());
      // Session-less recovery belongs to system work, never another agent's recent conversation.
      routedSessionKey = systemTarget.sessionKey;
      wakeAgentId = systemTarget.agentId;
    }

    const cfg = getRuntimeConfig();
    const sessionTarget = await resolveGatewaySessionStoreTargetInWorker({
      cfg,
      key: routedSessionKey,
      agentId: wakeAgentId,
      env,
      assertActive: () => queueContext.admission.assertCurrent(),
    });
    queueContext.admission.assertCurrent();
    const { canonicalKey } = sessionTarget;
    const match = findCanonicalStoreMatch(sessionTarget.store, sessionTarget.storeKeys);
    const entry = match?.entry;
    const session = {
      cfg,
      ...sessionTarget,
      entry,
      legacyKey: match?.key !== canonicalKey ? match?.key : undefined,
    };
    const target = await resolveUpdateRunNoticeTarget({
      cfg,
      sessionKey,
      session,
      env,
      explicitDeliveryContext: sessionKey ? payload.deliveryContext : undefined,
      threadId: sessionKey ? payload.threadId : undefined,
    });
    queueContext.admission.assertCurrent();
    if (target.kind === "none") {
      await recordUpdateRunNoticeSkipped(updateRunId, target.reason, env);
      // A diagnostic wake would bypass the same owner-only notice decision.
      await clearRestartSentinelIfRevision(sentinelRevision, env);
      return { status: "ran" as const };
    }
    const route = target.kind === "route" ? target.route : undefined;
    let noticeQueueId: string | undefined;
    let noticeQueueCreated = false;

    if (!updateRun?.verification.noticeDelivered && target.kind === "internal") {
      const { agentId, entry: internalEntry, storePath } = target.session;
      const append = updateRunId
        ? appendUpdateRunFinishedNotice
        : appendAssistantMessageToSessionTranscript;
      const notice = await append({
        agentId,
        sessionKey: canonicalKey,
        expectedSessionId: internalEntry.sessionId,
        expectedLifecycleRevision: internalEntry.lifecycleRevision ?? null,
        storePath,
        text: noticeMessage,
        idempotencyKey: updateRunId
          ? `update-run-finished:${updateRunId}`
          : `restart-sentinel-notice:${canonicalKey}:${sentinelRevision}`,
      }).catch((error: unknown) => ({ ok: false as const, reason: formatErrorMessage(error) }));
      if (notice.ok && updateRunId) {
        await recordUpdateRunVerification(updateRunId, { noticeDelivered: true }, { env });
      }
      if (!notice.ok) {
        log.warn(`${summary}: internal restart notice append failed: ${notice.reason}`, {
          sessionKey: canonicalKey,
        });
        throw new Error(`Restart notice could not be persisted: ${notice.reason}`);
      }
    }

    if (route && !updateRun?.verification.noticeDelivered) {
      const queuedNotice = await enqueueRestartSentinelNotice(
        {
          cfg,
          ...route,
          message: noticeMessage,
          sessionKey: canonicalKey,
          revision: sentinelRevision,
          ...(updateRunId ? { deliveryIntentId: `update-run-finished:${updateRunId}` } : {}),
        },
        noticeContext,
      );
      noticeQueueId = queuedNotice.id;
      noticeQueueCreated = queuedNotice.created;
    }

    // Every downstream intent is durable before consuming the singleton. A
    // failed or stale compare-delete cannot lose work or remove a newer row.
    const consumed = await clearRestartSentinelIfRevision(sentinelRevision, env);
    if (params.signal.aborted || params.shouldRun?.() === false) {
      return { status: "skipped" as const, reason: "gateway-stopped" };
    }
    if (!consumed) {
      log.info(`${summary}: newer restart sentinel preserved while draining durable work`, {
        sessionKey: canonicalKey,
      });
    }

    if (route && noticeQueueId && noticeQueueCreated) {
      const delivered = await deliverRestartSentinelNotice(
        {
          deps: params.deps,
          cfg,
          sessionKey: canonicalKey,
          summary,
          message: noticeMessage,
          ...route,
          queueId: noticeQueueId,
        },
        noticeContext,
      );
      if (delivered && updateRunId) {
        await recordUpdateRunVerification(updateRunId, { noticeDelivered: true }, { env });
      }
    } else if (noticeQueueId && !noticeQueueCreated) {
      log.info(`${summary}: durable restart notice already owned`, { sessionKey: canonicalKey });
    }

    return { status: "ran" as const };
  };

  return {
    source: "restart-sentinel",
    ...(sessionKey ? { sessionKey } : {}),
    run,
  };
}

export async function scheduleRestartSentinelWake(params: {
  scheduler: GatewayScheduler;
  signal: AbortSignal;
  deps: CliDeps;
  attempt?: number;
  context?: DeliveryQueueStateContext;
  shouldRun?: () => boolean;
  pendingUpdate?: PendingUpdateSentinelIdentity;
  trackWork?: (work: Promise<unknown>) => void;
}) {
  if (params.signal.aborted || params.shouldRun?.() === false) {
    return;
  }
  const task = await loadRestartSentinelStartupTask({
    ...params,
    context: params.context ?? captureDeliveryQueueStateContext(),
  });
  if (!task) {
    return;
  }
  await runStartupTasks({ tasks: [task], log });
}
