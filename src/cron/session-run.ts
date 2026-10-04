/** Scheduled shared-session turns use the normal reply admission and delivery owners. */
import type { AdmittedRunContext } from "../agents/admitted-run-context.js";
import { sliceToolResultTextToBudget } from "../agents/embedded-agent-runner/tool-result-text-budget.js";
import {
  captureSessionEventTargetForHost as captureSessionEventTarget,
  enqueueSessionEventForHost as enqueueSessionEvent,
} from "../auto-reply/reply/session-event-handoff.js";
import { getRuntimeConfig } from "../config/config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveSystemEventQueueKey } from "../infra/system-event-ownership.js";
import { prepareAutomationSystemEvents } from "../infra/system-events.js";
import type { DeliveryContext } from "../utils/delivery-context.types.js";
import { isCronWithinActiveHours } from "./active-hours.js";
import type { CronCompletionDeliveryFence } from "./delivery-attempt-fence.js";
import { resolveCronOwnerDeliverySkip } from "./delivery-plan.js";
import { isCronExecutionIdle } from "./execution-idle.js";
import {
  buildCronDeliveryTrace,
  resolveCronDeliveryContext,
} from "./isolated-agent/run-delivery-trace.js";
import { appendCronUnattendedRunPreamble, appendCronJobScratchPrompt } from "./run-prompt.js";
import { isCronScratchEffectivelyEmpty } from "./scratch-contract.js";
import { readCronScratchSnapshot } from "./scratch-read.js";
import { captureCronCapacityLease } from "./service/run-admission-capacity.js";
import type {
  CronExecutionIdentityAdmission,
  CronRunDeliveryResult,
  CronSessionRunPreparation,
} from "./service/state.js";
import { resolveCronJobsStorePathFromConfig } from "./store.js";
import type {
  CronStoredJob,
  CronAgentExecutionStarted,
  CronResolvedDeliveryState,
  CronRunOutcome,
  CronRunTelemetry,
  CronNextCheckProposal,
} from "./types.js";

export async function runCronSessionTurn(params: {
  admissionSource: NonNullable<AdmittedRunContext["admissionSource"]>;
  sessionPreparation?: CronSessionRunPreparation;
  deliveryAttemptFence: CronCompletionDeliveryFence | null;
  executionIdentity?: CronExecutionIdentityAdmission;
  prepare?: () => Promise<void>;
  onExecutionStarted?: (info?: CronAgentExecutionStarted) => void;
  onLaneWait?: (info?: { waiting?: boolean }) => void;
  cfg: OpenClawConfig;
  agentId: string;
  sessionKey: string;
  job: CronStoredJob;
  text: string;
  abortSignal?: AbortSignal;
  assertCurrent: () => void;
  deliveryContext?: DeliveryContext;
}): Promise<
  CronRunOutcome & CronRunTelemetry & CronRunDeliveryResult & { nextCheck?: CronNextCheckProposal }
> {
  const { job } = params;
  await params.prepare?.();
  params.assertCurrent();
  const queueKey = resolveSystemEventQueueKey(params.sessionKey, params.agentId);
  if (
    params.sessionPreparation &&
    (params.sessionPreparation.agentId !== params.agentId ||
      resolveSystemEventQueueKey(
        params.sessionPreparation.sessionKey,
        params.sessionPreparation.agentId,
      ) !== queueKey)
  ) {
    throw new Error("Automation session target changed after notice preparation");
  }
  const deferred =
    params.sessionPreparation?.notices ?? (await prepareAutomationSystemEvents(queueKey, job.id));
  let noticesStarted = false;
  const assertCurrent = () => {
    params.assertCurrent();
    if (!noticesStarted) {
      deferred.assertCurrent();
    }
  };
  try {
    assertCurrent();
    const delivery =
      job.payload.kind === "agentTurn" ? await resolveCronDeliveryContext(params) : undefined;
    assertCurrent();
    const skipped = delivery && resolveCronOwnerDeliverySkip(delivery);
    if (skipped && deferred.events.length === 0) {
      return skipped;
    }
    const expectedTarget = await captureSessionEventTarget(params.agentId, params.sessionKey);
    assertCurrent();
    const requestedChat = delivery?.deliveryRequested && delivery.deliveryPlan.mode !== "webhook";
    const deliverySuppressionReason =
      delivery && !delivery.resolvedDelivery.ok
        ? delivery.resolvedDelivery.deliverySuppressionReason
        : undefined;
    const deliveryError =
      requestedChat && !delivery.resolvedDelivery.ok && !deliverySuppressionReason
        ? delivery.resolvedDelivery.error.message
        : undefined;
    // Resolution failure is a closed delivery decision. Never inherit the last
    // route (possibly a group) when an owner or explicit target failed to resolve.
    const route = delivery
      ? delivery.resolvedDelivery.ok
        ? delivery.resolvedDelivery
        : undefined
      : params.deliveryContext;
    let checkedDeliveryConfig: OpenClawConfig | undefined;
    const beforeDeliver = async () => {
      await params.prepare?.();
      assertCurrent();
      const cfg = getRuntimeConfig();
      if (delivery) {
        const current = await resolveCronDeliveryContext({ ...params, cfg });
        assertCurrent();
        if (
          !current.deliveryRequested ||
          !current.resolvedDelivery.ok ||
          !route ||
          current.resolvedDelivery.channel !== route.channel ||
          current.resolvedDelivery.to !== route.to ||
          current.resolvedDelivery.accountId !== route.accountId ||
          current.resolvedDelivery.threadId !== route.threadId
        ) {
          throw new Error(
            "Automation delivery policy or owner route changed while queued; inspect the run and retry with the current destination",
          );
        }
      }
      await params.deliveryAttemptFence?.beforeAttempt();
      assertCurrent();
      checkedDeliveryConfig = cfg;
    };
    const scratch = (
      params.sessionPreparation?.scratch ??
      (
        await readCronScratchSnapshot(
          resolveCronJobsStorePathFromConfig(params.cfg),
          { kind: "job", jobId: job.id, createdAtMsFallback: job.createdAtMs },
          {},
          { assertCurrent, signal: params.abortSignal },
        )
      )?.state
    )?.scratch;
    assertCurrent();
    if (
      deferred.events.length === 0 &&
      job.payload.kind === "agentTurn" &&
      job.payload.skipIfScratchEmpty &&
      isCronScratchEffectivelyEmpty(scratch?.content)
    ) {
      return {
        status: "skipped",
        summary: "Automation scratch is explicitly empty",
        executionStarted: false,
        delivered: false,
        deliveryAttempted: false,
      };
    }
    const externalSource =
      job.payload.kind === "agentTurn" ? job.payload.externalContentSource : undefined;
    const { applyLegacyHeartbeatPromptContribution } = await import("../infra/heartbeat-compat.js");
    let message = await applyLegacyHeartbeatPromptContribution({
      cfg: params.cfg,
      jobId: job.id,
      name: job.name,
      agentId: params.agentId,
      sessionKey: expectedTarget.sessionKey!,
      prompt: params.text,
      assertCurrent,
    });
    if (
      externalSource &&
      job.payload.kind === "agentTurn" &&
      !job.payload.allowUnsafeExternalContent
    ) {
      const { buildSafeExternalPrompt } =
        await import("./isolated-agent/run-external-content.runtime.js");
      message = buildSafeExternalPrompt({
        content: message,
        source: externalSource === "gmail" ? "email" : "webhook",
        jobName: job.name,
        jobId: job.id,
        timestamp: new Date().toISOString(),
      });
      assertCurrent();
    }
    let text = appendCronUnattendedRunPreamble(message, { externalHook: Boolean(externalSource) });
    text = appendCronJobScratchPrompt(text, scratch);
    if (deferred.events.length) {
      text += `\n\nPending session notices:\n${sliceToolResultTextToBudget(deferred.events.map((event) => event.text).join("\n"), 2000)}`;
    }
    assertCurrent();
    let sessionId: string | undefined;
    params.onLaneWait?.({ waiting: true });
    const receipt = enqueueSessionEvent(text, {
      agentId: params.agentId,
      sessionKey: params.sessionKey,
      source: "cron",
      contextKey: `cron:${job.id}`,
      expectedTarget,
      deliveryContext: route,
      abortSignal: params.abortSignal,
      scheduledAutomation: {
        job,
        admissionSource: params.admissionSource,
        prepare: params.prepare,
        executionIdentity: params.executionIdentity,
        deliveryAttemptFence: params.deliveryAttemptFence,
        assertCurrent,
        capacity: captureCronCapacityLease(),
        beforeDeliver,
        sourceDelivery: delivery?.sourceDelivery,
        beforeStart: () => {
          const cfg = getRuntimeConfig();
          return (
            isCronWithinActiveHours(
              job.activeHours,
              Date.now(),
              cfg.agents?.defaults?.userTimezone,
            ) &&
            (!job.idleOnly ||
              isCronExecutionIdle(cfg, job, params.agentId, expectedTarget.sessionKey))
          );
        },
        onStarted: () => {
          deferred.start();
          noticesStarted = true;
        },
        onExecutionStarted: (info) => {
          sessionId = info.sessionId;
          params.onLaneWait?.({ waiting: false });
          params.onExecutionStarted?.({
            jobId: job.id,
            agentId: params.agentId,
            sessionId,
            sessionKey: info.sessionKey,
            runId: info.runId,
            phase: "runner_entered",
          });
        },
        assertDeliveryCurrent: () => {
          if (checkedDeliveryConfig !== getRuntimeConfig()) {
            throw new Error("Automation delivery policy changed before send");
          }
        },
      },
      deliver: delivery
        ? Boolean(requestedChat && !deliveryError && !deliverySuppressionReason)
        : true,
    });
    const result = await receipt.settled;
    const admissionDeferred = result.admissionDeferred;
    return {
      status: admissionDeferred
        ? ("skipped" as const)
        : result.status === "completed"
          ? ("ok" as const)
          : ("error" as const),
      admissionDeferred,
      error:
        result.error ??
        (result.status === "cancelled" ? "Automation session turn was cancelled" : undefined),
      summary: result.summary,
      sessionId,
      sessionKey: expectedTarget.sessionKey,
      executionStarted: result.executionStarted,
      delivered: result.deliveryAmbiguous ? undefined : result.delivered,
      deliveryState: result.deliveryAmbiguous
        ? ({
            status: "unknown",
            failureNotification: { status: "not-requested" },
          } satisfies CronResolvedDeliveryState)
        : undefined,
      deliveryError,
      deliveryAttempted: result.deliveryAttempted,
      deliverySuppressionReason: result.deliverySuppressionReason ?? deliverySuppressionReason,
      ...(delivery
        ? {
            delivery: buildCronDeliveryTrace({
              deliveryPlan: delivery.deliveryPlan,
              resolvedDelivery: delivery.resolvedDelivery,
              sourceDeliveryOutcome: result.sourceDeliveryOutcome ?? {
                visibleDeliveries: [],
                verifiedMessageToolDelivery: false,
                satisfiesSourceDelivery: result.delivered && !result.deliveryAmbiguous,
                unverifiedMessageToolDelivery: false,
              },
              fallbackUsed: false,
              delivered: result.deliveryAmbiguous ? undefined : result.delivered,
            }),
          }
        : {}),
      ...(result.nextCheckMs !== undefined ? { nextCheck: { delayMs: result.nextCheckMs } } : {}),
    };
  } finally {
    if (!params.sessionPreparation) {
      deferred.release();
    }
  }
}
