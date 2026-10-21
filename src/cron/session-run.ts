/** Scheduled shared-session turns use the ordinary reply admission and delivery owners. */
import type { AdmittedRunOperatorAuthority } from "../agents/admitted-run-context.js";
import { resolveCronStyleNow } from "../agents/current-time.js";
import {
  captureSessionEventTargetForHost as captureSessionEventTarget,
  enqueueSessionEventForHost as enqueueSessionEvent,
} from "../auto-reply/reply/session-event-handoff.js";
import { getRuntimeConfig } from "../config/config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { parseAgentSessionKey } from "../routing/session-key.js";
import { resolveHookExternalContentSource } from "../security/external-content-source.js";
import {
  buildCronDeliveryTrace,
  finalizeCronPromptForResolvedTools,
  resolveCronDeliveryContext,
} from "./isolated-agent/run-delivery-trace.js";
import { buildCronCommandBody } from "./run-prompt.js";
import type { CronServiceDeps } from "./service/state.js";
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
  let operatorAuthority: AdmittedRunOperatorAuthority | undefined;
  let controlUiAdmin: true | undefined;
  using operatorLease = new DisposableStack();
  const assertCurrent = () => {
    params.assertCurrent();
    operatorAuthority?.assertCurrent();
  };
  const delivery = await resolveCronDeliveryContext(params);
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
  const requestedChat = delivery.deliveryRequested && delivery.deliveryPlan.mode !== "webhook";
  const deliveryError =
    requestedChat && !delivery.resolvedDelivery.ok
      ? delivery.resolvedDelivery.error.message
      : undefined;
  // A failed destination resolution must not fall back to the conversation's last route.
  const route = delivery.resolvedDelivery.ok ? delivery.resolvedDelivery : undefined;
  const beforeDeliver = async () => {
    await params.prepare?.();
    assertCurrent();
    const cfg = getRuntimeConfig();
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
        "Automation delivery policy or route changed while queued; inspect the run and retry with the current destination",
      );
    }
    await params.deliveryAttemptFence?.beforeAttempt();
    assertCurrent();
  };
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
      operatorAuthority,
      controlUiAdmin,
      admissionSource: params.admissionSource,
      prepare: params.prepare,
      preparePrompt: async (cfg) => {
        const { commandBody } = await buildCronCommandBody({
          job,
          cfg,
          message: params.text,
          baseSessionKey,
          hookExternalContentSource: externalSource,
          ...resolveCronStyleNow(cfg, promptTimeMs),
        });
        return commandBody;
      },
      executionIdentity: params.executionIdentity,
      deliveryAttemptFence:
        requestedChat && route && params.deliveryAttemptFence
          ? { ...params.deliveryAttemptFence, beforeAttempt: beforeDeliver }
          : params.deliveryAttemptFence,
      assertCurrent,
      beforeDeliver,
      sourceDelivery: delivery.sourceDelivery,
      finalizePromptForResolvedTools: (candidate) =>
        finalizeCronPromptForResolvedTools({
          ...candidate,
          deliveryRequested: delivery.deliveryRequested,
          resolvedDelivery: delivery.resolvedDelivery,
          sourceDelivery: delivery.sourceDelivery,
          messageToolFormatPrompt: delivery.messageToolFormatPrompt,
        }),
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
    deliver: requestedChat && !deliveryError,
  });
  // The source lease and Cron receipt remain live until the admitted turn settles.
  const result = await receipt.settled;
  return {
    ...result.automationResult,
    status: result.status === "completed" ? "ok" : "error",
    interruptedByRestart: result.interruptedByRestart,
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
    deliveryError: result.deliveryError ?? deliveryError,
    deliveryAttempted: result.deliveryAttempted,
    deliverySuppressionReason: result.deliverySuppressionReason,
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
    ...(result.nextCheckMs !== undefined ? { nextCheck: { delayMs: result.nextCheckMs } } : {}),
  };
}
