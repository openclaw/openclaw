/** Scheduled shared-session turns use the ordinary reply admission and delivery owners. */
import type { AdmittedRunOperatorAuthority } from "../agents/admitted-run-context.js";
import { resolveCronStyleNow } from "../agents/current-time.js";
import {
  captureSessionEventTargetForHost as captureSessionEventTarget,
  enqueueSessionEventForHost as enqueueSessionEvent,
} from "../auto-reply/reply/session-event-handoff.js";
import { getRuntimeConfig } from "../config/config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveSystemEventQueueKey } from "../infra/system-event-ownership.js";
import { prepareAutomationSystemEvents } from "../infra/system-events.js";
import { parseAgentSessionKey } from "../routing/session-key.js";
import { resolveHookExternalContentSource } from "../security/external-content-source.js";
import { isCronWithinActiveHours } from "./active-hours.js";
import { isCronExecutionIdle } from "./execution-idle.js";
import { requiresExternalCronDelivery } from "./isolated-agent/delivery-target.js";
import {
  buildCronDeliveryTrace,
  finalizeCronPromptForResolvedTools,
  resolveCronDeliveryContext,
} from "./isolated-agent/run-delivery-trace.js";
import { resolveCronAgentSessionKey } from "./isolated-agent/session-key.js";
import { CronOperatorSourceError } from "./operator-source-error.js";
import { appendCronJobScratchPrompt, buildCronCommandBody } from "./run-prompt.js";
import { isCronScratchEffectivelyEmpty } from "./scratch-contract.js";
import { readCronScratchSnapshot } from "./scratch-read.js";
import type { CronServiceDeps } from "./service/state.js";
import { resolveCronDeliverySessionKey } from "./session-target.js";
import { resolveCronJobsStorePathFromConfigAsync } from "./store.js";
import type { CronResolvedDeliveryState } from "./types.js";

type SessionRun = NonNullable<CronServiceDeps["runSessionEvent"]>;

export async function runCronSessionTurn(
  params: Parameters<SessionRun>[0] & {
    cfg: OpenClawConfig;
    agentId: string;
    sessionKey: string;
  },
): ReturnType<SessionRun> {
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
  const notices =
    params.sessionPreparation?.notices ??
    (await prepareAutomationSystemEvents(queueKey, job.id, job.state.runningAtMs));
  let noticesStarted = false;
  let operatorAuthority: AdmittedRunOperatorAuthority | undefined;
  let controlUiAdmin: true | undefined;
  using operatorLease = new DisposableStack();
  const assertCurrent = () => {
    params.assertCurrent();
    operatorAuthority?.assertCurrent();
    if (!noticesStarted) {
      notices.assertCurrent();
    }
  };
  try {
    const delivery =
      job.payload.kind === "agentTurn" ? await resolveCronDeliveryContext(params) : undefined;
    assertCurrent();
    const expectedTarget = await captureSessionEventTarget(params.agentId, params.sessionKey, {
      assertCurrent,
    });
    assertCurrent();
    if (job.operatorSource) {
      const { restoreCronOperatorSource } = await import("../gateway/cron-operator-source.js");
      const operator = await restoreCronOperatorSource({
        job,
        agentId: params.agentId,
        sessionKey: params.sessionKey,
        entry: expectedTarget,
        signal: params.abortSignal,
        deliveryAttemptFence: params.deliveryAttemptFence,
      });
      if (operator) {
        operatorLease.defer(operator.release);
        operatorAuthority = operator.authority;
        controlUiAdmin = operator.controlUiAdmin ? true : undefined;
      }
      assertCurrent();
    }
    const requestedChat = delivery?.deliveryRequested && delivery.deliveryPlan.mode !== "webhook";
    const deliverySessionKey = resolveCronDeliverySessionKey(job);
    // Only a result committed to this same destination can satisfy an internal announcement.
    const conversationDelivery = Boolean(
      requestedChat &&
      delivery &&
      !delivery.resolvedDelivery.ok &&
      !delivery.resolvedDelivery.sourceConversationUnavailable &&
      !requiresExternalCronDelivery(delivery.deliveryPlan, delivery.resolvedDelivery) &&
      deliverySessionKey &&
      resolveSystemEventQueueKey(
        resolveCronAgentSessionKey({
          sessionKey: deliverySessionKey,
          agentId: params.agentId,
          mainKey: params.cfg.session?.mainKey,
          cfg: params.cfg,
        }),
        params.agentId,
      ) === queueKey,
    );
    const deliverySuppressionReason =
      delivery && !delivery.resolvedDelivery.ok
        ? delivery.resolvedDelivery.deliverySuppressionReason
        : undefined;
    const deliveryError =
      requestedChat &&
      !delivery.resolvedDelivery.ok &&
      !conversationDelivery &&
      !deliverySuppressionReason
        ? delivery.resolvedDelivery.error.message
        : undefined;
    // Failed owner resolution cannot inherit a remembered group route.
    const route = delivery
      ? delivery.resolvedDelivery.ok
        ? delivery.resolvedDelivery
        : undefined
      : params.deliveryContext;
    let checkedDeliveryConfig: OpenClawConfig | undefined;
    const assertDeliveryCurrent = () => {
      // Delivery owners also assert before the first preparation; beforeDeliver
      // pins policy before transport custody and every subsequent effect check.
      if (checkedDeliveryConfig && checkedDeliveryConfig !== getRuntimeConfig()) {
        throw new Error("Automation delivery policy changed before send");
      }
    };
    const beforeDeliver = async () => {
      await params.prepare?.();
      assertCurrent();
      const cfg = getRuntimeConfig();
      if (delivery) {
        const current = await resolveCronDeliveryContext({ ...params, cfg });
        assertCurrent();
        const sameRoute = conversationDelivery
          ? !current.resolvedDelivery.ok &&
            !current.resolvedDelivery.sourceConversationUnavailable &&
            !requiresExternalCronDelivery(current.deliveryPlan, current.resolvedDelivery)
          : current.resolvedDelivery.ok &&
            route &&
            current.resolvedDelivery.channel === route.channel &&
            current.resolvedDelivery.to === route.to &&
            current.resolvedDelivery.accountId === route.accountId &&
            current.resolvedDelivery.threadId === route.threadId;
        if (!current.deliveryRequested || !sameRoute) {
          throw new Error(
            "Automation delivery policy or route changed while queued; inspect the run and retry with the current destination",
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
          await resolveCronJobsStorePathFromConfigAsync(params.cfg),
          { kind: "job", jobId: job.id, createdAtMsFallback: job.createdAtMs },
          {},
          { assertCurrent, signal: params.abortSignal },
        )
      )?.state
    )?.scratch;
    assertCurrent();
    if (
      notices.events.length === 0 &&
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
    const baseSessionKey = parseAgentSessionKey(params.sessionKey)?.rest ?? params.sessionKey;
    const externalSource =
      (job.payload.kind === "agentTurn" ? job.payload.externalContentSource : undefined) ??
      resolveHookExternalContentSource(baseSessionKey);
    const promptTimeMs = Date.now();
    let sessionId: string | undefined;
    const receipt = enqueueSessionEvent(params.text, {
      agentId: params.agentId,
      sessionKey: params.sessionKey,
      source: "cron",
      contextKey: `cron:${job.id}`,
      expectedTarget,
      createIfMissing: true,
      deliveryContext: route,
      abortSignal: params.abortSignal,
      scheduledAutomation: {
        job,
        occurrence: params.occurrence,
        operatorAuthority,
        controlUiAdmin,
        admissionSource: params.admissionSource,
        prepare: params.prepare,
        preparePrompt: async (cfg) => {
          const { applyLegacyHeartbeatPromptContribution } =
            await import("../infra/heartbeat-compat.js");
          const message = await applyLegacyHeartbeatPromptContribution({
            cfg,
            jobId: job.id,
            name: job.name,
            agentId: params.agentId,
            sessionKey: expectedTarget.sessionKey!,
            prompt: params.text,
            assertCurrent,
          });
          assertCurrent();
          const { commandBody } = await buildCronCommandBody({
            job,
            cfg,
            message,
            baseSessionKey,
            hookExternalContentSource: externalSource,
            ...resolveCronStyleNow(cfg, promptTimeMs),
          });
          assertCurrent();
          const prompt = appendCronJobScratchPrompt(commandBody, scratch);
          return notices.events.length
            ? `${prompt}\n\nPending session notices:\n${notices.events.map((event) => event.text).join("\n")}`
            : prompt;
        },
        executionIdentity: params.executionIdentity,
        deliveryAttemptFence:
          requestedChat && (route || conversationDelivery)
            ? {
                beforeAttempt: beforeDeliver,
                assertCurrent: () => {
                  params.deliveryAttemptFence?.assertCurrent();
                  assertDeliveryCurrent();
                },
              }
            : params.deliveryAttemptFence,
        assertCurrent,
        bindSessionCreation: (operation) => notices.bindCreation(operation),
        beforeDeliver,
        assertDeliveryCurrent,
        waitForIdle: params.waitForIdle
          ? (signal, operation) => params.waitForIdle!(expectedTarget.sessionKey, signal, operation)
          : undefined,
        beforeStart: (operation) => {
          const cfg = getRuntimeConfig();
          if (
            !isCronWithinActiveHours(
              job.activeHours,
              Date.now(),
              cfg.agents?.defaults?.userTimezone,
            )
          ) {
            return "active-hours";
          }
          return job.idleOnly &&
            !isCronExecutionIdle(cfg, job, params.agentId, expectedTarget.sessionKey, operation)
            ? "busy"
            : true;
        },
        onStarted: () => {
          notices.start();
          noticesStarted = true;
        },
        sourceDelivery: delivery?.sourceDelivery,
        finalizePromptForResolvedTools: delivery
          ? (candidate) =>
              finalizeCronPromptForResolvedTools({
                ...candidate,
                deliveryRequested: delivery.deliveryRequested,
                resolvedDelivery: delivery.resolvedDelivery,
                sourceDelivery: delivery.sourceDelivery,
                messageToolFormatPrompt: delivery.messageToolFormatPrompt,
              })
          : undefined,
        onLaneWait: params.onLaneWait,
        onExecutionStarted: (info) => {
          sessionId = info.sessionId;
          params.onExecutionStarted?.({
            jobId: job.id,
            agentId: params.agentId,
            sessionId,
            sessionKey: info.sessionKey,
            runId: info.runId,
            provider: info.provider,
            model: info.model,
            isFallback: info.isFallback,
            phase: "runner_entered",
          });
        },
        onExecutionPhase: params.onExecutionPhase,
      },
      deliver: delivery
        ? Boolean(requestedChat && !deliveryError && !deliverySuppressionReason)
        : true,
    });
    // Source, notice, and Cron custody remain live until the controller settles.
    const result = await receipt.settled;
    const conversationDelivered =
      conversationDelivery && result.conversationResultCommitted === true;
    const delivered = result.deliveryAmbiguous
      ? undefined
      : result.delivered || conversationDelivered;
    return {
      ...result.automationResult,
      status: result.admissionDeferred ? "skipped" : result.status === "completed" ? "ok" : "error",
      admissionDeferred: result.admissionDeferred,
      admissionDeferredReason: result.admissionDeferredReason,
      interruptedByRestart: result.interruptedByRestart,
      error:
        result.error ??
        (result.status === "cancelled" ? "Automation session turn was cancelled" : undefined),
      summary: result.summary,
      sessionId,
      sessionKey: expectedTarget.sessionKey,
      executionStarted: result.executionStarted,
      delivered,
      deliveryState: result.deliveryAmbiguous
        ? ({
            status: "unknown",
            failureNotification: { status: "not-requested" },
          } satisfies CronResolvedDeliveryState)
        : undefined,
      deliveryError: result.deliveryError ?? deliveryError,
      deliveryAttempted: result.deliveryAttempted || conversationDelivered,
      deliverySuppressionReason: result.deliverySuppressionReason ?? deliverySuppressionReason,
      ...(delivery
        ? {
            delivery: buildCronDeliveryTrace({
              deliveryPlan: delivery.deliveryPlan,
              resolvedDelivery: delivery.resolvedDelivery,
              sourceDeliveryOutcome: result.sourceDeliveryOutcome ?? {
                visibleDeliveries: [],
                verifiedMessageToolDelivery: false,
                satisfiesSourceDelivery: delivered === true,
                unverifiedMessageToolDelivery: false,
              },
              fallbackUsed: conversationDelivered,
              delivered,
            }),
          }
        : {}),
      ...(result.nextCheckMs !== undefined ? { nextCheck: { delayMs: result.nextCheckMs } } : {}),
    };
  } catch (error) {
    if (!(error instanceof CronOperatorSourceError)) {
      throw error;
    }
    return {
      status: "error",
      error: error.message,
      errorClassification: { kind: "permanent" },
      executionStarted: false,
    };
  } finally {
    if (!params.sessionPreparation) {
      notices.release();
    }
  }
}
