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
import { emitAgentEvent } from "../../infra/agent-events.js";
import { getSessionBindingService } from "../../infra/outbound/session-binding-service.js";
import { generateSecureUuid } from "../../infra/secure-random.js";
import { prefixSystemMessage } from "../../infra/system-message.js";
import { applyMediaUnderstanding } from "../../media-understanding/apply.js";
import {
  normalizeAttachmentPath,
  normalizeAttachments,
} from "../../media-understanding/attachments.normalize.js";
import { isInboundPathAllowed } from "../../media/inbound-path-policy.js";
import { resolveMediaAttachmentLocalRoots } from "../../media-understanding/runner.js";
import { getGlobalHookRunner } from "../../plugins/hook-runner-global.js";
import type { PluginHookAgentContext } from "../../plugins/types.js";
import { resolveAgentIdFromSessionKey } from "../../routing/session-key.js";
import { maybeApplyTtsToPayload, resolveTtsConfig } from "../../tts/tts.js";
import {
  isCommandEnabled,
  maybeResolveTextAlias,
  shouldHandleTextCommands,
} from "../commands-registry.js";
import type { FinalizedMsgContext } from "../templating.js";
import { createAcpReplyProjector } from "./acp-projector.js";
import {
  createAcpDispatchDeliveryCoordinator,
  type AcpDispatchDeliveryCoordinator,
} from "./dispatch-acp-delivery.js";
import { buildInboundUserContextPrefix } from "./inbound-meta.js";
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

function buildAcpPromptText(ctx: FinalizedMsgContext): string {
  const bodyText = resolveFirstContextText(ctx, [
    "BodyForAgent",
    "BodyForCommands",
    "CommandBody",
    "RawBody",
    "Body",
  ]).trim();
  // Prepend group chat history (non-mentioned messages stored for context)
  // so the ACP session sees the same conversation window as the embedded path.
  // Strip ThreadStarterBody: ACP sessions are long-lived and manage their own
  // context window, so repeating the thread starter on every turn creates noise.
  const inboundContext = buildInboundUserContextPrefix({
    ...ctx,
    ThreadStarterBody: undefined,
  }).trim();
  return [inboundContext, bodyText].filter(Boolean).join("\n\n");
}

function buildAcpHookContext(params: {
  ctx: FinalizedMsgContext;
  sessionKey: string;
  agentId: string;
}): PluginHookAgentContext {
  return {
    runId: generateSecureUuid(),
    agentId: params.agentId,
    sessionKey: params.sessionKey,
    messageProvider: params.ctx.Surface ?? params.ctx.Provider ?? undefined,
    trigger: "user",
    channelId: params.ctx.Surface ?? params.ctx.Provider ?? undefined,
  };
}

const ACP_ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024;

async function resolveAcpAttachments(
  ctx: FinalizedMsgContext,
  cfg: OpenClawConfig,
): Promise<AcpTurnAttachment[]> {
  const results: AcpTurnAttachment[] = [];
  // Build allowed inbound roots from channel config + defaults, including
  // iMessage-specific roots (~/Library/Messages/Attachments) so attachments
  // from all channels are accepted.
  const allowedRoots = resolveMediaAttachmentLocalRoots({ cfg, ctx });

  async function tryAddImageFile(filePath: string, mediaType: string): Promise<void> {
    if (!mediaType.startsWith("image/")) {
      return;
    }
    // Validate path against allowed inbound roots before reading from disk.
    if (!isInboundPathAllowed({ filePath, roots: allowedRoots })) {
      logVerbose(`dispatch-acp: skipping attachment outside allowed roots: ${filePath}`);
      return;
    }
    try {
      // Use lstat to detect symlinks and reject non-regular files (devices,
      // FIFOs, sockets) that could hang fs.readFile or produce unbounded data.
      const lstat = await fs.lstat(filePath);
      if (lstat.isSymbolicLink()) {
        logVerbose(`dispatch-acp: skipping symlink attachment: ${filePath}`);
        return;
      }
      if (!lstat.isFile()) {
        logVerbose(`dispatch-acp: skipping non-regular file attachment: ${filePath}`);
        return;
      }
      if (lstat.size > ACP_ATTACHMENT_MAX_BYTES) {
        logVerbose(
          `dispatch-acp: skipping attachment ${filePath} (${lstat.size} bytes exceeds ${ACP_ATTACHMENT_MAX_BYTES} byte limit)`,
        );
        return;
      }
      const buf = await fs.readFile(filePath);
      // Double-check actual bytes read against limit (defense-in-depth).
      if (buf.length > ACP_ATTACHMENT_MAX_BYTES) {
        return;
      }
      results.push({ mediaType, data: buf.toString("base64") });
    } catch {
      // Skip unreadable files. Text content should still be delivered.
    }
  }

  // Current message attachments
  const mediaAttachments = normalizeAttachments(ctx);
  for (const attachment of mediaAttachments) {
    const mediaType = attachment.mime ?? "application/octet-stream";
    const filePath = normalizeAttachmentPath(attachment.path);
    if (filePath) {
      await tryAddImageFile(filePath, mediaType);
    }
  }

  // Group history images — include downloaded media from recent history entries so the
  // ACP session can see images shared by other participants before the trigger message.
  if (Array.isArray(ctx.InboundHistory)) {
    for (const entry of ctx.InboundHistory) {
      const filePath = normalizeAttachmentPath(entry.mediaPath);
      if (filePath && entry.mediaType) {
        await tryAddImageFile(filePath, entry.mediaType);
      }
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

async function finalizeAcpTurnOutput(params: {
  cfg: OpenClawConfig;
  sessionKey: string;
  delivery: AcpDispatchDeliveryCoordinator;
  inboundAudio: boolean;
  sessionTtsAuto?: TtsAutoMode;
  ttsChannel?: string;
  shouldEmitResolvedIdentityNotice: boolean;
}): Promise<boolean> {
  await params.delivery.settleVisibleText();
  let queuedFinal =
    params.delivery.hasDeliveredVisibleText() && !params.delivery.hasFailedVisibleTextDelivery();
  const ttsMode = resolveTtsConfig(params.cfg).mode ?? "final";
  const accumulatedBlockText = params.delivery.getAccumulatedBlockText();
  const hasAccumulatedBlockText = accumulatedBlockText.trim().length > 0;

  let finalMediaDelivered = false;
  if (ttsMode === "final" && hasAccumulatedBlockText) {
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
        const delivered = await params.delivery.deliver("final", {
          mediaUrl: ttsSyntheticReply.mediaUrl,
          audioAsVoice: ttsSyntheticReply.audioAsVoice,
        });
        queuedFinal = queuedFinal || delivered;
        finalMediaDelivered = delivered;
      }
    } catch (err) {
      logVerbose(
        `dispatch-acp: accumulated ACP block TTS failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // Some ACP parent surfaces only expose terminal replies, so block routing alone is not enough
  // to prove the final result was visible to the user.
  const shouldDeliverTextFallback =
    ttsMode !== "all" &&
    hasAccumulatedBlockText &&
    !finalMediaDelivered &&
    !params.delivery.hasDeliveredFinalReply() &&
    (!params.delivery.hasDeliveredVisibleText() || params.delivery.hasFailedVisibleTextDelivery());
  if (shouldDeliverTextFallback) {
    const delivered = await params.delivery.deliver(
      "final",
      { text: accumulatedBlockText },
      { skipTts: true },
    );
    queuedFinal = queuedFinal || delivered;
  }

  if (params.shouldEmitResolvedIdentityNotice) {
    const currentMeta = readAcpSessionEntry({
      cfg: params.cfg,
      sessionKey: params.sessionKey,
    })?.acp;
    const identityAfterTurn = resolveSessionIdentityFromMeta(currentMeta);
    if (!isSessionIdentityPending(identityAfterTurn)) {
      const resolvedDetails = resolveAcpThreadSessionDetailLines({
        sessionKey: params.sessionKey,
        meta: currentMeta,
      });
      if (resolvedDetails.length > 0) {
        const delivered = await params.delivery.deliver("final", {
          text: prefixSystemMessage(["Session ids resolved.", ...resolvedDetails].join("\n")),
        });
        queuedFinal = queuedFinal || delivered;
      }
    }
  }

  return queuedFinal;
}

export async function tryDispatchAcpReply(params: {
  ctx: FinalizedMsgContext;
  cfg: OpenClawConfig;
  dispatcher: ReplyDispatcher;
  runId?: string;
  sessionKey?: string;
  abortSignal?: AbortSignal;
  inboundAudio: boolean;
  sessionTtsAuto?: TtsAutoMode;
  ttsChannel?: string;
  suppressUserDelivery?: boolean;
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
    suppressUserDelivery: params.suppressUserDelivery,
    shouldRouteToOriginating: params.shouldRouteToOriginating,
    originatingChannel: params.originatingChannel,
    originatingTo: params.originatingTo,
    onReplyStart: params.onReplyStart,
  });

  const identityPendingBeforeTurn = isSessionIdentityPending(
    resolveSessionIdentityFromMeta(acpResolution.kind === "ready" ? acpResolution.meta : undefined),
  );
  const shouldEmitResolvedIdentityNotice =
    !params.suppressUserDelivery &&
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
  const hookRunner = getGlobalHookRunner();
  const hookCtx = buildAcpHookContext({
    ctx: params.ctx,
    sessionKey,
    agentId: resolvedAcpAgent,
  });
  let promptText = "";
  try {
    const dispatchPolicyError = resolveAcpDispatchPolicyError(params.cfg);
    if (dispatchPolicyError) {
      throw dispatchPolicyError;
    }
    if (acpResolution.kind === "stale") {
      // Unbind dead target session so conversations stop routing to it.
      const bindingService = getSessionBindingService();
      try {
        await bindingService.unbind({
          targetSessionKey: sessionKey,
          reason: "stale_acp_session",
        });
      } catch (unbindErr) {
        logVerbose(
          `dispatch-acp: failed to unbind stale session ${sessionKey}: ${unbindErr instanceof Error ? unbindErr.message : String(unbindErr)}`,
        );
      }
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

    promptText = buildAcpPromptText(params.ctx);
    const attachments = await resolveAcpAttachments(params.ctx, params.cfg);
    if (!promptText && attachments.length === 0) {
      const counts = params.dispatcher.getQueuedCounts();
      delivery.applyRoutedCounts(counts);
      params.recordProcessed("completed", { reason: "acp_empty_prompt" });
      params.markIdle("message_completed");
      return { queuedFinal: false, counts };
    }

    // Run before_prompt_build / before_agent_start hooks for memory auto-recall.
    // memory-lancedb-pro uses before_prompt_build; legacy memory-lancedb uses before_agent_start.
    if (hookRunner?.hasHooks("before_prompt_build")) {
      try {
        // ACP session history is managed internally by acpManager and is not
        // available at prompt-build time, so messages is always empty here.
        const hookResult = await hookRunner.runBeforePromptBuild(
          { prompt: promptText, messages: [] },
          hookCtx,
        );
        if (hookResult?.prependContext) {
          promptText = `${hookResult.prependContext}\n\n${promptText}`;
        }
      } catch (hookErr) {
        logVerbose(
          `dispatch-acp: before_prompt_build hook failed: ${hookErr instanceof Error ? hookErr.message : String(hookErr)}`,
        );
      }
    } else if (hookRunner?.hasHooks("before_agent_start")) {
      try {
        const hookResult = await hookRunner.runBeforeAgentStart({ prompt: promptText }, hookCtx);
        if (hookResult?.prependContext) {
          promptText = `${hookResult.prependContext}\n\n${promptText}`;
        }
      } catch (hookErr) {
        logVerbose(
          `dispatch-acp: before_agent_start hook failed: ${hookErr instanceof Error ? hookErr.message : String(hookErr)}`,
        );
      }
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
      ...(params.abortSignal ? { signal: params.abortSignal } : {}),
      onEvent: async (event) => await projector.onEvent(event),
    });

    await projector.flush(true);
    queuedFinal =
      (await finalizeAcpTurnOutput({
        cfg: params.cfg,
        sessionKey,
        delivery,
        inboundAudio: params.inboundAudio,
        sessionTtsAuto: params.sessionTtsAuto,
        ttsChannel: params.ttsChannel,
        shouldEmitResolvedIdentityNotice,
      })) || queuedFinal;

    // Run agent_end hooks (fire-and-forget, e.g. memory-lancedb auto-capture)
    if (hookRunner?.hasHooks("agent_end")) {
      const responseText = delivery.getAccumulatedBlockText();
      hookRunner
        .runAgentEnd(
          {
            messages: [
              { role: "user", content: promptText },
              ...(responseText.trim() ? [{ role: "assistant", content: responseText }] : []),
            ],
            success: true,
            durationMs: Date.now() - acpDispatchStartedAt,
          },
          hookCtx,
        )
        .catch((hookErr) => {
          logVerbose(
            `dispatch-acp: agent_end hook failed: ${hookErr instanceof Error ? hookErr.message : String(hookErr)}`,
          );
        });
    }

    const counts = params.dispatcher.getQueuedCounts();
    delivery.applyRoutedCounts(counts);
    const acpStats = acpManager.getObservabilitySnapshot(params.cfg);
    if (params.runId?.trim()) {
      emitAgentEvent({
        runId: params.runId.trim(),
        sessionKey,
        stream: "lifecycle",
        data: {
          phase: "end",
          startedAt: acpDispatchStartedAt,
          endedAt: Date.now(),
        },
      });
    }
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

    // Unbind dead ACP session on init/runtime failures so conversations don't
    // keep routing to a broken session on subsequent messages.
    if (acpError.code === "ACP_SESSION_INIT_FAILED" || acpError.code === "ACP_TURN_FAILED") {
      try {
        const bindingService = getSessionBindingService();
        await bindingService.unbind({
          targetSessionKey: sessionKey,
          reason: `acp_error_${acpError.code}`,
        });
      } catch {
        // Best-effort cleanup; don't mask the original error.
      }
    }

    // Run agent_end hooks on error path too (fire-and-forget)
    if (hookRunner?.hasHooks("agent_end")) {
      hookRunner
        .runAgentEnd(
          {
            messages: [{ role: "user", content: promptText }],
            success: false,
            error: acpError.message,
            durationMs: Date.now() - acpDispatchStartedAt,
          },
          hookCtx,
        )
        .catch((hookErr) => {
          logVerbose(
            `dispatch-acp: agent_end hook failed: ${hookErr instanceof Error ? hookErr.message : String(hookErr)}`,
          );
        });
    }

    const counts = params.dispatcher.getQueuedCounts();
    delivery.applyRoutedCounts(counts);
    const acpStats = acpManager.getObservabilitySnapshot(params.cfg);
    if (params.runId?.trim()) {
      emitAgentEvent({
        runId: params.runId.trim(),
        sessionKey,
        stream: "lifecycle",
        data: {
          phase: "error",
          startedAt: acpDispatchStartedAt,
          endedAt: Date.now(),
          error: acpError.message,
        },
      });
    }
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
