import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import { ErrorCodes, errorShape } from "../../../packages/gateway-protocol/src/index.js";
import type { AdmittedRunOperatorAuthority } from "../../agents/admitted-run-context.js";
import { bindWorkerToolPreparation } from "../../agents/harness/host-private-capabilities.js";
import { bindPreparedToolAuthority } from "../../agents/harness/tool-authority-preparation.js";
import { resolveCommandAuthorization } from "../../auto-reply/command-auth.js";
import { resolveEnvelopeFormatOptions } from "../../auto-reply/envelope.js";
import { buildInboundMediaNoteProjection } from "../../auto-reply/media-note.js";
import { emitInboundMessageAuditTerminal } from "../../auto-reply/reply/dispatch-from-config.audit.js";
import { finalizeInboundContext } from "../../auto-reply/reply/inbound-context.js";
import { hasInboundAudio } from "../../auto-reply/reply/inbound-media.js";
import { buildInboundUserContextPrefix } from "../../auto-reply/reply/inbound-meta.js";
import { emitMessageReceivedHooks } from "../../auto-reply/reply/message-received-hooks.js";
import { resolveQueueSettings } from "../../auto-reply/reply/queue/settings-runtime.js";
import {
  beginReplyMessageInjectionTarget,
  finalizeReplyMessageInjectionAttempt,
  type ReplyBackendQueueMessageOptions,
  type ReplyMessageInjectionAttempt,
  type ReplyMessageInjectionTarget,
} from "../../auto-reply/reply/reply-run-registry.js";
import { resolveInboundReplyToolAuthorityOverlay } from "../../auto-reply/reply/reply-tool-authority.js";
import { prepareSteeringDelivery } from "../../auto-reply/reply/steering-delivery-preparation.js";
import type { RuntimeMsgContext } from "../../auto-reply/templating.js";
import type { SessionEntry } from "../../config/sessions.js";
import { resolveRestartRecoverySteeringBlockReason } from "../../config/sessions/restart-recovery-receipt.js";
import { loadSessionEntry, updateSessionEntry } from "../../config/sessions/session-accessor.js";
import { isDiagnosticsEnabled } from "../../infra/diagnostic-events.js";
import { logMessageProcessed, logMessageReceived } from "../../logging/diagnostic.js";
import type { InboundDocumentContext } from "../../media-understanding/file-context.js";
import { getGlobalHookRunner } from "../../plugins/hook-runner-global.js";
import { isProgressCardRefreshInputProvenance } from "../../sessions/input-provenance.js";
import { recordAcceptedSessionParticipantInput } from "../../sessions/session-participant-input-recording.js";
import { captureAgentJobSession, setGatewayDedupeEntry } from "../agent-turn/agent-job.js";
import type { ChatAbortControllerEntry } from "../chat-abort.js";
import type { ChatImageContent } from "../chat-attachments.js";
import { broadcastChatError, broadcastChatFinal } from "./chat-broadcast.js";
import { buildChatSendReplyInjectionText } from "./chat-send-reply-context.js";
import type { NormalizedChatSendRequest } from "./chat-send-request.js";
import type { PreparedChatSendSession } from "./chat-send-session.js";
import type { prepareChatSendUserTurn } from "./chat-send-user-turn.js";
import type { GatewayRequestContext } from "./types.js";

/** Captures the prepared request data used by both pre-ACK and detached injection attempts. */
export function createChatSendMessageInjectionStarter(params: {
  target: ReplyMessageInjectionTarget | undefined;
  abortSignal: AbortSignal;
  request: Pick<NormalizedChatSendRequest, "p" | "rawMessage" | "supportsTaskSuggestions">;
  session: Pick<
    PreparedChatSendSession,
    "agentId" | "cfg" | "entry" | "sessionKey" | "storePath" | "clientRunId"
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
}) {
  const { p, rawMessage, supportsTaskSuggestions } = params.request;
  const { agentId, cfg, entry, sessionKey, storePath, clientRunId } = params.session;
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
    let admissionRefused = false;
    const canAdmit = () => {
      assertCurrent();
      // Preparation can outlive terminal delivery. Recheck before the backend
      // takes this input; an unreadable receipt cannot authorize steering.
      let fenceEntry = entry;
      if (sessionKey) {
        try {
          fenceEntry =
            loadSessionEntry({
              sessionKey,
              storePath,
              readConsistency: "latest",
            }) ?? entry;
        } catch (error: unknown) {
          params.logGateway.warn("chat steering rejected; falling back to follow-up dispatch", {
            reason: "session-entry-unavailable",
            runId: clientRunId,
            activeRunId: target.runId,
            sessionKey,
            error: String(error),
          });
          return false;
        }
      }
      // Terminal run ids are accumulated session history; compare the fence
      // against the active source-turn identity (carried on the injection target
      // by the owning registry, falling back to the entry's own claim source) so
      // an unrelated earlier tombstone does not force a safe steer into
      // follow-up mode.
      const activeSourceTurnId =
        normalizeOptionalString(target.sourceTurnId) ??
        normalizeOptionalString(fenceEntry?.restartRecoveryDeliverySourceRunId) ??
        "";
      const blockReason = fenceEntry
        ? resolveRestartRecoverySteeringBlockReason(
            fenceEntry,
            fenceEntry.sessionId,
            activeSourceTurnId,
          )
        : undefined;
      if (blockReason) {
        params.logGateway.warn("chat steering rejected; falling back to follow-up dispatch", {
          reason: blockReason,
          runId: clientRunId,
          activeRunId: target.runId,
          sourceTurnId: activeSourceTurnId || undefined,
          sourceTurnIdOrigin: target.sourceTurnId
            ? "active-run"
            : activeSourceTurnId
              ? "recovery-claim"
              : "unknown",
          sessionKey,
          sessionId: fenceEntry?.sessionId,
          sessionStatus: fenceEntry?.status,
          recoveryRunId: fenceEntry?.restartRecoveryDeliveryRunId,
          recoverySourceTurnId: fenceEntry?.restartRecoveryDeliverySourceRunId,
        });
        return false;
      }
      return true;
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
            // Extracted page images follow the prepared inbound images, the
            // same inline-then-extracted ordering reply dispatch produces; each
            // keeps its attachment index as ordering provenance.
            ...documentImages.map((image): ChatImageContent => ({
              type: "image",
              data: image.data,
              mimeType: image.mimeType,
              sourceIndex: image.attachmentIndex,
            })),
          ]
        : replyOptionImages;
    const authorization = resolveCommandAuthorization({
      ctx,
      cfg,
      commandAuthorized: ctx.CommandAuthorized === true,
    });
    const attempt = await beginReplyMessageInjectionTarget(
      target,
      p.replyToId
        ? buildChatSendReplyInjectionText({ body: text, cfg, ctx, sessionEntry: entry })
        : text,
      {
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
        assertCurrent: params.assertCurrent || params.operatorAuthority ? assertCurrent : undefined,
        toolAuthorityPreparation: bindPreparedToolAuthority(
          bindWorkerToolPreparation({
            authorityKind:
              params.assertCurrent || params.operatorAuthority
                ? ("source-bound" as const)
                : ("run" as const),
            assertCurrent,
            compatAssertCurrent: assertCurrent,
            prepareCurrent: delivery.prepareCurrent,
          }),
        ),
        inboundAudio: hasInboundAudio(ctx),
        steeringMode: "all",
        isInboundUserMessage: true,
        ...(isProgressCardRefreshInputProvenance(ctx.InputProvenance)
          ? { allowPendingUserInputAnswer: false as const, debounceMs: 0 }
          : {}),
        toolAuthorityOverlay: resolveInboundReplyToolAuthorityOverlay({
          ctx,
          sessionEntry: {
            spawnedBy: entry?.spawnedBy,
            permissionMode: params.admittedSessionSettings?.permissionMode,
            toolOverrides: params.admittedSessionSettings?.toolOverrides,
          },
          senderIsOwner: authorization.senderIsOwner,
          operatorAuthority: params.operatorAuthority,
          disableTools: false,
        }),
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
    );
    return admissionRefused ? undefined : attempt;
  };
}

type PreAckMessageInjectionResult =
  | { status: "continue"; attempt: ReplyMessageInjectionAttempt | undefined }
  | { status: "handled" };

/** Wait for runtime ownership before ACK without waiting for transcript commitment. */
export async function settleChatSendPreAckMessageInjection(params: {
  attempt: ReplyMessageInjectionAttempt | undefined;
  isAborted: () => boolean;
  sessionRoutingChanged: () => boolean;
  onAborted: () => void;
  onSessionRoutingChanged: () => void;
}): Promise<PreAckMessageInjectionResult> {
  if (!params.attempt || (await params.attempt.acceptance)) {
    return { status: "continue", attempt: params.attempt };
  }
  const outcome = await params.attempt.outcome;
  if (outcome.status === "failed") {
    throw outcome.error;
  }
  if (params.isAborted()) {
    params.onAborted();
    return { status: "handled" };
  }
  if (params.sessionRoutingChanged()) {
    params.onSessionRoutingChanged();
    return { status: "handled" };
  }
  return { status: "continue", attempt: undefined };
}

/** Pre-ACK steering is already owned; join it before fallible source preparation. */
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
  sessionBinding?: Readonly<
    Pick<ChatAbortControllerEntry, "sessionKey" | "sessionId" | "agentId" | "lifecycleGeneration">
  > &
    Pick<ChatAbortControllerEntry, "terminalOutcomeObserved">;
  context: GatewayRequestContext;
  ctx: RuntimeMsgContext;
  persistUserTurnTranscriptBestEffort: () => Promise<void>;
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
    entry.updatedAt = updatedAt;
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
      session: captureAgentJobSession(params.sessionBinding),
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
        terminalEntry: params.sessionBinding,
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
        terminalEntry: params.sessionBinding,
      });
    }
  }
  return true;
}
