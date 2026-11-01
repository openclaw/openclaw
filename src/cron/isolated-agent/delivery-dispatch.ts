/** Finalize one run result and delegate confirmed external conversation writes to outbound. */
import { hasOutboundReplyContent } from "openclaw/plugin-sdk/reply-payload";
import type { ReplyPayload } from "../../auto-reply/reply-payload.js";
import type { NormalizeReplySkipReason } from "../../auto-reply/reply/normalize-reply-skip-reason.js";
import { resolveControlUiSessionUrl } from "../../config/control-ui-link-base.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { toAgentStoreSessionKey } from "../../routing/session-key.js";
import { createLazyImportLoader } from "../../shared/lazy-promise.js";
import { resolveAdmittedCronCompletionStatus } from "../completion-status.js";
import { createCronRunDiagnosticsFromError, mergeCronRunDiagnostics } from "../run-diagnostics.js";
import { normalizeCronRunErrorText } from "../service/execution-errors.js";
import type { CronResolvedDeliveryState } from "../types.js";
import {
  deliveredToPersistentExecution,
  logCronDeliveryWarn,
  resolveDescendantSubagentFollowup,
  resolveDirectCronDeliveryGeneration,
  resolveStaleCronDeliveryError,
} from "./delivery-dispatch-policy.js";
import type {
  CronDeliveryDisposition,
  DispatchCronDeliveryParams,
  DispatchCronDeliveryState,
} from "./delivery-dispatch-types.js";
import { normalizeDirectCronDeliveryPayloads } from "./delivery-payload-normalization.js";
import { requiresExternalCronDelivery } from "./delivery-target.js";
import { pickSummaryFromOutput } from "./helpers.js";
import { cleanupCronRunSessionAfterRun } from "./session-cleanup.js";

const followup = createLazyImportLoader(() => import("./subagent-followup.runtime.js"));
const conversationResult = createLazyImportLoader(() => import("../conversation-result.js"));
const notification = createLazyImportLoader(() => import("../delivery.js"));

export async function dispatchCronDelivery(
  params: DispatchCronDeliveryParams,
): Promise<DispatchCronDeliveryState> {
  let { summary, outputText, synthesizedText, deliveryPayloads } = params;
  let diagnostics: DispatchCronDeliveryState["diagnostics"];
  const deliveryReceipts: NonNullable<DispatchCronDeliveryState["deliveryReceipts"]> = [];
  const sentByTool = params.sourceDeliveryOutcome.satisfiesSourceDelivery;
  const state: CronResolvedDeliveryState = {
    status: params.deliveryRequested ? "not-delivered" : "not-requested",
    delivered: false,
    failureNotification: { status: "not-requested" },
  };
  let deliveryAttempted = params.sourceDeliveryOutcome.verifiedMessageToolDelivery;
  const record = (
    status: CronResolvedDeliveryState["status"],
    error?: string,
    reason?: NormalizeReplySkipReason,
  ) => {
    state.status = status;
    state.delivered =
      status === "delivered" ? true : status === "not-delivered" ? false : undefined;
    state.error = error;
    state.deliverySuppressionReason = reason;
  };
  if (params.sourceDeliveryOutcome.verifiedMessageToolDelivery) {
    record("delivered");
  }
  const adoptChild = (text: string) => {
    synthesizedText = text;
    outputText = synthesizedText;
    summary = pickSummaryFromOutput(synthesizedText) ?? summary;
    deliveryPayloads = [
      ...deliveryPayloads.filter((payload) =>
        hasOutboundReplyContent({ ...payload, text: undefined }, { trimText: true }),
      ),
      { text: synthesizedText },
    ];
  };
  const finish = async (
    disposition?: CronDeliveryDisposition,
  ): Promise<DispatchCronDeliveryState> => {
    const failed = disposition?.kind === "error" && disposition.errorKind !== "delivery-target";
    const completion = resolveAdmittedCronCompletionStatus(
      params.job,
      failed ? "error" : params.undeliveredRunStatus,
      state.status,
      state.deliverySuppressionReason,
    );
    if (
      state.status === "delivered" ||
      (state.status === "not-requested" && !failed) ||
      completion === "succeeded"
    ) {
      await cleanupCronRunSessionAfterRun({
        job: params.job,
        agentSessionKey: params.agentSessionKey,
        sessionId: params.sessionId,
        lifecycleRevision: params.lifecycleRevision,
        sessionUpdatedAt: params.sessionUpdatedAt,
        beforeDelete: params.beforeSessionDelete,
        reason: "cron-delete-after-run-fallback",
      });
    }
    return {
      ...(disposition ? { disposition } : {}),
      deliveryState: state,
      delivered: state.delivered,
      deliveryAttempted,
      ...(deliveryReceipts.length ? { deliveryReceipts } : {}),
      deliveryError: state.error,
      deliverySuppressionReason: state.deliverySuppressionReason,
      summary,
      outputText,
      synthesizedText,
      deliveryPayloads,
      diagnostics,
    };
  };
  // Commits the settled result into a persistent execution conversation; returns an error.
  const commitExecutionResult = async (
    payloads: ReplyPayload[],
    sessionKey = params.agentSessionKey,
  ) => {
    const committed = await (
      await conversationResult.load()
    ).commitCronConversationResult({
      config: params.cfgWithAgentDefaults,
      agentId: params.agentId,
      jobId: params.job.id,
      runStartedAt: params.runStartedAt,
      conversation: {
        sessionKey,
        sessionId: params.sessionId,
        lifecycleRevision: params.lifecycleRevision,
      },
      payloads,
      signal: params.abortSignal,
      deliveryAttemptFence: params.deliveryAttemptFence,
    });
    if (!committed.ok) {
      return committed.reason;
    }
    diagnostics = mergeCronRunDiagnostics(diagnostics, committed.diagnostics);
    return undefined;
  };
  const failTarget = (error: string) => {
    const detail = params.sourceDeliveryOutcome.unverifiedMessageToolDelivery
      ? error +
        "; the agent used the message tool, but OpenClaw could not verify that message matched the cron delivery target"
      : error;
    record("not-delivered", detail);
    return finish({ kind: "error", error: detail, errorKind: "delivery-target" });
  };
  const finishInterrupted = () => {
    const error = params.abortReason();
    if (!sentByTool) {
      record("not-delivered", error);
    }
    // An unfinished child still owns execution; a completed reader owns only delivery here.
    return finish(params.spawnOnlyHandoff ? { kind: "error", error } : undefined);
  };

  if (!params.deliveryRequested) {
    if (params.deliveryPlan.mode === "none" && params.spawnOnlyHandoff) {
      const child = await (
        await followup.load()
      ).waitForDescendantSubagentResult({
        sessionKey: params.runSessionKey,
        runStartedAt: params.runStartedAt,
        timeoutMs: params.timeoutMs,
        abortSignal: params.abortSignal,
      });
      if ((!child?.reply && child?.disposition !== "silent") || params.isAborted()) {
        return finish({
          kind: "error",
          error: params.isAborted()
            ? params.abortReason()
            : child
              ? "cron child-session handoff completed without a final assistant payload"
              : "cron child-session handoff timed out before producing a final assistant payload",
          delivered: false,
        });
      }
      if (child?.reply) {
        adoptChild(child.reply);
      }
    }
    // Persistent executions keep their raw transcript audit-only. A disabled
    // notification does not discard the settled reply in that same conversation.
    if (
      params.job.sessionTarget.startsWith("session:") &&
      params.undeliveredRunStatus === "ok" &&
      !params.skipDelivery &&
      !sentByTool &&
      !params.isAborted()
    ) {
      const normalized = normalizeDirectCronDeliveryPayloads({
        deliveryPayloads,
        outputText,
        summary,
        synthesizedText,
      });
      if (normalized.kind === "deliver") {
        const error = await commitExecutionResult(normalized.payload);
        if (error) {
          return finish({ kind: "error", error });
        }
      }
    }
    return finish();
  }
  if (params.skipDelivery && !sentByTool) {
    deliveryAttempted = true;
    record("not-delivered", undefined, params.skipDelivery);
    return finish({ kind: "suppressed" });
  }

  if (params.isAborted()) {
    return finishInterrupted();
  }
  if (
    !sentByTool &&
    !params.resolvedDelivery.ok &&
    (requiresExternalCronDelivery(params.deliveryPlan, params.resolvedDelivery) ||
      (!params.sourceSessionKey && params.job.sessionTarget !== "current"))
  ) {
    if (params.deliveryBestEffort) {
      record("not-delivered", params.resolvedDelivery.error.message);
      await logCronDeliveryWarn(params.resolvedDelivery.error.message);
      return finish({ kind: "suppressed" });
    }
    return failTarget(params.resolvedDelivery.error.message);
  }
  if (!sentByTool && (synthesizedText || params.spawnOnlyHandoff)) {
    const initial = synthesizedText ?? "";
    let child: Awaited<ReturnType<typeof resolveDescendantSubagentFollowup>>;
    try {
      child = await resolveDescendantSubagentFollowup({
        sessionKey: params.runSessionKey,
        runStartedAt: params.runStartedAt,
        timeoutMs: params.timeoutMs,
        deliveryBestEffort: params.deliveryBestEffort,
        spawnOnlyHandoff: params.spawnOnlyHandoff,
        initialSynthesizedText: initial,
        abortSignal: params.abortSignal,
      });
    } catch (error) {
      if (!params.isAborted()) {
        throw error;
      }
      return finishInterrupted();
    }
    if (params.isAborted()) {
      return finishInterrupted();
    }
    if (child.finalDisposition === "silent") {
      deliveryPayloads = deliveryPayloads.filter((payload) =>
        hasOutboundReplyContent({ ...payload, text: undefined }, { trimText: true }),
      );
      synthesizedText = outputText = summary = undefined;
      if (deliveryPayloads.length === 0) {
        deliveryAttempted = true;
        record("not-delivered", undefined, "silent");
        return finish({ kind: "suppressed" });
      }
    }
    if (child.finalReply) {
      adoptChild(child.finalReply);
    }
    if (params.spawnOnlyHandoff && !synthesizedText?.trim() && deliveryPayloads.length === 0) {
      deliveryAttempted = true;
      return finish({
        kind: "error",
        error: params.isAborted()
          ? params.abortReason()
          : child.hasUnsettledDescendants
            ? "cron child-session handoff timed out before producing a final assistant payload"
            : "cron child-session handoff completed without a final assistant payload",
        delivered: false,
      });
    }
    if (!params.deliveryBestEffort && child.hasUnsettledDescendants) {
      deliveryAttempted = true;
      record(
        "not-delivered",
        child.hasUnsettledDescendants
          ? "cron descendants are still active without a final reply"
          : "cron descendants completed without a final reply",
      );
      return finish({ kind: "pending" });
    }
  }
  if (sentByTool) {
    const visible = params.sourceDeliveryOutcome.visibleDeliveries
      .filter((item) => item.verifiedTarget)
      .map(({ target }) => ({ text: target.text, mediaUrls: target.mediaUrls }));
    if (visible.some((item) => item.text?.trim() || item.mediaUrls?.length)) {
      deliveryPayloads = visible;
    }
  }
  const normalized = normalizeDirectCronDeliveryPayloads({
    deliveryPayloads,
    outputText,
    summary,
    synthesizedText,
  });
  if (normalized.kind === "suppress") {
    if (!sentByTool) {
      deliveryAttempted = normalized.reason !== "empty";
      record("not-delivered", undefined, normalized.reason);
    }
    return finish(sentByTool ? undefined : { kind: "suppressed" });
  }
  deliveryPayloads = normalized.payload;
  if (synthesizedText) {
    outputText = synthesizedText;
  }

  let conversationError: string | undefined;
  const conversation =
    !params.resolvedDelivery.ok && params.sourceSessionKey && params.sourceSessionGeneration
      ? { sessionKey: params.sourceSessionKey, ...params.sourceSessionGeneration }
      : undefined;
  if (!conversation && !params.resolvedDelivery.ok && !sentByTool) {
    if (params.job.sessionTarget === "current") {
      return failTarget("current cron delivery is missing its source session binding");
    }
    if (params.deliveryBestEffort) {
      record("not-delivered", params.resolvedDelivery.error.message);
      await logCronDeliveryWarn(params.resolvedDelivery.error.message);
      return finish({ kind: "suppressed" });
    }
    return failTarget(params.resolvedDelivery.error.message);
  }
  if (params.resolvedDelivery.ok && !sentByTool) {
    deliveryAttempted = true;
    const stale = resolveStaleCronDeliveryError(params);
    if (stale) {
      record("not-delivered", stale);
      return finish({ kind: "suppressed" });
    }
    let mayHaveReachedRecipient = false;
    try {
      const { sendCronAnnouncePayloadStrict } = await notification.load();
      const sessionGeneration = resolveDirectCronDeliveryGeneration(params);
      const sent = await sendCronAnnouncePayloadStrict({
        deps: params.deps,
        cfg: params.cfgWithAgentDefaults,
        agentId: params.agentId,
        jobId: params.job.id,
        target: {
          ...params.resolvedDelivery,
          sessionKey: params.runSessionKey,
        },
        payload: deliveryPayloads,
        admittedReasoning: true,
        sessionGeneration,
        transcriptRoute: params.resolvedDelivery.sessionRoute,
        transcriptExpectedGeneration:
          sessionGeneration &&
          params.resolvedDelivery.sessionRoute?.sessionKey ===
            toAgentStoreSessionKey({
              agentId: params.agentId,
              requestKey: sessionGeneration.sessionKey,
              mainKey: params.cfgWithAgentDefaults.session?.mainKey,
            })
            ? params.sourceSessionGeneration
            : undefined,
        onTranscriptDiagnostic: (message) => {
          diagnostics = mergeCronRunDiagnostics(
            diagnostics,
            createCronRunDiagnosticsFromError("delivery", message, { severity: "warn" }),
          );
        },
        tts: { auto: params.ttsAuto },
        inspectionUrl: resolveControlUiSessionUrl(params.cfgWithAgentDefaults, {
          sessionKey: params.runSessionKey,
          fallbackAgentId: params.agentId,
          exactKey: true,
        }),
        abortSignal: params.abortSignal ?? new AbortController().signal,
        bestEffort: params.deliveryBestEffort,
        completion: {
          job: params.job,
          runStartedAt: params.runStartedAt,
          deliveryAttemptFence: params.deliveryAttemptFence,
        },
        onDeliveryReceipt: (receipt) => deliveryReceipts.push(receipt),
        onDeliveryAttempt: (reachedRecipient) => {
          mayHaveReachedRecipient ||= reachedRecipient;
        },
      });
      if (sent.status === "sent") {
        deliveryPayloads = sent.payloads;
      }
      record(
        sent.status === "sent"
          ? "delivered"
          : sent.reason === "adapter_returned_no_identity"
            ? "unknown"
            : "not-delivered",
        sent.status === "suppressed" && !sent.skipReason
          ? sent.reason === "empty_after_tts"
            ? "cron delivery payload was empty after TTS"
            : "cron notification was suppressed: " + sent.reason
          : undefined,
        sent.status === "suppressed" ? sent.skipReason : undefined,
      );
    } catch (error) {
      record(
        mayHaveReachedRecipient ? "unknown" : "not-delivered",
        normalizeCronRunErrorText(error),
      );
      await logCronDeliveryWarn(
        "[cron:" + params.job.id + "] notification failed: " + formatErrorMessage(error),
      );
    }
    if (state.status !== "delivered") {
      if (state.status === "unknown") {
        diagnostics = mergeCronRunDiagnostics(
          diagnostics,
          createCronRunDiagnosticsFromError(
            "delivery",
            "result may have been delivered but was not added to the conversation",
            { severity: "warn" },
          ),
        );
      }
      return finish();
    }
  }
  if (params.resolvedDelivery.ok || sentByTool) {
    // Outbound skips the execution's own conversation; a persistent session still keeps
    // the settled result there once its notification was confirmed.
    const executionRouteKey = sentByTool
      ? undefined
      : deliveredToPersistentExecution(params, state.status);
    if (executionRouteKey) {
      const error = await commitExecutionResult(deliveryPayloads, executionRouteKey);
      if (error) {
        diagnostics = mergeCronRunDiagnostics(
          diagnostics,
          createCronRunDiagnosticsFromError(
            "delivery",
            `result was delivered but was not added to the conversation: ${error}`,
            { severity: "warn" },
          ),
        );
      }
    }
    return finish();
  }
  const executionOwnsResult =
    (params.undeliveredRunStatus === "error" || sentByTool) &&
    params.job.sessionTarget.startsWith("session:") &&
    conversation &&
    toAgentStoreSessionKey({
      agentId: params.agentId,
      requestKey: conversation.sessionKey,
      mainKey: params.cfgWithAgentDefaults.session?.mainKey,
    }) ===
      toAgentStoreSessionKey({
        agentId: params.agentId,
        requestKey: params.agentSessionKey,
        mainKey: params.cfgWithAgentDefaults.session?.mainKey,
      });
  // Errors and explicit message sends are already visible. Other execution
  // transcript entries stay audit-only until this settled result is published.
  if (conversation && !executionOwnsResult && deliveryPayloads.length > 0) {
    deliveryAttempted = true;
    try {
      const committed = await (
        await conversationResult.load()
      ).commitCronConversationResult({
        config: params.cfgWithAgentDefaults,
        agentId: params.agentId,
        jobId: params.job.id,
        runStartedAt: params.runStartedAt,
        conversation,
        payloads: deliveryPayloads,
        signal: params.abortSignal,
        deliveryAttemptFence: params.deliveryAttemptFence,
      });
      if (!committed.ok) {
        conversationError = committed.reason;
      } else {
        diagnostics = mergeCronRunDiagnostics(diagnostics, committed.diagnostics);
      }
    } catch (error) {
      conversationError = formatErrorMessage(error);
    }
  }
  if (conversationError) {
    return failTarget(conversationError);
  } else if (conversation) {
    record("delivered");
  }
  return finish();
}
