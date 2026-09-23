/** Final persistence, telemetry, and delivery for an isolated cron run. */
import { asPositiveFiniteNumber as resolvePositiveContextTokens } from "@openclaw/normalization-core/number-coercion";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { hasAcceptedSessionSpawn } from "../../agents/accepted-session-spawn.js";
import {
  buildAgentRunTerminalReplySnapshot,
  normalizeAgentRunTerminalReplySnapshot,
} from "../../agents/agent-run-terminal-reply.js";
import {
  CODE_MODE_MCP_CATALOG_MISS_MESSAGE,
  isEmbeddedRunTerminalToolFailure,
} from "../../agents/embedded-agent-runner/terminal-tool-failure.js";
import { isSilentReplyPayloadText } from "../../auto-reply/tokens.js";
import { SESSION_TOTAL_TOKENS_VERSION } from "../../config/sessions.js";
import {
  resolveProjectedSessionContextTokens,
  resolveTrustedSessionContextTokens,
} from "../../config/sessions/context-token-provenance.js";
import { resolveSourceDeliveryOutcome } from "../../infra/outbound/source-delivery-plan.js";
import { createLazyImportLoader } from "../../shared/lazy-promise.js";
import {
  createCronRunDiagnosticsFromAgentResult,
  createCronRunDiagnosticsFromError,
  mergeCronRunDiagnostics,
} from "../run-diagnostics.js";
import type { CronDeliveryTrace, CronRunTelemetry } from "../types.js";
import { resolveCronChannelOutputPolicy } from "./channel-output-policy.js";
import type { DispatchCronDeliveryState } from "./delivery-dispatch-types.js";
import { resolveCronPayloadOutcome } from "./helpers.js";
import { buildCronDeliveryTrace, loadCronDeliveryRuntime } from "./run-delivery-trace.js";
import type { PreparedCronRunContext } from "./run-prepare.js";
import {
  adoptCronRunSessionMetadata,
  setCronSessionAgentHarnessId,
  setCronSessionRuntimeModel,
} from "./run-session-state.js";
import { resolveCronRunUsage } from "./run-usage.js";
import {
  DEFAULT_CONTEXT_TOKENS,
  deriveSessionTotalTokens,
  hasNonzeroUsage,
} from "./run.runtime.js";
import type { RunCronAgentTurnResult } from "./run.types.js";
import { cleanupCronRunSessionAfterRun } from "./session-cleanup.js";

type CronExecutionRuntime = typeof import("./run-executor.runtime.js");
type CronExecutionResult = Awaited<ReturnType<CronExecutionRuntime["executeCronRun"]>>;

const cronContextRuntimeLoader = createLazyImportLoader(() => import("./run-context.runtime.js"));

export async function finalizeCronRun(params: {
  prepared: PreparedCronRunContext;
  execution: CronExecutionResult;
  abortReason: () => string;
  isAborted: () => boolean;
  settleUsage: (contextTokens: number) => Promise<CronRunTelemetry["usage"]>;
  markCronRunSessionCleanupHandled: () => void;
  beforeSessionDelete: () => void;
}): Promise<RunCronAgentTurnResult> {
  const { prepared, execution } = params;
  const finalRunResult = execution.runResult;
  const replyDisposition = (
    normalizeAgentRunTerminalReplySnapshot(finalRunResult.meta?.terminalReply) ??
    buildAgentRunTerminalReplySnapshot({
      visibleText: finalRunResult.meta?.finalAssistantVisibleText,
      rawText: finalRunResult.meta?.finalAssistantRawText,
      terminalReplyKind: finalRunResult.meta?.terminalReplyKind,
    })
  ).disposition;
  const payloads = finalRunResult.payloads ?? [];
  const cleanupRunSession = async (reason: string) => {
    await cleanupCronRunSessionAfterRun({
      job: prepared.input.job,
      agentSessionKey: prepared.agentSessionKey,
      sessionId: prepared.currentRunSessionId(),
      lifecycleRevision: prepared.cronSession.lifecycleRevision,
      sessionUpdatedAt: prepared.cronSession.sessionEntry.updatedAt,
      beforeDelete: params.beforeSessionDelete,
      reason,
    });
    params.markCronRunSessionCleanupHandled();
  };

  // Late aborted results may still contain billable usage. Recheck before each
  // metadata mutation because lazy runtime loads below can yield to the timeout.
  if (!params.isAborted()) {
    if (finalRunResult.meta?.systemPromptReport) {
      prepared.cronSession.sessionEntry.systemPromptReport = finalRunResult.meta.systemPromptReport;
    }
    // CLI session ids belong to native continuity, never the local transcript owner.
    if (finalRunResult.meta?.executionTrace?.runner !== "cli") {
      adoptCronRunSessionMetadata({
        entry: prepared.cronSession.sessionEntry,
        sessionKey: prepared.agentSessionKey,
        runMeta: finalRunResult.meta?.agentMeta,
      });
    }
  }
  const usage = resolveCronRunUsage(execution.completedPromptRuns);
  const lastCallUsage = finalRunResult.meta?.agentMeta?.lastCallUsage;
  const promptTokens = finalRunResult.meta?.agentMeta?.promptTokens;
  const modelUsed = finalRunResult.meta?.agentMeta?.model ?? execution.fallbackModel;
  const providerUsed = finalRunResult.meta?.agentMeta?.provider ?? execution.fallbackProvider;
  const runtimeContextTokens = resolvePositiveContextTokens(
    finalRunResult.meta?.agentMeta?.contextTokens,
  );
  const { contextTokens: modelContextTokens, authoredContextTokens } = (
    await cronContextRuntimeLoader.load()
  ).resolveModelContextTokenProjection({
    cfg: prepared.cfgWithAgentDefaults,
    provider: providerUsed,
    model: modelUsed,
    allowAsyncLoad: false,
  });
  const agentHarnessId = normalizeOptionalString(finalRunResult.meta?.agentMeta?.agentHarnessId);
  const retainedRuntimeContextTokens = resolveTrustedSessionContextTokens({
    entry: prepared.cronSession.sessionEntry,
    provider: providerUsed,
    model: modelUsed,
    agentHarnessId,
  });
  const projectedContextTokens = resolveProjectedSessionContextTokens({
    entry: prepared.cronSession.sessionEntry,
    provider: providerUsed,
    model: modelUsed,
    agentHarnessId,
    resolvedContextTokens: modelContextTokens,
    authoredContextTokens,
  });
  const contextTokens = runtimeContextTokens ?? projectedContextTokens ?? DEFAULT_CONTEXT_TOKENS;
  // Preserve persisted provenance only when the projector selected that owner;
  // a current/authored clamp stays resolved so removed caps cannot stick.
  const projectedUsesPersistedContext =
    retainedRuntimeContextTokens !== undefined &&
    (prepared.cronSession.sessionEntry.modelSelectionLocked === true ||
      (authoredContextTokens === undefined &&
        projectedContextTokens === retainedRuntimeContextTokens));
  const contextTokensSource =
    runtimeContextTokens !== undefined
      ? (finalRunResult.meta?.agentMeta?.contextTokensSource ?? "resolved")
      : projectedUsesPersistedContext
        ? prepared.cronSession.sessionEntry.contextTokensSource
        : "resolved";

  if (!params.isAborted()) {
    setCronSessionRuntimeModel({
      entry: prepared.cronSession.sessionEntry,
      provider: providerUsed,
      model: modelUsed,
    });
    setCronSessionAgentHarnessId({
      entry: prepared.cronSession.sessionEntry,
      agentHarnessId,
    });
    prepared.cronSession.sessionEntry.contextTokens = contextTokens;
    prepared.cronSession.sessionEntry.contextTokensSource = contextTokensSource;
  }
  if (hasNonzeroUsage(usage) || hasNonzeroUsage(finalRunResult.meta?.agentMeta?.usage)) {
    const totalTokens = deriveSessionTotalTokens({
      usage: lastCallUsage,
      contextTokens,
      promptTokens,
    });
    if (typeof totalTokens === "number" && Number.isFinite(totalTokens) && totalTokens > 0) {
      prepared.cronSession.sessionEntry.totalTokens = totalTokens;
      prepared.cronSession.sessionEntry.totalTokensFresh = true;
      prepared.cronSession.sessionEntry.totalTokensVersion = SESSION_TOTAL_TOKENS_VERSION;
    } else {
      prepared.cronSession.sessionEntry.totalTokens = undefined;
      prepared.cronSession.sessionEntry.totalTokensFresh = false;
      prepared.cronSession.sessionEntry.totalTokensVersion = undefined;
    }
  }
  const telemetry: CronRunTelemetry = {
    model: modelUsed,
    provider: providerUsed,
    usage: await params.settleUsage(contextTokens),
  };

  if (params.isAborted()) {
    return prepared.withRunSession({
      status: "error",
      error: params.abortReason(),
      replyDisposition,
      diagnostics: mergeCronRunDiagnostics(
        prepared.preflightDiagnostics,
        createCronRunDiagnosticsFromAgentResult(finalRunResult, { finalStatus: "error" }),
        createCronRunDiagnosticsFromError("cron-setup", params.abortReason()),
      ),
      ...telemetry,
    });
  }
  const cronPayloadOutcome = resolveCronPayloadOutcome({
    payloads,
    runLevelError: finalRunResult.meta?.error,
    failureSignal: finalRunResult.meta?.failureSignal,
    finalAssistantVisibleText: finalRunResult.meta?.finalAssistantVisibleText,
    preferFinalAssistantVisibleText: (
      await resolveCronChannelOutputPolicy(prepared.resolvedDelivery.channel, {
        deliveryRequested: prepared.deliveryRequested,
      })
    ).preferFinalAssistantVisibleText,
  });
  if (finalRunResult.meta?.aborted === true && !cronPayloadOutcome.hasFatalErrorPayload) {
    const metaErrorMessage = normalizeOptionalString(finalRunResult.meta.error?.message);
    const error = metaErrorMessage ?? "cron isolated agent run aborted";
    await cleanupRunSession("cron-delete-after-run-aborted");
    return prepared.withRunSession({
      status: "error",
      error,
      replyDisposition,
      diagnostics: mergeCronRunDiagnostics(
        prepared.preflightDiagnostics,
        createCronRunDiagnosticsFromAgentResult(finalRunResult, { finalStatus: "error" }),
        createCronRunDiagnosticsFromError("agent-run", error),
      ),
      ...telemetry,
    });
  }
  const {
    deliveryDisposition,
    deliveryPayloadHasStructuredContent,
    hasFatalStructuredErrorPayload,
    pendingPresentationWarningError,
  } = cronPayloadOutcome;
  let {
    synthesizedText,
    deliveryPayloads,
    summary,
    outputText,
    hasFatalErrorPayload,
    embeddedRunError,
  } = cronPayloadOutcome;
  const terminalToolFailure = finalRunResult.meta?.terminalToolFailure;
  const hasTerminalToolFailure = isEmbeddedRunTerminalToolFailure(terminalToolFailure);
  if (hasFatalErrorPayload && hasTerminalToolFailure) {
    summary = CODE_MODE_MCP_CATALOG_MISS_MESSAGE;
  }
  const agentDiagnostics = createCronRunDiagnosticsFromAgentResult(finalRunResult, {
    finalStatus: hasFatalErrorPayload ? "error" : "ok",
  });
  const runDiagnostics = mergeCronRunDiagnostics(prepared.preflightDiagnostics, agentDiagnostics);
  const resolveRunOutcome = (
    result?: Partial<DispatchCronDeliveryState> & { delivery?: CronDeliveryTrace },
  ) => {
    const disposition = result?.disposition;
    const failure = disposition?.kind === "error" ? disposition : undefined;
    // A failed handoff wins; a non-error delivery stop must retain the run's fatal outcome.
    const useRunFailure = hasFatalErrorPayload && !failure;
    const runError = embeddedRunError ?? "cron isolated run returned an error payload";
    const deliveryError = disposition && useRunFailure ? undefined : result?.deliveryError;
    const deliveryDiagnosticError = deliveryError ?? failure?.error;
    const output =
      failure && failure.errorKind !== "delivery-target"
        ? {}
        : disposition && !useRunFailure
          ? { summary: result?.summary, outputText: result?.outputText }
          : { summary, outputText };
    return prepared.withRunSession({
      status: failure || hasFatalErrorPayload ? "error" : "ok",
      ...(failure
        ? { error: failure.error, ...(failure.errorKind ? { errorKind: failure.errorKind } : {}) }
        : hasFatalErrorPayload
          ? { error: runError }
          : {}),
      ...output,
      replyDisposition,
      deliveryState: result?.deliveryState,
      delivered:
        useRunFailure && disposition?.kind === "pending"
          ? undefined
          : (failure?.delivered ?? result?.delivered),
      deliveryAttempted: result?.deliveryAttempted,
      deliveryError,
      deliverySuppressionReason: result?.deliverySuppressionReason,
      delivery: result?.delivery,
      diagnostics: mergeCronRunDiagnostics(
        runDiagnostics,
        useRunFailure && !hasTerminalToolFailure
          ? createCronRunDiagnosticsFromError("agent-run", runError)
          : undefined,
        deliveryDiagnosticError
          ? createCronRunDiagnosticsFromError("delivery", deliveryDiagnosticError)
          : undefined,
      ),
      ...telemetry,
    });
  };
  const failPendingPresentationWarningUnlessDelivered = (delivered?: boolean) => {
    if (pendingPresentationWarningError && delivered !== true) {
      hasFatalErrorPayload = true;
      embeddedRunError = pendingPresentationWarningError;
    }
  };

  const acceptedSessionSpawn = hasAcceptedSessionSpawn(finalRunResult.acceptedSessionSpawns);
  const heartbeatOnlyResponse =
    prepared.deliveryRequested && !hasFatalErrorPayload && deliveryDisposition.kind !== "visible";
  const heartbeatControlOnlyResponse =
    heartbeatOnlyResponse &&
    (deliveryDisposition.kind === "empty" ||
      (deliveryDisposition.kind === "heartbeat" && deliveryDisposition.controlOnly));
  const spawnOnlyHandoff =
    acceptedSessionSpawn &&
    (heartbeatControlOnlyResponse ||
      (deliveryPayloads.length === 0 && normalizeOptionalString(synthesizedText) === undefined));
  if (spawnOnlyHandoff && heartbeatControlOnlyResponse) {
    // Parent heartbeat acknowledgments cannot fulfill child delivery; one-shot
    // cleanup must wait for actual descendant output before retiring the job.
    deliveryPayloads = [];
    synthesizedText = undefined;
    summary = undefined;
    outputText = undefined;
  }
  const skipHeartbeatDelivery = heartbeatOnlyResponse && !spawnOnlyHandoff;
  const sourceDeliveryOutcome = resolveSourceDeliveryOutcome(prepared.sourceDelivery, {
    didSendViaMessageTool: finalRunResult.didSendViaMessagingTool,
    messageToolSentTargets: finalRunResult.messagingToolSentTargets,
  });
  let queueSourceSessionMessageToolAwareness: (() => Promise<void>) | undefined;
  if (sourceDeliveryOutcome.visibleDeliveries.length > 0) {
    const { queueCronMessageToolDeliveryAwareness } = await loadCronDeliveryRuntime();
    queueSourceSessionMessageToolAwareness = await queueCronMessageToolDeliveryAwareness({
      cfg: prepared.cfgWithAgentDefaults,
      runSessionKey: prepared.runSessionKey,
      job: prepared.input.job,
      agentId: prepared.agentId,
      agentSessionKey: prepared.agentSessionKey,
      deferredTargetSessionKey:
        prepared.input.job.sessionTarget === "current" ? prepared.sourceSessionKey : undefined,
      runStartedAt: execution.runStartedAt,
      resolvedDelivery: prepared.resolvedDelivery,
      sourceDeliveryOutcome,
    });
  }
  const hasIntentionalSilentReply =
    finalRunResult.meta?.terminalReplyKind === "silent-empty" ||
    isSilentReplyPayloadText(finalRunResult.meta?.finalAssistantRawText) ||
    isSilentReplyPayloadText(finalRunResult.meta?.finalAssistantVisibleText);
  if (hasFatalStructuredErrorPayload && prepared.deliveryRequested) {
    // Structured run error payloads belong in cron state and failure alerts,
    // not the normal completion announce path where provider JSON can leak.
    await cleanupRunSession("cron-delete-after-run-fatal-error");
    const deliveryTrace = buildCronDeliveryTrace({
      deliveryPlan: prepared.deliveryPlan,
      resolvedDelivery: prepared.resolvedDelivery,
      sourceDeliveryOutcome,
      fallbackUsed: false,
      delivered: sourceDeliveryOutcome.verifiedMessageToolDelivery,
    });
    await queueSourceSessionMessageToolAwareness?.();
    return resolveRunOutcome({
      delivered: sourceDeliveryOutcome.verifiedMessageToolDelivery,
      deliveryAttempted: sourceDeliveryOutcome.verifiedMessageToolDelivery,
      delivery: deliveryTrace,
    });
  }
  // Dispatch owns transcript cleanup from here; a thrown delivery error must retain it too.
  params.markCronRunSessionCleanupHandled();
  const { dispatchCronDelivery, resolveCronDeliveryBestEffort } = await loadCronDeliveryRuntime();
  const deliveryResult = await dispatchCronDelivery({
    cfgWithAgentDefaults: prepared.cfgWithAgentDefaults,
    deps: prepared.input.deps,
    job: prepared.input.job,
    agentId: prepared.agentId,
    agentSessionKey: prepared.agentSessionKey,
    sourceSessionKey: prepared.sourceSessionKey,
    sourceSessionGeneration: prepared.sourceSessionGeneration,
    runSessionKey: prepared.runSessionKey,
    sessionId: prepared.currentRunSessionId(),
    lifecycleRevision: prepared.cronSession.lifecycleRevision,
    sessionUpdatedAt: prepared.cronSession.sessionEntry.updatedAt,
    beforeSessionDelete: params.beforeSessionDelete,
    runStartedAt: execution.runStartedAt,
    timeoutMs: prepared.timeoutMs,
    resolvedDelivery: prepared.resolvedDelivery,
    deliveryPlan: prepared.deliveryPlan,
    deliveryRequested: prepared.deliveryRequested,
    undeliveredRunStatus: hasFatalErrorPayload || pendingPresentationWarningError ? "error" : "ok",
    skipDelivery: skipHeartbeatDelivery
      ? hasIntentionalSilentReply
        ? "silent"
        : deliveryDisposition.kind
      : undefined,
    spawnOnlyHandoff,
    sourceDeliveryOutcome,
    queueSourceSessionMessageToolAwareness,
    deliveryBestEffort: resolveCronDeliveryBestEffort(prepared.input.job),
    deliveryPayloadHasStructuredContent,
    deliveryPayloads,
    synthesizedText,
    ttsAuto: prepared.cronSession.sessionEntry.ttsAuto,
    summary,
    outputText,
    abortSignal: prepared.input.abortSignal ?? prepared.input.signal,
    isAborted: params.isAborted,
    abortReason: params.abortReason,
  });
  const deliveryTrace = buildCronDeliveryTrace({
    deliveryPlan: prepared.deliveryPlan,
    resolvedDelivery: prepared.resolvedDelivery,
    sourceDeliveryOutcome,
    fallbackUsed:
      prepared.deliveryRequested &&
      deliveryResult.deliveryAttempted &&
      !sourceDeliveryOutcome.satisfiesSourceDelivery,
    delivered: deliveryResult.delivered,
  });
  if (!deliveryResult.disposition) {
    summary = deliveryResult.summary;
    outputText = deliveryResult.outputText;
  }
  failPendingPresentationWarningUnlessDelivered(deliveryResult.delivered);
  return resolveRunOutcome({ ...deliveryResult, delivery: deliveryTrace });
}
