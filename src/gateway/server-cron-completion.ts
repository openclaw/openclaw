import type { NormalizeReplySkipReason } from "../auto-reply/reply/normalize-reply-skip-reason.js";
import type { CliDeps } from "../cli/deps.types.js";
import { resolveControlUiAutomationRunUrl } from "../config/control-ui-link-base.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { commitCronConversationResult } from "../cron/conversation-result.js";
import type { CronCompletionDeliveryFence } from "../cron/delivery-attempt-fence.js";
import { hasExplicitCronDeliveryTarget } from "../cron/delivery-target-validation.js";
import { resolveCronDeliveryPlan, sendCronAnnouncePayloadStrict } from "../cron/delivery.js";
import { normalizeDirectCronDeliveryPayloads } from "../cron/isolated-agent/delivery-payload-normalization.js";
import {
  resolveDeliveryTarget,
  requiresExternalCronDelivery,
} from "../cron/isolated-agent/delivery-target.js";
import {
  createCronRunDiagnosticsFromError,
  mergeCronRunDiagnostics,
} from "../cron/run-diagnostics.js";
import { createCronExecutionId } from "../cron/run-id.js";
import { resolveCronDeliverySessionKey } from "../cron/session-target.js";
import type {
  CronDeliveryTrace,
  CronStoredJob,
  CronResolvedDeliveryState,
  CronRunDiagnostics,
} from "../cron/types.js";
import { formatErrorMessage } from "../infra/errors.js";
import type { getChildLogger } from "../logging.js";
import { toAgentStoreSessionKey } from "../routing/session-key.js";

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
  diagnostics?: CronRunDiagnostics;
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
  let diagnostics = params.diagnostics;
  const finish = (deliveryAttempted: boolean) => ({
    deliveryAttempted,
    delivered: deliveryState.delivered,
    deliveryError: deliveryState.error,
    deliverySuppressionReason: deliveryState.deliverySuppressionReason,
    deliveryState,
    delivery: { ...delivery, delivered: deliveryState.delivered },
    ...(diagnostics ? { diagnostics } : {}),
  });
  const normalized = normalizeDirectCronDeliveryPayloads({
    deliveryPayloads: [{ text: params.text }],
  });
  if (normalized.kind === "suppress") {
    deliveryState.deliverySuppressionReason = params.suppressionReason ?? normalized.reason;
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
  const abortSignal = params.abortSignal ?? new AbortController().signal;
  let mayHaveReachedRecipient = false;
  try {
    const resolved = await resolveDeliveryTarget(cfg, agentId, {
      ...plan,
      sessionKey: resolveCronDeliverySessionKey(params.job),
      sessionTarget: params.job.sourceConversation ? params.job.sessionTarget : undefined,
      sourceConversation: params.job.sourceConversation,
    });
    if (!resolved.ok && requiresExternalCronDelivery(plan, resolved)) {
      throw resolved.error;
    }
    const conversation = resolved.ok ? undefined : params.job.sourceConversation;
    if ((conversation || resolved.ok) && params.runStartedAtMs === undefined) {
      throw new Error("cron result is missing its occurrence start time");
    }
    if (!resolved.ok && !conversation) {
      throw resolved.error;
    }
    if (resolved.ok) {
      const result = await sendCronAnnouncePayloadStrict({
        deps: params.deps,
        cfg,
        agentId,
        jobId: params.job.id,
        target: resolved,
        transcriptRoute: resolved.sessionRoute,
        transcriptExpectedGeneration:
          params.job.sourceConversation &&
          !hasExplicitCronDeliveryTarget(plan) &&
          resolved.sessionRoute?.sessionKey ===
            toAgentStoreSessionKey({
              agentId,
              requestKey: params.job.sourceConversation.sessionKey,
              mainKey: cfg.session?.mainKey,
            })
            ? params.job.sourceConversation
            : undefined,
        onTranscriptDiagnostic: (message) => {
          diagnostics = mergeCronRunDiagnostics(
            diagnostics,
            createCronRunDiagnosticsFromError("delivery", message, { severity: "warn" }),
          );
        },
        payload: normalized.payload,
        inspectionUrl: inspectUrl,
        abortSignal,
        ...(params.runStartedAtMs === undefined
          ? {}
          : {
              completion: {
                job: params.job,
                runStartedAt: params.runStartedAtMs,
                deliveryAttemptFence: params.deliveryAttemptFence,
              },
            }),
        onDeliveryAttempt: (reachedRecipient) => {
          mayHaveReachedRecipient ||= reachedRecipient;
        },
      });
      if (result.status !== "sent") {
        if (result.skipReason) {
          deliveryState.deliverySuppressionReason = result.skipReason;
        } else {
          const uncertain = result.reason === "adapter_returned_no_identity";
          deliveryState.status = uncertain ? "unknown" : "not-delivered";
          deliveryState.delivered = uncertain ? undefined : false;
          deliveryState.error = `cron delivery ${uncertain ? "outcome is unknown" : "was suppressed"}: ${result.reason}`;
          if (uncertain) {
            diagnostics = mergeCronRunDiagnostics(
              diagnostics,
              createCronRunDiagnosticsFromError(
                "delivery",
                "result may have been delivered but was not added to the conversation",
                { severity: "warn" },
              ),
            );
          }
        }
        return finish(true);
      }
      deliveryState.status = "delivered";
      deliveryState.delivered = true;
      return finish(true);
    }
    if (conversation && params.runStartedAtMs !== undefined && normalized.payload.length > 0) {
      const committed = await commitCronConversationResult({
        config: cfg,
        agentId,
        jobId: params.job.id,
        runStartedAt: params.runStartedAtMs,
        conversation,
        payloads: normalized.payload,
        signal: abortSignal,
        deliveryAttemptFence: params.deliveryAttemptFence,
      });
      if (!committed.ok) {
        throw new Error(committed.reason);
      }
      diagnostics = mergeCronRunDiagnostics(diagnostics, committed.diagnostics);
    }
    deliveryState.status = "delivered";
    deliveryState.delivered = true;
    return finish(true);
  } catch (err) {
    const deliveryError = formatErrorMessage(err);
    if (deliveryState.delivered) {
      diagnostics = mergeCronRunDiagnostics(
        diagnostics,
        createCronRunDiagnosticsFromError(
          "delivery",
          `result was delivered but was not added to the conversation: ${deliveryError}`,
          { severity: "warn" },
        ),
      );
      return finish(true);
    }
    if (mayHaveReachedRecipient) {
      deliveryState.status = "unknown";
      deliveryState.delivered = undefined;
      diagnostics = mergeCronRunDiagnostics(
        diagnostics,
        createCronRunDiagnosticsFromError(
          "delivery",
          "result may have been delivered but was not added to the conversation",
          { severity: "warn" },
        ),
      );
    }
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
