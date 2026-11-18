/**
 * The shared module owns classification and message contracts; this adapter
 * binds those contracts to embedded-run abort, status, and steering primitives.
 */
import { bindWorkerToolPreparation } from "../agents/harness/host-private-capabilities.js";
import { bindPreparedToolAuthority } from "../agents/harness/tool-authority-preparation.js";
import { isAbortError } from "../infra/abort-signal.js";
import { formatErrorMessage } from "../infra/errors.js";
import { getDiagnosticSessionActivitySnapshot } from "../logging/diagnostic-run-activity.js";
import type {
  ReplyBackendQueueMessageMismatch,
  ReplyMessageInjectionOptions,
  ReplyToolAuthorityOverlay,
  ReplyToolAuthorityPreparation,
} from "../sessions/session-controller.contracts.js";
import type { SessionControllerSteerResult } from "../sessions/session-controller.steer.js";
import type { UserTurnTranscriptRecorder } from "../sessions/user-turn-transcript.types.js";
import { captureRealtimeVoiceRunOwner } from "./agent-run-control-owner.js";
import {
  buildRealtimeVoiceAgentCancelProviderResult,
  buildRealtimeVoiceAgentFollowupSteeringText,
  formatRealtimeVoiceAgentQueueRejection,
  formatRealtimeVoiceAgentStatus,
  resolveRealtimeVoiceAgentControlIntent,
  type RealtimeVoiceAgentControlProviderResult,
  type RealtimeVoiceAgentControlResult,
  type RealtimeVoiceAgentRunActivity,
} from "./agent-run-control-shared.js";
import type { TalkEvent } from "./talk-events.js";

export {
  buildRealtimeVoiceAgentCancelProviderResult,
  buildRealtimeVoiceAgentControlSpeechMessage,
  classifyRealtimeVoiceAgentControlText,
  parseRealtimeVoiceAgentControlToolArgs,
  REALTIME_VOICE_AGENT_CONTROL_TOOL,
  REALTIME_VOICE_AGENT_CONTROL_TOOL_NAME,
  resolveRealtimeVoiceAgentControlIntent,
  shouldAutoControlRealtimeVoiceAgentText,
  type RealtimeVoiceAgentControlProviderResult,
  type RealtimeVoiceAgentControlResult,
} from "./agent-run-control-shared.js";

const controlResultPresentation = { speak: true, show: true, suppress: false };

/** Host error projection needs server-side redaction, outside browser-shared contracts. */
export function buildRealtimeVoiceAgentErrorProviderResult(
  error: unknown,
): RealtimeVoiceAgentControlProviderResult | { error: string } {
  return isAbortError(error)
    ? buildRealtimeVoiceAgentCancelProviderResult()
    : { error: formatErrorMessage(error) };
}

// These callback shapes shipped in the realtime-voice SDK in v2026.8.1.
// Keep the external adapter contract; built-in execution belongs to the controller.
type RealtimeVoiceAgentQueueOutcome =
  | {
      queued: true;
      sessionId: string;
      runId?: string;
      target?: "embedded_run" | "reply_run";
      gatewayHealth: "live";
      transcriptCommit?: "unconfirmed";
      errorMessage?: string;
      deliveredAtMs?: number;
      enqueuedAtMs?: number;
    }
  | {
      queued: false;
      sessionId: string;
      reason:
        | ReplyBackendQueueMessageMismatch
        | "no_active_run"
        | "not_streaming"
        | "stale_run"
        | "compacting"
        | "guarded_injection_unsupported"
        | "runtime_rejected";
      gatewayHealth: "live";
      errorMessage?: string;
    };

type RealtimeVoiceAgentRunOwner = {
  runId: string;
  sessionId: string;
  sessionKey?: string;
  agentId?: string;
  startedAtMs?: number;
  abort: () => boolean;
};

type RealtimeVoiceAgentControlDeps = {
  queueGuardedEmbeddedAgentMessageWithOutcomeAsync?: (
    sessionId: string,
    text: string,
    options: ReplyMessageInjectionOptions | undefined,
    canInject: () => boolean,
    sourcePreparation?: Pick<ReplyToolAuthorityPreparation, "assertCurrent" | "prepareCurrent"> &
      Partial<Pick<ReplyToolAuthorityPreparation, "compatAssertCurrent">> & {
        prepareMessage?: () => Promise<string>;
      },
  ) => Promise<RealtimeVoiceAgentQueueOutcome>;
  abortEmbeddedAgentRun: (sessionId: string) => boolean;
  queueEmbeddedAgentMessageWithOutcomeAsync: (
    sessionId: string,
    text: string,
    options?: {
      steeringMode?: "all";
      debounceMs?: number;
      isInboundUserMessage?: boolean;
      taskSuggestionDeliveryMode?: undefined;
      toolAuthorityOverlay?: ReplyToolAuthorityOverlay;
      userTurnTranscriptRecorder?: UserTurnTranscriptRecorder;
    },
  ) => Promise<RealtimeVoiceAgentQueueOutcome>;
  getDiagnosticSessionActivitySnapshot: (params: {
    sessionId?: string;
    sessionKey?: string;
  }) => RealtimeVoiceAgentRunActivity;
  resolveActiveEmbeddedRunSessionId: (sessionKey: string) => string | undefined;
  resolveActiveEmbeddedRunOwnerByRunId?: (runId: string) => RealtimeVoiceAgentRunOwner | undefined;
  resolveActiveReplyRunOwnerForSignal?: (
    signal: AbortSignal,
  ) => Pick<RealtimeVoiceAgentRunOwner, "sessionId" | "sessionKey" | "abort"> | undefined;
};

/** Apply a spoken status, cancel, steer, or follow-up request to an active run. */
export async function controlRealtimeVoiceAgentRun(
  params: {
    sessionKey: string;
    /** Exact admitted owner; null forbids lookup, omission retains legacy session-key control. */
    runTarget?: {
      runId: string;
      signal: AbortSignal;
      isCurrent: (sessionId?: string) => boolean;
    } | null;
    text: string;
    getToolAuthorityOverlay?: () => ReplyToolAuthorityOverlay;
    prepareToolAuthorityOverlay?: (overlay: ReplyToolAuthorityOverlay) => Promise<void>;
    /** Host context prepared by the validated authority callback, never provider text. */
    getSteeringContext?: () => string | undefined;
    createUserTurnTranscriptRecorder?: (text: string) => UserTurnTranscriptRecorder;
    mode?: unknown;
    recentEvents?: readonly TalkEvent[];
    /** Optional Gateway Stop override; otherwise cancel the captured exact run owner. */
    cancelRun?: (runId: string) => Promise<boolean>;
  },
  providedDeps?: RealtimeVoiceAgentControlDeps,
): Promise<RealtimeVoiceAgentControlResult> {
  return await controlTalkAgentRun(params, providedDeps);
}

/** Gateway Talk reads caller policy through the worker-backed session reader. */
export async function controlTalkAgentRun(
  params: Parameters<typeof controlRealtimeVoiceAgentRun>[0] & {
    /** Takes precedence over getToolAuthorityOverlay. */
    getToolAuthorityOverlayAsync?: () => Promise<ReplyToolAuthorityOverlay>;
  },
  providedDeps?: RealtimeVoiceAgentControlDeps,
): Promise<RealtimeVoiceAgentControlResult> {
  const sessionKey = params.sessionKey.trim();
  const text = params.text.trim();
  const mode = resolveRealtimeVoiceAgentControlIntent({ text, mode: params.mode }).mode;
  const controlResultContext = { mode, sessionKey };
  const target = params.runTarget;
  let commands:
    | typeof import("./agent-run-control.runtime.js").realtimeVoiceControlRuntime
    | undefined;
  // Exact registered runs need their owner-bound selector, never a key-only lookup.
  // Cold requests without a live registration do not load the mutating runtime.
  if (!providedDeps && target && !target.signal.aborted && target.isCurrent()) {
    commands = (await import("./agent-run-control.runtime.js")).realtimeVoiceControlRuntime;
  }
  const projections =
    commands ??
    (!providedDeps && target === undefined
      ? await import("../sessions/session-controller.queries.js")
      : undefined);
  const resolveCurrentRun = () => {
    const liveTarget = target && !target.signal.aborted && target.isCurrent() ? target : undefined;
    const builtInOwner =
      !providedDeps && liveTarget
        ? commands?.resolveSourceRunOwner(liveTarget.runId, liveTarget.signal)
        : undefined;
    const candidate = liveTarget
      ? providedDeps
        ? (providedDeps.resolveActiveEmbeddedRunOwnerByRunId?.(liveTarget.runId) ??
          providedDeps.resolveActiveReplyRunOwnerForSignal?.(liveTarget.signal))
        : builtInOwner
      : undefined;
    const exactOwner =
      candidate?.sessionKey === sessionKey && target?.isCurrent(candidate.sessionId)
        ? candidate
        : undefined;
    const sessionId =
      target === undefined
        ? providedDeps
          ? providedDeps.resolveActiveEmbeddedRunSessionId(sessionKey)
          : projections?.resolveActiveSessionRunId(sessionKey)
        : exactOwner?.sessionId;
    return { sessionId, exactOwner, operation: exactOwner ? builtInOwner?.operation : undefined };
  };
  let current = resolveCurrentRun();
  // Custom dependency adapters own their state; the built-in selector pins its registry owner.
  const legacyOwner =
    target === undefined && !providedDeps && current.sessionId
      ? captureRealtimeVoiceRunOwner(current.sessionId, sessionKey)
      : undefined;
  const legacySessionId = current.sessionId;
  const isLegacyCurrent = () =>
    providedDeps !== undefined ||
    (current.sessionId === legacySessionId && legacyOwner?.isCurrent() === true);
  const readActivity =
    providedDeps?.getDiagnosticSessionActivitySnapshot ?? getDiagnosticSessionActivitySnapshot;
  // Global keys are shared across agents. Exact selectors never consult another
  // session's key-only diagnostics, including when their live owner disappeared.
  const activity =
    target === undefined
      ? readActivity({ sessionId: current.sessionId, sessionKey })
      : current.sessionId
        ? readActivity({ sessionId: current.sessionId })
        : undefined;
  const active = Boolean(
    current.sessionId || activity?.activeWorkKind || activity?.hasActiveEmbeddedRun,
  );

  // Without an exact live registration, status stays on lightweight diagnostics
  // and remains available even when the mutating runtime cannot load.
  if (mode === "status") {
    return {
      ok: true,
      ...controlResultContext,
      ...(current.sessionId ? { sessionId: current.sessionId } : {}),
      active,
      message: formatRealtimeVoiceAgentStatus({
        active,
        recentEvents: params.recentEvents,
        activity,
      }),
      ...controlResultPresentation,
    };
  }

  const noActiveRun = (): RealtimeVoiceAgentControlResult => ({
    ok: false,
    ...controlResultContext,
    active: false,
    ...(mode === "cancel" ? { aborted: false } : { queued: false }),
    reason: "no_active_run",
    message: `There is no active OpenClaw run to ${mode === "cancel" ? "cancel" : "steer"}.`,
    ...controlResultPresentation,
  });
  if (!current.sessionId || (target === undefined && !isLegacyCurrent())) {
    return noActiveRun();
  }
  if (!providedDeps && !commands) {
    commands = (await import("./agent-run-control.runtime.js")).realtimeVoiceControlRuntime;
    // Loading commands can outlive admission; resolve the exact target again
    // in the continuation that performs the action.
    current = resolveCurrentRun();
  }
  const { sessionId } = current;
  if (!sessionId || (target === undefined && !isLegacyCurrent())) {
    return noActiveRun();
  }
  // Released dependency adapters may ignore optional preparation callbacks.
  const deferMessagePreparation = !providedDeps && Boolean(target || legacyOwner);
  const toolAuthorityOverlay = params.getToolAuthorityOverlayAsync
    ? await params.getToolAuthorityOverlayAsync()
    : params.getToolAuthorityOverlay?.();
  if (toolAuthorityOverlay && (mode === "cancel" || !deferMessagePreparation)) {
    await params.prepareToolAuthorityOverlay?.(toolAuthorityOverlay);
  }
  const preparedOwner = resolveCurrentRun();
  if (
    preparedOwner.sessionId !== sessionId ||
    (target ? !target.isCurrent(sessionId) : !isLegacyCurrent())
  ) {
    return noActiveRun();
  }
  if (mode === "cancel") {
    const aborted =
      target === undefined
        ? providedDeps
          ? providedDeps.abortEmbeddedAgentRun(sessionId)
          : await commands!.stopRealtimeVoiceSessionRun({ sessionKey, sessionId })
        : target !== null &&
          (params.cancelRun
            ? await params.cancelRun(target.runId)
            : preparedOwner.exactOwner?.abort() === true);
    const message = aborted
      ? "Cancelled the active OpenClaw run."
      : "OpenClaw could not cancel the active run.";
    return {
      ok: aborted,
      ...controlResultContext,
      sessionId,
      active: true,
      aborted,
      ...(aborted ? {} : { reason: "abort_rejected" }),
      message,
      ...controlResultPresentation,
      ...(aborted ? { providerResult: buildRealtimeVoiceAgentCancelProviderResult(message) } : {}),
    };
  }

  // Steering and follow-up both enqueue to the active run; follow-up is wrapped
  // so the runner treats it as deferred context instead of an immediate pivot.
  const prepareMessage = () => {
    const steeringText = [params.getSteeringContext?.(), text].filter(Boolean).join("\n\n");
    const steerText =
      mode === "followup"
        ? buildRealtimeVoiceAgentFollowupSteeringText(steeringText)
        : steeringText;
    options.userTurnTranscriptRecorder = params.createUserTurnTranscriptRecorder?.(steerText);
    return steerText;
  };
  const options: NonNullable<
    Parameters<RealtimeVoiceAgentControlDeps["queueEmbeddedAgentMessageWithOutcomeAsync"]>[2]
  > = {
    steeringMode: "all" as const,
    debounceMs: 0,
    isInboundUserMessage: true,
    toolAuthorityOverlay,
    // Talk cannot present task suggestions, so spoken user input must not inherit
    // a capable TUI run's model-facing task tools.
    taskSuggestionDeliveryMode: undefined,
  };
  const steerText = deferMessagePreparation ? text : prepareMessage();
  const prepareCurrent = async () => {
    const overlay = params.getToolAuthorityOverlayAsync
      ? await params.getToolAuthorityOverlayAsync()
      : params.getToolAuthorityOverlay?.();
    if (overlay) {
      await params.prepareToolAuthorityOverlay?.(overlay);
    }
    options.toolAuthorityOverlay = overlay;
  };
  const canInject = () => {
    options.toolAuthorityOverlay?.operatorAuthority?.assertCurrent();
    return target
      ? !target.signal.aborted && target.isCurrent(sessionId)
      : legacyOwner?.isCurrent() === true;
  };
  const preparation = bindPreparedToolAuthority(
    bindWorkerToolPreparation({
      assertCurrent: () => {
        if (!canInject()) {
          throw new Error("The original Talk run is no longer current");
        }
      },
      compatAssertCurrent: () => {
        // An asynchronous reader cannot repeat its read here; check the overlay it
        // prepared for this admission while assertCurrent rechecks live operator authority.
        const overlay = params.getToolAuthorityOverlayAsync
          ? options.toolAuthorityOverlay
          : params.getToolAuthorityOverlay?.();
        options.toolAuthorityOverlay = overlay;
        if (overlay && legacyOwner && !legacyOwner.matchesCaller(overlay)) {
          throw new Error("The original Talk caller authority no longer matches");
        }
      },
      prepareCurrent,
      prepareMessage: deferMessagePreparation
        ? async () => {
            await prepareCurrent();
            return prepareMessage();
          }
        : undefined,
    }),
  );
  let outcome: RealtimeVoiceAgentQueueOutcome;
  if (providedDeps) {
    outcome = target
      ? providedDeps.queueGuardedEmbeddedAgentMessageWithOutcomeAsync
        ? await providedDeps.queueGuardedEmbeddedAgentMessageWithOutcomeAsync(
            sessionId,
            steerText,
            options,
            canInject,
            preparation,
          )
        : {
            queued: false,
            sessionId,
            gatewayHealth: "live",
            reason: "guarded_injection_unsupported",
          }
      : await providedDeps.queueEmbeddedAgentMessageWithOutcomeAsync(sessionId, steerText, options);
  } else {
    const injectionOptions: ReplyMessageInjectionOptions = options;
    injectionOptions.assertCurrent = preparation.assertCurrent;
    injectionOptions.toolAuthorityPreparation = preparation;
    let queueAccepted: boolean | undefined;
    injectionOptions.onQueueAccepted = (accepted) => {
      queueAccepted = queueAccepted === true || accepted;
    };
    let steer: SessionControllerSteerResult;
    try {
      steer = await commands!.steerActiveRun(
        preparedOwner.operation ?? legacyOwner?.operation,
        steerText,
        injectionOptions,
      );
    } catch (error) {
      // A final refusal proves no enqueue; an accepted or missing receipt stays uncertain.
      const errorMessage = formatErrorMessage(error);
      steer =
        queueAccepted === false
          ? { status: "rejected", reason: "runtime_rejected", errorMessage }
          : { status: "indeterminate", errorMessage };
    }
    if (steer.status === "rejected") {
      return {
        ok: false,
        ...controlResultContext,
        sessionId,
        active: true,
        queued: false,
        reason: steer.reason,
        message: formatRealtimeVoiceAgentQueueRejection(mode, steer.reason),
        ...controlResultPresentation,
      };
    }
    outcome = {
      queued: true,
      sessionId,
      gatewayHealth: "live",
      ...(steer.status === "indeterminate" || steer.result?.transcriptCommit === "unconfirmed"
        ? { transcriptCommit: "unconfirmed" as const }
        : {}),
    };
  }
  if (!outcome.queued) {
    return {
      ok: false,
      ...controlResultContext,
      sessionId: outcome.sessionId,
      active: true,
      queued: false,
      reason: outcome.reason,
      message: formatRealtimeVoiceAgentQueueRejection(mode, outcome.reason),
      ...controlResultPresentation,
    };
  }

  const unconfirmed = outcome.transcriptCommit === "unconfirmed";
  const message = unconfirmed
    ? "OpenClaw could not confirm that input. It was not sent again; check the conversation before retrying."
    : mode === "followup"
      ? "Queued that follow-up for the active OpenClaw run."
      : "Got it. I steered the active run.";
  return {
    ok: !unconfirmed,
    ...controlResultContext,
    sessionId: outcome.sessionId,
    active: true,
    queued: true,
    ...(outcome.target ? { target: outcome.target } : {}),
    ...(unconfirmed ? { reason: "delivery_unconfirmed" } : {}),
    message,
    ...controlResultPresentation,
    ...(outcome.enqueuedAtMs !== undefined ? { enqueuedAtMs: outcome.enqueuedAtMs } : {}),
    ...(outcome.deliveredAtMs !== undefined ? { deliveredAtMs: outcome.deliveredAtMs } : {}),
  };
}
