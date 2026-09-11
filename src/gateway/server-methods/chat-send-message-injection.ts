import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import { ErrorCodes, errorShape } from "../../../packages/gateway-protocol/src/index.js";
import { resolveCommandAuthorization } from "../../auto-reply/command-auth.js";
import { buildInboundMediaNoteProjection } from "../../auto-reply/media-note.js";
import { emitInboundMessageAuditTerminal } from "../../auto-reply/reply/dispatch-from-config.audit.js";
import { finalizeInboundContext } from "../../auto-reply/reply/inbound-context.js";
import { hasInboundAudio } from "../../auto-reply/reply/inbound-media.js";
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
import type { RuntimeMsgContext } from "../../auto-reply/templating.js";
import type { SessionEntry } from "../../config/sessions.js";
import { isRestartRecoveryTerminalDeliveryFailClosed } from "../../config/sessions/restart-recovery-receipt.js";
import { loadSessionEntry, updateSessionEntry } from "../../config/sessions/session-accessor.js";
import { isDiagnosticsEnabled } from "../../infra/diagnostic-events.js";
import { logMessageProcessed, logMessageReceived } from "../../logging/diagnostic.js";
import type { InboundDocumentContext } from "../../media-understanding/file-context.js";
import { getGlobalHookRunner } from "../../plugins/hook-runner-global.js";
import { recordAcceptedSessionParticipantInput } from "../../sessions/session-participant-input-recording.js";
import { setGatewayDedupeEntry } from "../agent-turn/agent-job.js";
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
  request: Pick<NormalizedChatSendRequest, "p" | "rawMessage" | "supportsTaskSuggestions">;
  session: Pick<
    PreparedChatSendSession,
    "cfg" | "entry" | "sessionKey" | "storePath" | "clientRunId"
  >;
  admittedSessionSettings?: Readonly<Pick<SessionEntry, "permissionMode" | "toolOverrides">>;
  turn: ReturnType<typeof prepareChatSendUserTurn>;
  imageOrder: ReplyBackendQueueMessageOptions["imageOrder"];
  documentContext?: ({ status: "rendered" } & InboundDocumentContext) | { status: "failed" };
  userTurnTranscriptRecorder: NonNullable<
    ReplyBackendQueueMessageOptions["userTurnTranscriptRecorder"]
  >;
  logGateway: GatewayRequestContext["logGateway"];
}) {
  const { p, rawMessage, supportsTaskSuggestions } = params.request;
  const { cfg, entry, sessionKey, storePath, clientRunId } = params.session;
  const { ctx, isInternalTextSlashCommandTurn, replyOptionImages, replyOptionMedia } = params.turn;
  return (): ReplyMessageInjectionAttempt | undefined => {
    if (!params.target || isInternalTextSlashCommandTurn) {
      return undefined;
    }
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
        params.logGateway.warn(
          `failed to reload session entry before steering fence on ${sessionKey}: ${String(error)}`,
        );
        return undefined;
      }
    }
    // Terminal run ids are accumulated session history; compare the fence
    // against the active source-turn identity (carried on the injection target
    // by the owning registry, falling back to the entry's own claim source) so
    // an unrelated earlier tombstone does not force a safe steer into
    // follow-up mode.
    const activeSourceTurnId =
      normalizeOptionalString(params.target?.sourceTurnId) ??
      normalizeOptionalString(fenceEntry?.restartRecoveryDeliverySourceRunId) ??
      "";
    if (
      fenceEntry &&
      isRestartRecoveryTerminalDeliveryFailClosed(
        fenceEntry,
        fenceEntry.sessionId,
        activeSourceTurnId,
      )
    ) {
      params.logGateway.warn(
        `active run ${clientRunId} cannot own another terminal source-reply send on session ${sessionKey}; rejecting steer injection before queueing`,
      );
      return undefined;
    }
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
    const attempt = beginReplyMessageInjectionTarget(
      params.target,
      p.replyToId
        ? buildChatSendReplyInjectionText({ body: text, cfg, ctx, sessionEntry: entry })
        : text,
      {
        steeringMode: "all",
        isInboundUserMessage: true,
        toolAuthorityOverlay: resolveInboundReplyToolAuthorityOverlay({
          ctx,
          sessionEntry: {
            spawnedBy: entry?.spawnedBy,
            permissionMode: params.admittedSessionSettings?.permissionMode,
            toolOverrides: params.admittedSessionSettings?.toolOverrides,
          },
          senderIsOwner: authorization.senderIsOwner,
          disableTools: false,
        }),
        ...(injectionImages?.length ? { images: injectionImages } : {}),
        ...(params.imageOrder?.length ? { imageOrder: params.imageOrder } : {}),
        ...(replyOptionMedia?.length ? { media: replyOptionMedia } : {}),
        waitForTranscriptCommit: true,
        ...(debounceMs !== undefined ? { debounceMs } : {}),
        taskSuggestionDeliveryMode: supportsTaskSuggestions ? "gateway" : undefined,
        userTurnTranscriptRecorder: params.userTurnTranscriptRecorder,
      },
    );
    return attempt;
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

/** Finish an accepted steer without entering reply dispatch, or return false for fallback. */
export async function finalizeAcceptedChatSendMessageInjection(params: {
  attempt: ReplyMessageInjectionAttempt;
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
  // Terminal-receipt admission is fenced at the injection-start boundary
  // (createChatSendMessageInjectionStarter), before the steer is queued, so
  // no attempt ever exists for a fail-closed session. The only rejection
  // left here is the runtime refusing the queued steer, which also means
  // nothing was enqueued — the fallback to follow-up dispatch is safe.
  const finalizedCtx = finalizeInboundContext(ctx);
  const finalization = await finalizeReplyMessageInjectionAttempt({
    attempt: params.attempt,
    target: params.target,
    inboundAudio: hasInboundAudio(finalizedCtx),
  });
  if (finalization.status === "rejected") {
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
  const steerAborted = finalization.status === "accepted" && finalization.aborted;
  const outcomeReason = indeterminate
    ? "question_response_indeterminate"
    : steerAborted
      ? "reply_operation_aborted"
      : "active_run_injected";
  if (steerAborted) {
    context.logGateway.warn(
      `active run ${finalization.targetRunId ?? "unknown"} accepted chat steering without transcript confirmation; aborted exact target without replay`,
    );
  }
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
      outcome: indeterminate ? "error" : steerAborted ? "skipped" : "completed",
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
      : steerAborted
        ? { outcome: "skipped", options: { reason: outcomeReason } }
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
      entry: {
        ts: Date.now(),
        ok: !indeterminate,
        payload: {
          runId: clientRunId,
          status: indeterminate ? "error" : "ok",
          ...(indeterminate ? { summary: indeterminate } : {}),
        },
        ...(indeterminate ? { error: errorShape(ErrorCodes.UNAVAILABLE, indeterminate) } : {}),
      },
    });
    if (indeterminate) {
      broadcastChatError({
        context,
        runId: clientRunId,
        sessionKey,
        agentId,
        errorMessage: indeterminate,
      });
    } else {
      broadcastChatFinal({ context, runId: clientRunId, sessionKey, agentId });
    }
  }
  return true;
}
