import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import { ErrorCodes, errorShape } from "../../../packages/gateway-protocol/src/index.js";
import type { AdmittedRunOperatorAuthority } from "../../agents/admitted-run-context.js";
import {
  hasLegacyAutoFallbackWithoutOrigin,
  hasSessionAutoModelFallbackProvenance,
} from "../../agents/agent-scope.js";
import { bindWorkerToolPreparation } from "../../agents/harness/host-private-capabilities.js";
import { bindPreparedToolAuthority } from "../../agents/harness/tool-authority-preparation.js";
import { resolveModelFallbackAvailability } from "../../agents/model-selection-config.js";
import { resolveCommandAuthorizationAsync } from "../../auto-reply/command-auth.js";
import { resolveEnvelopeFormatOptions } from "../../auto-reply/envelope.js";
import { buildInboundMediaNoteProjection } from "../../auto-reply/media-note.js";
import { emitInboundMessageAuditTerminal } from "../../auto-reply/reply/dispatch-from-config.audit.js";
import { finalizeInboundContext } from "../../auto-reply/reply/inbound-context.js";
import { hasInboundAudio } from "../../auto-reply/reply/inbound-media.js";
import { buildInboundUserContextPrefix } from "../../auto-reply/reply/inbound-meta.js";
import { MessageInjectionTargetUnavailableError } from "../../auto-reply/reply/message-injection-authority.js";
import { emitMessageReceivedHooks } from "../../auto-reply/reply/message-received-hooks.js";
import { refuseCollaborativeSteering } from "../../auto-reply/reply/queue/lifecycle.js";
import { resolveQueueSettings } from "../../auto-reply/reply/queue/settings-runtime.js";
import type { ReplyOperationRunState } from "../../auto-reply/reply/reply-operation-run-state.js";
import { resolveInboundReplyToolAuthorityOverlay } from "../../auto-reply/reply/reply-tool-authority.js";
import { prepareSteeringDelivery } from "../../auto-reply/reply/steering-delivery-preparation.js";
import type { RuntimeMsgContext } from "../../auto-reply/templating.js";
import type { SessionEntry } from "../../config/sessions.js";
import { updateSessionEntry } from "../../config/sessions/session-accessor.js";
import { isDiagnosticsEnabled } from "../../infra/diagnostic-events.js";
import { logMessageProcessed, logMessageReceived } from "../../logging/diagnostic.js";
import type { InboundDocumentContext } from "../../media-understanding/file-context.js";
import { getGlobalHookRunner } from "../../plugins/hook-runner-global.js";
import { isProgressCardRefreshInputProvenance } from "../../sessions/input-provenance.js";
import { captureReplySessionExecutionSelection } from "../../sessions/session-controller.execution-selection.js";
import {
  beginSessionControllerSteer,
  finalizeReplyMessageInjectionAttempt,
  type ReplyBackendQueueMessageOptions,
  type ReplyMessageInjectionAttempt,
  type ReplyMessageInjectionTarget,
} from "../../sessions/session-controller.js";
import { prepareReplyMessageContinuation } from "../../sessions/session-controller.message-join.js";
import {
  getRpcSourceIdentity,
  getRpcSourceLifecycleGeneration,
  type RpcSourceRef,
} from "../../sessions/session-controller.rpc-sources.js";
import { recordAcceptedSessionParticipantInput } from "../../sessions/session-participant-input-recording.js";
import type { UserTurnTranscriptPersistResult } from "../../sessions/user-turn-transcript.types.js";
import { captureAgentJobSession, setGatewayDedupeEntry } from "../agent-turn/agent-job.js";
import type { ChatImageContent } from "../chat-attachments.js";
import { broadcastChatError, broadcastChatFinal } from "./chat-broadcast.js";
import type { ChatSendDiagnostics } from "./chat-send-diagnostics.js";
import { buildChatSendReplyInjectionText } from "./chat-send-reply-context.js";
import type { NormalizedChatSendRequest } from "./chat-send-request.js";
import type { PreparedChatSendSession } from "./chat-send-session.js";
import type { prepareChatSendUserTurn } from "./chat-send-user-turn.js";
import type { GatewayRequestContext } from "./types.js";

/** Captures admitted request data for the detached injection attempt. */
export function createChatSendMessageInjectionStarter(params: {
  target: ReplyMessageInjectionTarget | undefined;
  sourceRef: RpcSourceRef;
  abortSignal: AbortSignal;
  request: Pick<NormalizedChatSendRequest, "p" | "rawMessage" | "supportsTaskSuggestions">;
  session: Pick<
    PreparedChatSendSession,
    | "agentId"
    | "cfg"
    | "entry"
    | "sessionKey"
    | "storePath"
    | "clientRunId"
    | "resolvedSessionModel"
  >;
  admittedSessionSettings?: Readonly<Pick<SessionEntry, "permissionMode" | "toolOverrides">>;
  turn: Pick<
    Awaited<ReturnType<typeof prepareChatSendUserTurn>>,
    "ctx" | "isInternalTextSlashCommandTurn" | "replyOptionImages" | "replyOptionMedia"
  >;
  imageOrder: ReplyBackendQueueMessageOptions["imageOrder"];
  documentContext?: ({ status: "rendered" } & InboundDocumentContext) | { status: "failed" };
  userTurnTranscriptRecorder: NonNullable<
    ReplyBackendQueueMessageOptions["userTurnTranscriptRecorder"]
  >;
  logGateway: GatewayRequestContext["logGateway"];
  assertCurrent?: () => void;
  operatorAuthority?: AdmittedRunOperatorAuthority;
  diagnostics?: ChatSendDiagnostics;
}) {
  const { p, rawMessage, supportsTaskSuggestions } = params.request;
  const { agentId, cfg, entry, sessionKey, storePath, clientRunId, resolvedSessionModel } =
    params.session;
  const { ctx, isInternalTextSlashCommandTurn, replyOptionImages, replyOptionMedia } = params.turn;
  const assertCurrent = () => {
    params.abortSignal.throwIfAborted();
    params.assertCurrent?.();
    params.operatorAuthority?.assertCurrent();
  };
  return async (): Promise<ReplyMessageInjectionAttempt | undefined> => {
    const target = params.target;
    if (!target || isInternalTextSlashCommandTurn) {
      return undefined;
    }
    using phase = params.diagnostics?.scope("detail.run_admission.steer_authority");
    assertCurrent();
    const delivery = prepareSteeringDelivery({
      agentId,
      sessionKey,
      storePath,
      sessionId: entry?.sessionId,
      sourceTurnId: normalizeOptionalString(target.sourceTurnId),
      entry,
      assertCurrent,
    });
    let handedOff = false;
    let join: Awaited<ReturnType<typeof prepareReplyMessageContinuation>> | undefined;
    const release = () => {
      if (join?.kind === "prepared") {
        join.release();
      }
      delivery.release();
    };
    try {
      const canAdmit = () => {
        try {
          delivery.assertCurrent();
          return true;
        } catch (error) {
          if (!(error instanceof MessageInjectionTargetUnavailableError)) {
            throw error;
          }
          params.logGateway.warn("chat steering rejected; falling back to follow-up dispatch", {
            reason: "terminal-delivery-unavailable",
            runId: clientRunId,
            activeRunId: target.runId,
            sessionKey,
            error: error.message,
          });
          return false;
        }
      };
      const { debounceMs } = resolveQueueSettings({
        cfg,
        channel: ctx.Provider,
        sessionEntry: entry,
        inlineMode: p.queueMode,
      });
      const baseText = ctx.BodyForAgent ?? ctx.Body ?? rawMessage;
      const rendered =
        params.documentContext?.status === "rendered" ? params.documentContext : undefined;
      const documentContext = rendered?.text.trim();
      let text = baseText;
      if (documentContext || params.documentContext?.status === "failed") {
        text = [buildInboundMediaNoteProjection(ctx).text, baseText.trim(), documentContext]
          .filter(Boolean)
          .join("\n\n");
      }
      const documentImages = rendered?.images ?? [];
      const injectionImages: ChatImageContent[] | undefined =
        documentImages.length > 0
          ? [
              ...(replyOptionImages ?? []),
              // Keep the same inline-then-extracted ordering reply dispatch produces.
              ...documentImages.map((image): ChatImageContent => ({
                type: "image",
                data: image.data,
                mimeType: image.mimeType,
              })),
            ]
          : replyOptionImages;
      const authorization = await resolveCommandAuthorizationAsync({
        ctx,
        cfg,
        commandAuthorized: ctx.CommandAuthorized === true,
      });
      const overlay = resolveInboundReplyToolAuthorityOverlay({
        ctx,
        sessionEntry: {
          spawnedBy: entry?.spawnedBy,
          permissionMode: params.admittedSessionSettings?.permissionMode,
          toolOverrides: params.admittedSessionSettings?.toolOverrides,
        },
        senderIsOwner: authorization.senderIsOwner,
        operatorAuthority: params.operatorAuthority,
        disableTools: false,
      });
      const {
        traceAuthorized: _trace,
        allowCollaborativeSteering: _collaboration,
        ...caller
      } = overlay;
      phase?.mark("detail.run_admission.steer_continuation");
      join = await prepareReplyMessageContinuation({
        target,
        assertCurrent,
        delivery,
        input: {
          kind: "continuation",
          caller,
          config: cfg,
          executionSelection: captureReplySessionExecutionSelection({
            config: cfg,
            agentId,
            sessionEntry: entry,
          }),
          selectedRoute: resolvedSessionModel,
          fallbackAvailability: resolveModelFallbackAvailability({
            cfg,
            agentId,
            sessionKey,
            selectedModel: resolvedSessionModel,
            hasSessionModelOverride:
              entry?.modelOverrideSource !== "default" &&
              Boolean(entry?.modelOverride || entry?.providerOverride) &&
              !hasLegacyAutoFallbackWithoutOrigin(entry),
            modelOverrideSource:
              entry?.modelOverrideSource === "default" ? undefined : entry?.modelOverrideSource,
            hasAutoFallbackProvenance: hasSessionAutoModelFallbackProvenance(entry),
            modelSelectionLocked: entry?.modelSelectionLocked,
          }),
        },
      });
      if (join.kind === "deferred") {
        params.logGateway.warn("chat steering rejected; falling back to follow-up dispatch", {
          reason: join.reason,
          error: join.errorMessage,
          runId: clientRunId,
          activeRunId: target.runId,
          sessionKey,
        });
        return undefined;
      }
      const preparedJoin = join.kind === "prepared" ? join : undefined;
      phase?.mark("detail.run_admission.steer_delivery");
      try {
        await delivery.prepareCurrent();
      } catch (error) {
        assertCurrent();
        params.logGateway.warn("chat steering rejected; falling back to follow-up dispatch", {
          reason: "terminal-delivery-unavailable",
          runId: clientRunId,
          activeRunId: target.runId,
          sessionKey,
          error: String(error),
        });
        return undefined;
      }
      let admissionRefused = false;
      phase?.mark("detail.run_admission.steer_admit");
      const attempt = await beginSessionControllerSteer({
        input: params.sourceRef.input,
        target,
        text: p.replyToId
          ? buildChatSendReplyInjectionText({ body: text, cfg, ctx, sessionEntry: entry })
          : text,
        options: {
          // Reply-target injection already includes this prefix in its text.
          currentInboundContext: p.replyToId
            ? undefined
            : {
                text: buildInboundUserContextPrefix(ctx, resolveEnvelopeFormatOptions(cfg), entry),
              },
          canAdmit: () => {
            admissionRefused = !canAdmit();
            return !admissionRefused;
          },
          assertCurrent:
            params.assertCurrent || params.operatorAuthority ? assertCurrent : undefined,
          toolAuthorityPreparation: bindPreparedToolAuthority(
            bindWorkerToolPreparation({
              authorityKind:
                params.assertCurrent || params.operatorAuthority
                  ? ("source-bound" as const)
                  : ("run" as const),
              assertCurrent,
              compatAssertCurrent: () => {
                assertCurrent();
                preparedJoin?.read();
              },
              prepareCurrent: async () => {
                await preparedJoin?.prepareCurrent();
                await delivery.prepareCurrent();
              },
            }),
          ),
          inboundAudio: hasInboundAudio(ctx),
          steeringMode: "all",
          isInboundUserMessage: true,
          allowCollaborativeSteering:
            cfg.messages?.queue?.allowCollaborativeSteering === true &&
            (!ctx.InputProvenance || ctx.InputProvenance.kind === "external_user"),
          ...(isProgressCardRefreshInputProvenance(ctx.InputProvenance)
            ? { allowPendingUserInputAnswer: false as const, debounceMs: 0 }
            : {}),
          ...(preparedJoin
            ? { toolAuthorityFingerprint: preparedJoin.fingerprint }
            : { toolAuthorityOverlay: overlay }),
          ...(injectionImages?.length ? { images: injectionImages } : {}),
          ...(params.imageOrder?.length ? { imageOrder: params.imageOrder } : {}),
          ...(replyOptionMedia?.length ? { media: replyOptionMedia } : {}),
          waitForTranscriptCommit: true,
          abortSignal: params.abortSignal,
          ...(!isProgressCardRefreshInputProvenance(ctx.InputProvenance) && debounceMs !== undefined
            ? { debounceMs }
            : {}),
          taskSuggestionDeliveryMode: supportsTaskSuggestions ? "gateway" : undefined,
          userTurnTranscriptRecorder: params.userTurnTranscriptRecorder,
        },
      });
      if (!attempt) {
        return undefined;
      }
      void attempt.outcome.then(release, release);
      handedOff = true;
      return admissionRefused ? undefined : attempt;
    } finally {
      if (!handedOff) {
        release();
      }
    }
  };
}

/** Keep a terminal injection decision through detached preparation and reply dispatch. */
export function createChatSendInjectionDisposition(
  run: Parameters<typeof refuseCollaborativeSteering>[0],
) {
  let refused = false;
  const runState: ReplyOperationRunState = {};
  const isRefused = () =>
    refused ||
    (runState.admission?.status === "skipped" &&
      runState.admission.reason === "collaborative-steering-disabled");
  return {
    runState,
    isRefused,
    async observe(attempt: ReplyMessageInjectionAttempt | undefined) {
      const outcome = await attempt?.outcome;
      if (outcome?.status === "rejected" && outcome.reason === "collaborative_steering_disabled") {
        refused = true;
        runState.admission = { status: "skipped", reason: "collaborative-steering-disabled" };
        return undefined;
      }
      return attempt;
    },
    async settleRefusal() {
      if (isRefused()) {
        await refuseCollaborativeSteering(run, runState);
      }
    },
  };
}

/** Join steering before fallible source preparation can trigger a separate reply. */
export async function settleChatSendMessageInjection(
  attempt: ReplyMessageInjectionAttempt | undefined,
): Promise<boolean> {
  if (!attempt) {
    return false;
  }
  const outcome = await attempt.outcome;
  if (outcome.status === "failed") {
    throw outcome.error;
  }
  return outcome.status !== "rejected";
}

/** Finish an accepted steer without entering reply dispatch, or return false for fallback. */
export async function finalizeAcceptedChatSendMessageInjection(params: {
  attempt: ReplyMessageInjectionAttempt;
  sourceRef?: RpcSourceRef;
  context: GatewayRequestContext;
  ctx: RuntimeMsgContext;
  persistUserTurnTranscriptBestEffort: () => Promise<UserTurnTranscriptPersistResult | undefined>;
  session: Pick<
    PreparedChatSendSession,
    "agentId" | "cfg" | "clientRunId" | "entry" | "sessionKey" | "storePath"
  >;
  startedAt: number;
  target: ReplyMessageInjectionTarget;
}): Promise<boolean> {
  const { context, ctx, session } = params;
  const { agentId, cfg, clientRunId, entry, sessionKey, storePath } = session;
  const finalizedCtx = finalizeInboundContext(ctx);
  const progressRefresh = isProgressCardRefreshInputProvenance(ctx.InputProvenance);
  const finalization = await finalizeReplyMessageInjectionAttempt({
    attempt: params.attempt,
    target: params.target,
    inboundAudio: hasInboundAudio(finalizedCtx),
  });
  if (finalization.status === "rejected") {
    // Rejection also covers withdrawing a canceled queued steer. Fallback
    // dispatch retains the source run's abort signal and skips canceled input.
    return false;
  }
  recordAcceptedSessionParticipantInput(ctx, { agentId, sessionKey, storePath });
  const channel = normalizeLowercaseStringOrEmpty(
    finalizedCtx.Surface ?? finalizedCtx.Provider ?? "unknown",
  );
  const chatId = finalizedCtx.To ?? finalizedCtx.From;
  const messageId =
    finalizedCtx.MessageSidFull ??
    finalizedCtx.MessageSid ??
    finalizedCtx.MessageSidFirst ??
    finalizedCtx.MessageSidLast;
  const indeterminate =
    finalization.status === "indeterminate" ? finalization.outcome.errorMessage : undefined;
  const outcomeReason = indeterminate
    ? progressRefresh
      ? "progress_refresh_receipt_unconfirmed"
      : "question_response_indeterminate"
    : "active_run_injected";
  await params.persistUserTurnTranscriptBestEffort();
  if (isDiagnosticsEnabled(cfg)) {
    logMessageReceived({
      sessionKey,
      channel,
      chatId,
      messageId,
      source: "dispatchInboundMessage",
    });
    logMessageProcessed({
      channel,
      chatId,
      messageId,
      sessionId: entry?.sessionId,
      sessionKey,
      durationMs: Math.max(0, Date.now() - params.startedAt),
      outcome: indeterminate ? "error" : "completed",
      reason: outcomeReason,
    });
  }
  emitMessageReceivedHooks({
    ctx: finalizedCtx,
    hookRunner: getGlobalHookRunner(),
    sessionKey,
    timestamp:
      typeof finalizedCtx.Timestamp === "number" && Number.isFinite(finalizedCtx.Timestamp)
        ? finalizedCtx.Timestamp
        : undefined,
  });
  emitInboundMessageAuditTerminal({
    cfg,
    counts: { tool: 0, block: 0, final: 0 },
    ctx: finalizedCtx,
    observedRunId: clientRunId,
    startedAt: params.startedAt,
    terminal: indeterminate
      ? { outcome: "error", options: { reason: outcomeReason, error: indeterminate } }
      : { outcome: "completed", options: { reason: outcomeReason } },
  });
  const updatedAt = Date.now();
  if (entry) {
    session.entry = { ...entry, updatedAt };
  }
  await updateSessionEntry({ storePath, sessionKey }, () => ({ updatedAt }), {
    skipMaintenance: true,
    takeCacheOwnership: true,
  }).catch((error: unknown) => {
    context.logGateway.warn(`failed to touch session after accepted steering: ${String(error)}`);
  });
  if (!context.chatRunState.hasAbortMarker(clientRunId)) {
    setGatewayDedupeEntry({
      dedupe: context.dedupe,
      key: `chat:${clientRunId}`,
      session: captureAgentJobSession(
        params.sourceRef
          ? {
              ...getRpcSourceIdentity(params.sourceRef),
              lifecycleGeneration: getRpcSourceLifecycleGeneration(params.sourceRef),
            }
          : undefined,
      ),
      entry: {
        ts: Date.now(),
        ok: progressRefresh || !indeterminate,
        payload: {
          runId: clientRunId,
          // An accepted refresh steer is not a completed status turn, even if
          // its transcript receipt is unconfirmed. Retrying must not replay it.
          status: progressRefresh ? "accepted" : indeterminate ? "error" : "ok",
          ...(indeterminate ? { summary: indeterminate } : {}),
        },
        ...(!progressRefresh && indeterminate
          ? { error: errorShape(ErrorCodes.UNAVAILABLE, indeterminate) }
          : {}),
      },
    });
    if (indeterminate) {
      broadcastChatError({
        terminalEntry: params.sourceRef,
        context,
        runId: clientRunId,
        sessionKey,
        agentId,
        errorMessage: indeterminate,
      });
    } else {
      broadcastChatFinal({
        context,
        runId: clientRunId,
        sessionKey,
        agentId,
        terminalEntry: params.sourceRef,
      });
    }
  }
  return true;
}
