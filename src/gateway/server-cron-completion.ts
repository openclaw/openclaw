import type { NormalizeReplySkipReason } from "../auto-reply/reply/normalize-reply-skip-reason.js";
import type { CliDeps } from "../cli/deps.types.js";
import { resolveControlUiAutomationRunUrl } from "../config/control-ui-link-base.js";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { commitCronConversationResult } from "../cron/conversation-result.js";
import type { CronCompletionDeliveryFence } from "../cron/delivery-attempt-fence.js";
import { resolveCronDeliveryPlan, sendCronAnnouncePayloadStrict } from "../cron/delivery.js";
import {
  resolveDeliveryTarget,
  requiresExternalCronDelivery,
} from "../cron/isolated-agent/delivery-target.js";
import { createCronExecutionId } from "../cron/run-id.js";
import { resolveCronDeliverySessionKey } from "../cron/session-target.js";
import type { CronDeliveryTrace, CronStoredJob, CronResolvedDeliveryState } from "../cron/types.js";
import { formatErrorMessage } from "../infra/errors.js";
import type { getChildLogger } from "../logging.js";

export function pickDefined<T extends Record<string, unknown>>(
  obj: T,
  keys: (keyof T)[],
): Partial<T> {
  const result: Partial<T> = {};
  for (const k of keys) {
    if (obj[k] !== undefined) {
      result[k] = obj[k];
    }
  }
  return result;
}

export async function finalizeCronCompletionAnnouncement(params: {
  deliveryAttemptFence: CronCompletionDeliveryFence | null;
  job: CronStoredJob;
  text?: string;
  suppressionReason?: NormalizeReplySkipReason;
  runStartedAtMs?: number;
  abortSignal?: AbortSignal;
  deps: CliDeps;
  resolveCronAgent: (requested?: string | null) => { agentId: string; cfg: OpenClawConfig };
  logger: ReturnType<typeof getChildLogger>;
  label: string;
  traceResolvedFailure?: boolean;
}) {
  const plan = resolveCronDeliveryPlan(params.job);
  const delivery: CronDeliveryTrace = {
    intended: pickDefined(
      {
        channel: plan.channel,
        to: plan.to,
        accountId: plan.accountId,
        threadId: plan.threadId,
        source: "explicit" as const,
      },
      ["channel", "to", "accountId", "threadId", "source"],
    ),
  };
  if (plan.mode !== "announce") {
    return { deliveryAttempted: false, delivered: false, delivery };
  }
  const deliveryState: CronResolvedDeliveryState = {
    status: "not-delivered",
    delivered: false,
    failureNotification: { status: "not-requested" },
  };
  const finish = (deliveryAttempted: boolean) => ({
    deliveryAttempted,
    delivered: deliveryState.delivered,
    deliveryError: deliveryState.error,
    deliverySuppressionReason: deliveryState.deliverySuppressionReason,
    deliveryState,
    delivery: { ...delivery, delivered: deliveryState.delivered },
  });
  if (params.text === undefined) {
    deliveryState.deliverySuppressionReason = params.suppressionReason ?? "empty";
    return finish(false);
  }

  const { agentId, cfg } = params.resolveCronAgent(params.job.agentId);
  const inspectUrl = resolveControlUiAutomationRunUrl(cfg, {
    jobId: params.job.id,
    runId:
      params.runStartedAtMs === undefined
        ? undefined
        : createCronExecutionId(params.job.id, params.runStartedAtMs),
  });
  // Command summaries are already redacted; adding the link earlier would strip its URL.
  const text = inspectUrl ? `${params.text}\nInspect: ${inspectUrl}` : params.text;
  const abortSignal = params.abortSignal ?? new AbortController().signal;
  try {
    const conversation = params.job.sourceConversation;
    if (conversation) {
      if (params.runStartedAtMs === undefined) {
        throw new Error("cron result is missing its occurrence start time");
      }
      const result = await commitCronConversationResult({
        config: cfg,
        agentId,
        jobId: params.job.id,
        runStartedAt: params.runStartedAtMs,
        conversation,
        payloads: [{ text: params.text }],
        signal: abortSignal,
        deliveryAttemptFence: params.deliveryAttemptFence,
      });
      if (!result.ok) {
        deliveryState.error = result.reason;
        return finish(true);
      }
    }
    const resolved = await resolveDeliveryTarget(cfg, agentId, {
      ...plan,
      sessionKey: resolveCronDeliverySessionKey(params.job),
      sessionTarget: conversation ? params.job.sessionTarget : undefined,
      sourceConversation: conversation,
    });
    if (!resolved.ok && conversation && !requiresExternalCronDelivery(plan, resolved)) {
      deliveryState.status = "delivered";
      deliveryState.delivered = true;
      return finish(true);
    }
    if (!resolved.ok) {
      throw resolved.error;
    }
    const result = await sendCronAnnouncePayloadStrict({
      deps: params.deps,
      cfg,
      agentId,
      jobId: params.job.id,
      target: { ...resolved, sessionKey: resolveCronDeliverySessionKey(params.job) },
      payload: { text },
      abortSignal,
      sessionGeneration: conversation
        ? {
            agentId,
            storePath: resolveSessionStorePathCore(cfg.session?.store, { agentId }),
            ...conversation,
            lifecycleRevision: conversation.lifecycleRevision ?? null,
          }
        : undefined,
      ...(params.runStartedAtMs === undefined
        ? {}
        : {
            completion: {
              job: params.job,
              runStartedAt: params.runStartedAtMs,
              deliveryAttemptFence: params.deliveryAttemptFence,
            },
          }),
    });
    if (result.status === "sent") {
      deliveryState.status = "delivered";
      deliveryState.delivered = true;
    } else if (result.skipReason) {
      deliveryState.deliverySuppressionReason = result.skipReason;
    } else {
      const uncertain = result.reason === "adapter_returned_no_identity";
      deliveryState.status = uncertain ? "unknown" : "not-delivered";
      deliveryState.delivered = uncertain ? undefined : false;
      deliveryState.error = `cron delivery ${uncertain ? "outcome is unknown" : "was suppressed"}: ${result.reason}`;
    }
    return finish(true);
  } catch (err) {
    const deliveryError = formatErrorMessage(err);
    params.logger.warn(
      { jobId: params.job.id, err: deliveryError },
      `cron: ${params.label} delivery failed`,
    );
    deliveryState.error = deliveryError;
    if (params.traceResolvedFailure) {
      delivery.resolved = {
        channel: plan.channel,
        to: plan.to,
        accountId: plan.accountId,
        threadId: plan.threadId,
        source: "explicit",
        ok: false,
        error: deliveryError,
      };
    }
    return finish(true);
  }
}
