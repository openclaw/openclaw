/** Finalize one run result and delegate confirmed external conversation writes to outbound. */
import type { NormalizeReplySkipReason } from "../../auto-reply/reply/normalize-reply-skip-reason.js";
import { isSilentReplyText, SILENT_REPLY_TOKEN } from "../../auto-reply/tokens.js";
import { resolveControlUiSessionUrl } from "../../config/control-ui-link-base.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { toAgentStoreSessionKey } from "../../routing/session-key.js";
import { createLazyImportLoader } from "../../shared/lazy-promise.js";
import { resolveAdmittedCronCompletionStatus } from "../completion-status.js";
import { createCronRunDiagnosticsFromError, mergeCronRunDiagnostics } from "../run-diagnostics.js";
import { normalizeCronRunErrorText } from "../service/execution-errors.js";
import type { CronResolvedDeliveryState } from "../types.js";
import {
  logCronDeliveryWarn,
  normalizeSilentReplyText,
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
import { pickSummaryFromOutput, readAutomationFailedReport } from "./helpers.js";
import { cleanupCronRunSessionAfterRun } from "./session-cleanup.js";
import { isLikelyInterimCronMessage } from "./subagent-followup-hints.js";

const followup = createLazyImportLoader(() => import("./subagent-followup.runtime.js"));
const conversationResult = createLazyImportLoader(() => import("../conversation-result.js"));
const notification = createLazyImportLoader(() => import("../delivery.js"));

export async function dispatchCronDelivery(
  params: DispatchCronDeliveryParams,
): Promise<DispatchCronDeliveryState> {
  let { summary, outputText, synthesizedText, deliveryPayloads } = params;
  let agentReportedFailure: string | undefined;
  let diagnostics: DispatchCronDeliveryState["diagnostics"];
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
    agentReportedFailure = readAutomationFailedReport(text);
    synthesizedText = agentReportedFailure ?? text;
    outputText = synthesizedText;
    summary = pickSummaryFromOutput(synthesizedText) ?? summary;
    deliveryPayloads = [{ text: synthesizedText }];
  };
  const finish = async (
    disposition?: CronDeliveryDisposition,
  ): Promise<DispatchCronDeliveryState> => {
    const failed =
      (disposition?.kind === "error" && disposition.errorKind !== "delivery-target") ||
      agentReportedFailure !== undefined;
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
      deliveryError: state.error,
      deliverySuppressionReason: state.deliverySuppressionReason,
      summary,
      outputText,
      synthesizedText,
      deliveryPayloads,
      diagnostics,
      ...(agentReportedFailure ? { agentReportedFailure } : {}),
    };
  };
  const failTarget = (error: string) => {
    const detail = params.sourceDeliveryOutcome.unverifiedMessageToolDelivery
      ? error +
        "; the agent used the message tool, but OpenClaw could not verify that message matched the cron delivery target"
      : error;
    record("not-delivered", detail);
    return finish({ kind: "error", error: detail, errorKind: "delivery-target" });
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
      if (!child?.reply || params.isAborted()) {
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
      if (!isSilentReplyText(child.reply, SILENT_REPLY_TOKEN)) {
        adoptChild(child.reply);
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
    return finish({ kind: "error", error: params.abortReason() });
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
    const initial = synthesizedText?.trim() ?? "";
    const child = await resolveDescendantSubagentFollowup({
      sessionKey: params.runSessionKey,
      runStartedAt: params.runStartedAt,
      timeoutMs: params.timeoutMs,
      deliveryBestEffort: params.deliveryBestEffort,
      spawnOnlyHandoff: params.spawnOnlyHandoff,
      initialSynthesizedText: initial,
      abortSignal: params.abortSignal,
    });
    if (child.finalReply) {
      adoptChild(child.finalReply);
    }
    if (params.spawnOnlyHandoff && !synthesizedText?.trim()) {
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
    if (
      (!params.deliveryBestEffort && child.hasUnsettledDescendants) ||
      (child.hadDescendants &&
        synthesizedText?.trim() === initial &&
        isLikelyInterimCronMessage(initial) &&
        !isSilentReplyText(initial, SILENT_REPLY_TOKEN))
    ) {
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
  const finalText = normalizeSilentReplyText(synthesizedText);
  synthesizedText = finalText.strippedTrailingSilentToken ? undefined : finalText.text;
  if (synthesizedText) {
    outputText = synthesizedText;
  }
  if (params.isAborted()) {
    return finish({ kind: "error", error: params.abortReason() });
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
    return finish();
  }
  const executionOwnsResult =
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
  // A persistent execution in this destination already owns its transcript entry.
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
        text: synthesizedText,
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
    if (state.status !== "delivered") {
      return failTarget(conversationError);
    }
    diagnostics = mergeCronRunDiagnostics(
      diagnostics,
      createCronRunDiagnosticsFromError(
        "delivery",
        `result was delivered but was not added to the conversation: ${conversationError}`,
        { severity: "warn" },
      ),
    );
  } else if (conversation) {
    record("delivered");
  }
  return finish();
}
