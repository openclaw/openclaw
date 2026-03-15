import fs from "node:fs/promises";
import { getAcpSessionManager } from "../../acp/control-plane/manager.js";
import type { AcpTurnAttachment } from "../../acp/control-plane/manager.types.js";
import { resolveAcpAgentPolicyError, resolveAcpDispatchPolicyError } from "../../acp/policy.js";
import { formatAcpRuntimeErrorText } from "../../acp/runtime/error-text.js";
import { toAcpRuntimeError } from "../../acp/runtime/errors.js";
import { resolveAcpThreadSessionDetailLines } from "../../acp/runtime/session-identifiers.js";
import {
  isSessionIdentityPending,
  resolveSessionIdentityFromMeta,
} from "../../acp/runtime/session-identity.js";
import { readAcpSessionEntry } from "../../acp/runtime/session-meta.js";
import type { OpenClawConfig } from "../../config/config.js";
import type { TtsAutoMode } from "../../config/types.tts.js";
import { logVerbose } from "../../globals.js";
import { getSessionBindingService } from "../../infra/outbound/session-binding-service.js";
import { generateSecureUuid } from "../../infra/secure-random.js";
import { prefixSystemMessage } from "../../infra/system-message.js";
import { applyMediaUnderstanding } from "../../media-understanding/apply.js";
import {
  normalizeAttachmentPath,
  normalizeAttachments,
} from "../../media-understanding/attachments.normalize.js";
import { resolveAgentIdFromSessionKey } from "../../routing/session-key.js";
import { maybeApplyTtsToPayload, resolveTtsConfig } from "../../tts/tts.js";
import {
  isCommandEnabled,
  maybeResolveTextAlias,
  shouldHandleTextCommands,
} from "../commands-registry.js";
import type { FinalizedMsgContext } from "../templating.js";
import { createAcpReplyProjector } from "./acp-projector.js";
import { createAcpDispatchDeliveryCoordinator } from "./dispatch-acp-delivery.js";
import type { ReplyDispatcher, ReplyDispatchKind } from "./reply-dispatcher.js";

type DispatchProcessedRecorder = (
  outcome: "completed" | "skipped" | "error",
  opts?: {
    reason?: string;
    error?: string;
  },
) => void;

function resolveFirstContextText(
  ctx: FinalizedMsgContext,
  keys: Array<"BodyForAgent" | "BodyForCommands" | "CommandBody" | "RawBody" | "Body">,
): string {
  for (const key of keys) {
    const value = ctx[key];
    if (typeof value === "string") {
      return value;
    }
  }
  return "";
}

function resolveAcpPromptText(ctx: FinalizedMsgContext): string {
  return resolveFirstContextText(ctx, [
    "BodyForAgent",
    "BodyForCommands",
    "CommandBody",
    "RawBody",
    "Body",
  ]).trim();
}

const ACP_ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024;

async function resolveAcpAttachments(ctx: FinalizedMsgContext): Promise<AcpTurnAttachment[]> {
  const mediaAttachments = normalizeAttachments(ctx);
  const results: AcpTurnAttachment[] = [];
  for (const attachment of mediaAttachments) {
    const mediaType = attachment.mime ?? "application/octet-stream";
    if (!mediaType.startsWith("image/")) {
      continue;
    }
    const filePath = normalizeAttachmentPath(attachment.path);
    if (!filePath) {
      continue;
    }
    try {
      const stat = await fs.stat(filePath);
      if (stat.size > ACP_ATTACHMENT_MAX_BYTES) {
        logVerbose(
          `dispatch-acp: skipping attachment ${filePath} (${stat.size} bytes exceeds ${ACP_ATTACHMENT_MAX_BYTES} byte limit)`,
        );
        continue;
      }
      const buf = await fs.readFile(filePath);
      results.push({
        mediaType,
        data: buf.toString("base64"),
      });
    } catch {
      // Skip unreadable files. Text content should still be delivered.
    }
  }
  return results;
}

function resolveCommandCandidateText(ctx: FinalizedMsgContext): string {
  return resolveFirstContextText(ctx, ["CommandBody", "BodyForCommands", "RawBody", "Body"]).trim();
}

export function shouldBypassAcpDispatchForCommand(
  ctx: FinalizedMsgContext,
  cfg: OpenClawConfig,
): boolean {
  const candidate = resolveCommandCandidateText(ctx);
  if (!candidate) {
    return false;
  }
  const allowTextCommands = shouldHandleTextCommands({
    cfg,
    surface: ctx.Surface ?? ctx.Provider ?? "",
    commandSource: ctx.CommandSource,
  });
  if (maybeResolveTextAlias(candidate, cfg) != null) {
    return allowTextCommands;
  }

  const normalized = candidate.trim();
  if (!normalized.startsWith("!")) {
    return false;
  }

  if (!ctx.CommandAuthorized) {
    return false;
  }

  if (!isCommandEnabled(cfg, "bash")) {
    return false;
  }

  return allowTextCommands;
}

function resolveAcpRequestId(ctx: FinalizedMsgContext): string {
  const id = ctx.MessageSidFull ?? ctx.MessageSid ?? ctx.MessageSidFirst ?? ctx.MessageSidLast;
  if (typeof id === "string" && id.trim()) {
    return id.trim();
  }
  if (typeof id === "number" || typeof id === "bigint") {
    return String(id);
  }
  return generateSecureUuid();
}

function hasBoundConversationForSession(params: {
  sessionKey: string;
  channelRaw: string | undefined;
  accountIdRaw: string | undefined;
}): boolean {
  const channel = String(params.channelRaw ?? "")
    .trim()
    .toLowerCase();
  if (!channel) {
    return false;
  }
  const accountId = String(params.accountIdRaw ?? "")
    .trim()
    .toLowerCase();
  const normalizedAccountId = accountId || "default";
  const bindingService = getSessionBindingService();
  const bindings = bindingService.listBySession(params.sessionKey);
  return bindings.some((binding) => {
    const bindingChannel = String(binding.conversation.channel ?? "")
      .trim()
      .toLowerCase();
    const bindingAccountId = String(binding.conversation.accountId ?? "")
      .trim()
      .toLowerCase();
    const conversationId = String(binding.conversation.conversationId ?? "").trim();
    return (
      bindingChannel === channel &&
      (bindingAccountId || "default") === normalizedAccountId &&
      conversationId.length > 0
    );
  });
}

export type AcpDispatchAttemptResult = {
  queuedFinal: boolean;
  counts: Record<ReplyDispatchKind, number>;
};

export async function tryDispatchAcpReply(params: {
  ctx: FinalizedMsgContext;
  cfg: OpenClawConfig;
  dispatcher: ReplyDispatcher;
  sessionKey?: string;
  inboundAudio: boolean;
  sessionTtsAuto?: TtsAutoMode;
  ttsChannel?: string;
  shouldRouteToOriginating: boolean;
  originatingChannel?: string;
  originatingTo?: string;
  shouldSendToolSummaries: boolean;
  bypassForCommand: boolean;
  onReplyStart?: () => Promise<void> | void;
  recordProcessed: DispatchProcessedRecorder;
  markIdle: (reason: string) => void;
}): Promise<AcpDispatchAttemptResult | null> {
  const sessionKey = params.sessionKey?.trim();
  if (!sessionKey || params.bypassForCommand) {
    return null;
  }

  const acpManager = getAcpSessionManager();
  const acpResolution = acpManager.resolveSession({
    cfg: params.cfg,
    sessionKey,
  });
  if (acpResolution.kind === "none") {
    return null;
  }

  let queuedFinal = false;
  const delivery = createAcpDispatchDeliveryCoordinator({
    cfg: params.cfg,
    ctx: params.ctx,
    dispatcher: params.dispatcher,
    inboundAudio: params.inboundAudio,
    sessionTtsAuto: params.sessionTtsAuto,
    ttsChannel: params.ttsChannel,
    shouldRouteToOriginating: params.shouldRouteToOriginating,
    originatingChannel: params.originatingChannel,
    originatingTo: params.originatingTo,
    onReplyStart: params.onReplyStart,
  });

  const identityPendingBeforeTurn = isSessionIdentityPending(
    resolveSessionIdentityFromMeta(acpResolution.kind === "ready" ? acpResolution.meta : undefined),
  );
  const shouldEmitResolvedIdentityNotice =
    identityPendingBeforeTurn &&
    (Boolean(params.ctx.MessageThreadId != null && String(params.ctx.MessageThreadId).trim()) ||
      hasBoundConversationForSession({
        sessionKey,
        channelRaw: params.ctx.OriginatingChannel ?? params.ctx.Surface ?? params.ctx.Provider,
        accountIdRaw: params.ctx.AccountId,
      }));

  const resolvedAcpAgent =
    acpResolution.kind === "ready"
      ? (
          acpResolution.meta.agent?.trim() ||
          params.cfg.acp?.defaultAgent?.trim() ||
          resolveAgentIdFromSessionKey(sessionKey)
        ).trim()
      : resolveAgentIdFromSessionKey(sessionKey);
  const projector = createAcpReplyProjector({
    cfg: params.cfg,
    shouldSendToolSummaries: params.shouldSendToolSummaries,
    deliver: delivery.deliver,
    provider: params.ctx.Surface ?? params.ctx.Provider,
    accountId: params.ctx.AccountId,
  });

  const acpDispatchStartedAt = Date.now();
  try {
    const dispatchPolicyError = resolveAcpDispatchPolicyError(params.cfg);
    if (dispatchPolicyError) {
      throw dispatchPolicyError;
    }
    if (acpResolution.kind === "stale") {
      throw acpResolution.error;
    }
    const agentPolicyError = resolveAcpAgentPolicyError(params.cfg, resolvedAcpAgent);
    if (agentPolicyError) {
      throw agentPolicyError;
    }
    if (!params.ctx.MediaUnderstanding?.length) {
      try {
        await applyMediaUnderstanding({
          ctx: params.ctx,
          cfg: params.cfg,
        });
      } catch (err) {
        logVerbose(
          `dispatch-acp: media understanding failed, proceeding with raw content: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    const promptText = resolveAcpPromptText(params.ctx);
    const attachments = await resolveAcpAttachments(params.ctx);
    if (!promptText && attachments.length === 0) {
      const counts = params.dispatcher.getQueuedCounts();
      delivery.applyRoutedCounts(counts);
      params.recordProcessed("completed", { reason: "acp_empty_prompt" });
      params.markIdle("message_completed");
      return { queuedFinal: false, counts };
    }

    try {
      await delivery.startReplyLifecycle();
    } catch (error) {
      logVerbose(
        `dispatch-acp: start reply lifecycle failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    await acpManager.runTurn({
      cfg: params.cfg,
      sessionKey,
      text: promptText,
      attachments: attachments.length > 0 ? attachments : undefined,
      mode: "prompt",
      requestId: resolveAcpRequestId(params.ctx),
      onEvent: async (event) => await projector.onEvent(event),
    });

    await projector.flush(true);
    const ttsMode = resolveTtsConfig(params.cfg).mode ?? "final";
    const accumulatedBlockText = delivery.getAccumulatedBlockText();
    const routedCounts = delivery.getRoutedCounts();
    const blockCount = delivery.getBlockCount();
    // Skip fallback if blocks were already delivered (normal final_only flow).
    // This prevents duplicate delivery in the common case where projector
    // already sent accumulated text as blocks during flush(true) on done.
    const hasAlreadyDelivered = blockCount > 0 || routedCounts.final > 0;
    // Skip fallback for ttsMode="all" because blocks were already processed with TTS.
    const shouldSkipFallback = hasAlreadyDelivered || ttsMode === "all";
    if (!shouldSkipFallback && accumulatedBlockText.trim()) {
      // Only attempt final TTS synthesis for ttsMode="final".
      // For other modes, skip directly to text fallback to avoid double TTS calls.
      if (ttsMode === "final") {
        try {
          const ttsSyntheticReply = await maybeApplyTtsToPayload({
            payload: { text: accumulatedBlockText },
            cfg: params.cfg,
            channel: params.ttsChannel,
            kind: "final",
            inboundAudio: params.inboundAudio,
            ttsAuto: params.sessionTtsAuto,
          });
          if (ttsSyntheticReply.mediaUrl) {
            // Use dispatcher directly to avoid re-entering delivery.deliver
            // which would call maybeApplyTtsToPayload again.
            const delivered = params.dispatcher.sendFinalReply({
              mediaUrl: ttsSyntheticReply.mediaUrl,
              audioAsVoice: ttsSyntheticReply.audioAsVoice,
            });
            queuedFinal = queuedFinal || delivered;
            return; // TTS succeeded, no need for text fallback
          }
        } catch (err) {
          logVerbose(
            `dispatch-acp: accumulated ACP block TTS failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
      // Fallback to text-only delivery (no TTS).
      // Use dispatcher directly to avoid double TTS synthesis.
      const delivered = params.dispatcher.sendFinalReply({ text: accumulatedBlockText });
      queuedFinal = queuedFinal || delivered;
    }

    if (shouldEmitResolvedIdentityNotice) {
      const currentMeta = readAcpSessionEntry({
        cfg: params.cfg,
        sessionKey,
      })?.acp;
      const identityAfterTurn = resolveSessionIdentityFromMeta(currentMeta);
      if (!isSessionIdentityPending(identityAfterTurn)) {
        const resolvedDetails = resolveAcpThreadSessionDetailLines({
          sessionKey,
          meta: currentMeta,
        });
        if (resolvedDetails.length > 0) {
          const delivered = await delivery.deliver("final", {
            text: prefixSystemMessage(["Session ids resolved.", ...resolvedDetails].join("\n")),
          });
          queuedFinal = queuedFinal || delivered;
        }
      }
    }

    const counts = params.dispatcher.getQueuedCounts();
    delivery.applyRoutedCounts(counts);
    const acpStats = acpManager.getObservabilitySnapshot(params.cfg);
    logVerbose(
      `acp-dispatch: session=${sessionKey} outcome=ok latencyMs=${Date.now() - acpDispatchStartedAt} queueDepth=${acpStats.turns.queueDepth} activeRuntimes=${acpStats.runtimeCache.activeSessions}`,
    );
    params.recordProcessed("completed", { reason: "acp_dispatch" });
    params.markIdle("message_completed");
    return { queuedFinal, counts };
  } catch (err) {
    await projector.flush(true);
    const acpError = toAcpRuntimeError({
      error: err,
      fallbackCode: "ACP_TURN_FAILED",
      fallbackMessage: "ACP turn failed before completion.",
    });
    const delivered = await delivery.deliver("final", {
      text: formatAcpRuntimeErrorText(acpError),
      isError: true,
    });
    queuedFinal = queuedFinal || delivered;
    const counts = params.dispatcher.getQueuedCounts();
    delivery.applyRoutedCounts(counts);
    const acpStats = acpManager.getObservabilitySnapshot(params.cfg);
    logVerbose(
      `acp-dispatch: session=${sessionKey} outcome=error code=${acpError.code} latencyMs=${Date.now() - acpDispatchStartedAt} queueDepth=${acpStats.turns.queueDepth} activeRuntimes=${acpStats.runtimeCache.activeSessions}`,
    );
    params.recordProcessed("completed", {
      reason: `acp_error:${acpError.code.toLowerCase()}`,
    });
    params.markIdle("message_completed");
    return { queuedFinal, counts };
  }
}
