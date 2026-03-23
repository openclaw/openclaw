import crypto from "node:crypto";
import {
  hasOutboundReplyContent,
  resolveSendableOutboundReplyParts,
} from "openclaw/plugin-sdk/reply-payload";
import { resolveRunModelFallbacksOverride } from "../../agents/agent-scope.js";
import { resolveBootstrapWarningSignaturesSeen } from "../../agents/bootstrap-budget.js";
import { lookupCachedContextTokens } from "../../agents/context-cache.js";
import { DEFAULT_CONTEXT_TOKENS } from "../../agents/defaults.js";
import { runWithModelFallback } from "../../agents/model-fallback.js";
import type { SessionEntry } from "../../config/sessions.js";
import type { TypingMode } from "../../config/types.js";
import { logVerbose } from "../../globals.js";
import { registerAgentRunContext } from "../../infra/agent-events.js";
import { defaultRuntime } from "../../runtime.js";
import { isInternalMessageChannel } from "../../utils/message-channel.js";
import { stripHeartbeatToken } from "../heartbeat.js";
import type { OriginatingChannelType } from "../templating.js";
import { isSilentReplyText, SILENT_REPLY_TOKEN } from "../tokens.js";
import type { GetReplyOptions, ReplyPayload } from "../types.js";
import { resolveRunAuthProfile } from "./agent-runner-utils.js";
import {
  resolveOriginAccountId,
  resolveOriginMessageProvider,
  resolveOriginMessageTo,
} from "./origin-routing.js";
import type { FollowupRun } from "./queue.js";
import { resolveReplyToMode } from "./reply-threading.js";
import { incrementRunCompactionCount, persistRunSessionUsage } from "./session-run-accounting.js";
import { createTypingSignaler } from "./typing-mode.js";
import type { TypingController } from "./typing.js";

let piEmbeddedRuntimePromise: Promise<typeof import("../../agents/pi-embedded.runtime.js")> | null =
  null;
let routeReplyRuntimePromise: Promise<typeof import("./route-reply.runtime.js")> | null = null;
let replyPayloadsRuntimePromise: Promise<typeof import("./reply-payloads.runtime.js")> | null =
  null;
let contextTokensRuntimePromise: Promise<
  typeof import("../../agents/context-tokens.runtime.js")
> | null = null;

function loadPiEmbeddedRuntime() {
  piEmbeddedRuntimePromise ??= import("../../agents/pi-embedded.runtime.js");
  return piEmbeddedRuntimePromise;
}

function loadRouteReplyRuntime() {
  routeReplyRuntimePromise ??= import("./route-reply.runtime.js");
  return routeReplyRuntimePromise;
}

function loadReplyPayloadsRuntime() {
  replyPayloadsRuntimePromise ??= import("./reply-payloads.runtime.js");
  return replyPayloadsRuntimePromise;
}

function loadContextTokensRuntime() {
  contextTokensRuntimePromise ??= import("../../agents/context-tokens.runtime.js");
  return contextTokensRuntimePromise;
}
export function createFollowupRunner(params: {
  opts?: GetReplyOptions;
  typing: TypingController;
  typingMode: TypingMode;
  sessionEntry?: SessionEntry;
  sessionStore?: Record<string, SessionEntry>;
  sessionKey?: string;
  storePath?: string;
  defaultModel: string;
  agentCfgContextTokens?: number;
}): (queued: FollowupRun) => Promise<void> {
  const {
    opts,
    typing,
    typingMode,
    sessionEntry,
    sessionStore,
    sessionKey,
    storePath,
    defaultModel,
    agentCfgContextTokens,
  } = params;
  const typingSignals = createTypingSignaler({
    typing,
    mode: typingMode,
    isHeartbeat: opts?.isHeartbeat === true,
  });

  /**
   * Sends followup payloads, routing to the originating channel if set.
   *
   * When originatingChannel/originatingTo are set on the queued run,
   * replies are routed directly to that provider instead of using the
   * session's current dispatcher. This ensures replies go back to
   * where the message originated.
   */
  const sendFollowupPayloads = async (payloads: ReplyPayload[], queued: FollowupRun) => {
    // Check if we should route to originating channel.
    const { originatingChannel, originatingTo } = queued;
    const { isRoutableChannel, routeReply } = await loadRouteReplyRuntime();
    const shouldRouteToOriginating = isRoutableChannel(originatingChannel) && originatingTo;

    if (!shouldRouteToOriginating && !opts?.onBlockReply) {
      logVerbose("followup queue: no onBlockReply handler; dropping payloads");
      return;
    }

    for (const payload of payloads) {
      if (!payload || !hasOutboundReplyContent(payload)) {
        continue;
      }
      if (
        isSilentReplyText(payload.text, SILENT_REPLY_TOKEN) &&
        !resolveSendableOutboundReplyParts(payload).hasMedia
      ) {
        continue;
      }
      await typingSignals.signalTextDelta(payload.text);

      // Route to originating channel if set, otherwise fall back to dispatcher.
      if (shouldRouteToOriginating) {
        const result = await routeReply({
          payload,
          channel: originatingChannel,
          to: originatingTo,
          sessionKey: queued.run.sessionKey,
          accountId: queued.originatingAccountId,
          threadId: queued.originatingThreadId,
          cfg: queued.run.config,
        });
        if (!result.ok) {
          const errorMsg = result.error ?? "unknown error";
          logVerbose(`followup queue: route-reply failed: ${errorMsg}`);
          // Fall back to the caller-provided dispatcher only when the
          // originating channel matches the session's message provider.
          // In that case onBlockReply was created by the same channel's
          // handler and delivers to the correct destination.  For true
          // cross-channel routing (origin !== provider), falling back
          // would send to the wrong channel, so we drop the payload.
          const provider = resolveOriginMessageProvider({
            provider: queued.run.messageProvider,
          });
          const origin = resolveOriginMessageProvider({
            originatingChannel,
          });
          if (opts?.onBlockReply && origin && origin === provider) {
            await opts.onBlockReply(payload);
          }
        }
      } else if (opts?.onBlockReply) {
        await opts.onBlockReply(payload);
      }
    }
  };

  return async (queued: FollowupRun) => {
    try {
      const runId = crypto.randomUUID();
      const shouldSurfaceToControlUi = isInternalMessageChannel(
        resolveOriginMessageProvider({
          originatingChannel: queued.originatingChannel,
          provider: queued.run.messageProvider,
        }),
      );
      if (queued.run.sessionKey) {
        registerAgentRunContext(runId, {
          sessionKey: queued.run.sessionKey,
          verboseLevel: queued.run.verboseLevel,
          isControlUiVisible: shouldSurfaceToControlUi,
        });
      }
      const replyToChannel = resolveOriginMessageProvider({
        originatingChannel: queued.originatingChannel,
        provider: queued.run.messageProvider,
      }) as OriginatingChannelType | undefined;
      const replyToMode = resolveReplyToMode(
        queued.run.config,
        replyToChannel,
        queued.originatingAccountId,
        queued.originatingChatType,
      );
      const currentMessageId = queued.messageId?.trim() || undefined;
      const applyFollowupReplyThreading = async (payloads: ReplyPayload[]) => {
        const { applyReplyThreading } = await loadReplyPayloadsRuntime();
        return applyReplyThreading({
          payloads,
          replyToMode,
          replyToChannel,
          currentMessageId,
        });
      };
      const sendCompactionNotice = async (text: string) => {
        try {
          const noticePayloads = await applyFollowupReplyThreading([
            {
              text,
              replyToCurrent: true,
              isCompactionNotice: true,
            },
          ]);
          if (noticePayloads.length === 0) {
            return;
          }
          await sendFollowupPayloads(noticePayloads, queued);
        } catch (err) {
          logVerbose(`followup queue: compaction notice failed (non-fatal): ${String(err)}`);
        }
      };
      let autoCompactionCount = 0;
      let runResult: Awaited<
        ReturnType<typeof import("../../agents/pi-embedded.runtime.js").runEmbeddedPiAgent>
      >;
      let fallbackProvider = queued.run.provider;
      let fallbackModel = queued.run.model;
      const activeSessionEntry =
        (sessionKey ? sessionStore?.[sessionKey] : undefined) ?? sessionEntry;
      let bootstrapPromptWarningSignaturesSeen = resolveBootstrapWarningSignaturesSeen(
        activeSessionEntry?.systemPromptReport,
      );
      try {
        const fallbackResult = await runWithModelFallback({
          cfg: queued.run.config,
          provider: queued.run.provider,
          model: queued.run.model,
          runId,
          agentDir: queued.run.agentDir,
          fallbacksOverride: resolveRunModelFallbacksOverride({
            cfg: queued.run.config,
            agentId: queued.run.agentId,
            sessionKey: queued.run.sessionKey,
          }),
          run: async (provider, model, runOptions) => {
            const authProfile = resolveRunAuthProfile(queued.run, provider);
            let attemptCompactionCount = 0;
            try {
              const { runEmbeddedPiAgent } = await loadPiEmbeddedRuntime();
              const result = await runEmbeddedPiAgent({
                allowGatewaySubagentBinding: true,
                sessionId: queued.run.sessionId,
                sessionKey: queued.run.sessionKey,
                agentId: queued.run.agentId,
                trigger: "user",
                messageChannel: queued.originatingChannel ?? undefined,
                messageProvider: queued.run.messageProvider,
                agentAccountId: queued.run.agentAccountId,
                messageTo: queued.originatingTo,
                messageThreadId: queued.originatingThreadId,
                currentChannelId: queued.originatingTo,
                currentThreadTs:
                  queued.originatingThreadId != null
                    ? String(queued.originatingThreadId)
                    : undefined,
                groupId: queued.run.groupId,
                groupChannel: queued.run.groupChannel,
                groupSpace: queued.run.groupSpace,
                senderId: queued.run.senderId,
                senderName: queued.run.senderName,
                senderUsername: queued.run.senderUsername,
                senderE164: queued.run.senderE164,
                senderIsOwner: queued.run.senderIsOwner,
                sessionFile: queued.run.sessionFile,
                agentDir: queued.run.agentDir,
                workspaceDir: queued.run.workspaceDir,
                config: queued.run.config,
                skillsSnapshot: queued.run.skillsSnapshot,
                prompt: queued.prompt,
                extraSystemPrompt: queued.run.extraSystemPrompt,
                ownerNumbers: queued.run.ownerNumbers,
                enforceFinalTag: queued.run.enforceFinalTag,
                provider,
                model,
                ...authProfile,
                thinkLevel: queued.run.thinkLevel,
                verboseLevel: queued.run.verboseLevel,
                reasoningLevel: queued.run.reasoningLevel,
                suppressToolErrorWarnings: opts?.suppressToolErrorWarnings,
                execOverrides: queued.run.execOverrides,
                bashElevated: queued.run.bashElevated,
                timeoutMs: queued.run.timeoutMs,
                runId,
                allowTransientCooldownProbe: runOptions?.allowTransientCooldownProbe,
                blockReplyBreak: queued.run.blockReplyBreak,
                bootstrapPromptWarningSignaturesSeen,
                bootstrapPromptWarningSignature:
                  bootstrapPromptWarningSignaturesSeen[
                    bootstrapPromptWarningSignaturesSeen.length - 1
                  ],
                onAgentEvent: (evt: { stream: string; data?: Record<string, unknown> }) => {
                  if (evt.stream !== "compaction") {
                    return;
                  }
                  const phase = typeof evt.data?.phase === "string" ? evt.data.phase : "";
                  if (phase === "start") {
                    void sendCompactionNotice("🧹 Compacting context...");
                  }
                  const completed = evt.data?.completed === true;
                  if (phase === "end" && completed) {
                    attemptCompactionCount += 1;
                  }
                },
              });
              bootstrapPromptWarningSignaturesSeen = resolveBootstrapWarningSignaturesSeen(
                result.meta?.systemPromptReport,
              );
              const resultCompactionCount = Math.max(
                0,
                result.meta?.agentMeta?.compactionCount ?? 0,
              );
              attemptCompactionCount = Math.max(attemptCompactionCount, resultCompactionCount);
              return result;
            } finally {
              autoCompactionCount += attemptCompactionCount;
            }
          },
        });
        runResult = fallbackResult.result;
        fallbackProvider = fallbackResult.provider;
        fallbackModel = fallbackResult.model;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        defaultRuntime.error?.(`Followup agent failed before reply: ${message}`);
        return;
      }

      const usage = runResult.meta?.agentMeta?.usage;
      const promptTokens = runResult.meta?.agentMeta?.promptTokens;
      const modelUsed = runResult.meta?.agentMeta?.model ?? fallbackModel ?? defaultModel;
      const cachedContextTokens = lookupCachedContextTokens(modelUsed);
      const lazyContextTokens =
        agentCfgContextTokens == null && cachedContextTokens == null
          ? (await loadContextTokensRuntime()).lookupContextTokens(modelUsed)
          : undefined;
      const contextTokensUsed =
        agentCfgContextTokens ??
        cachedContextTokens ??
        lazyContextTokens ??
        sessionEntry?.contextTokens ??
        DEFAULT_CONTEXT_TOKENS;

      if (storePath && sessionKey) {
        await persistRunSessionUsage({
          storePath,
          sessionKey,
          cfg: queued.run.config,
          usage,
          lastCallUsage: runResult.meta?.agentMeta?.lastCallUsage,
          promptTokens,
          modelUsed,
          providerUsed: fallbackProvider,
          contextTokensUsed,
          systemPromptReport: runResult.meta?.systemPromptReport,
          logLabel: "followup",
        });
      }

      const payloadArray = runResult.payloads ?? [];
      const sanitizedPayloads = payloadArray.flatMap((payload: ReplyPayload) => {
        const text = payload.text;
        if (!text || !text.includes("HEARTBEAT_OK")) {
          return [payload];
        }
        const stripped = stripHeartbeatToken(text, { mode: "message" });
        const hasMedia = resolveSendableOutboundReplyParts(payload).hasMedia;
        if (stripped.shouldSkip && !hasMedia) {
          return [];
        }
        return [{ ...payload, text: stripped.text }];
      });
      const replyTaggedPayloads = await applyFollowupReplyThreading(sanitizedPayloads);

      const {
        filterMessagingToolDuplicates,
        filterMessagingToolMediaDuplicates,
        shouldSuppressMessagingToolReplies,
      } = await loadReplyPayloadsRuntime();
      const dedupedPayloads = filterMessagingToolDuplicates({
        payloads: replyTaggedPayloads,
        sentTexts: runResult.messagingToolSentTexts ?? [],
      });
      const mediaFilteredPayloads = filterMessagingToolMediaDuplicates({
        payloads: dedupedPayloads,
        sentMediaUrls: runResult.messagingToolSentMediaUrls ?? [],
      });
      const suppressMessagingToolReplies = shouldSuppressMessagingToolReplies({
        messageProvider: resolveOriginMessageProvider({
          originatingChannel: queued.originatingChannel,
          provider: queued.run.messageProvider,
        }),
        messagingToolSentTargets: runResult.messagingToolSentTargets,
        originatingTo: resolveOriginMessageTo({
          originatingTo: queued.originatingTo,
        }),
        accountId: resolveOriginAccountId({
          originatingAccountId: queued.originatingAccountId,
          accountId: queued.run.agentAccountId,
        }),
      });
      let finalPayloads = suppressMessagingToolReplies ? [] : mediaFilteredPayloads;

      if (autoCompactionCount > 0) {
        const count = await incrementRunCompactionCount({
          sessionEntry,
          sessionStore,
          sessionKey,
          storePath,
          amount: autoCompactionCount,
          lastCallUsage: runResult.meta?.agentMeta?.lastCallUsage,
          contextTokensUsed,
        });
        const suffix = typeof count === "number" ? ` (count ${count})` : "";
        const completionText =
          queued.run.verboseLevel && queued.run.verboseLevel !== "off"
            ? `🧹 Auto-compaction complete${suffix}.`
            : `✅ Context compacted${suffix}.`;
        finalPayloads = [
          ...(await applyFollowupReplyThreading([
            {
              text: completionText,
              replyToCurrent: true,
              isCompactionNotice: true,
            },
          ])),
          ...finalPayloads,
        ];
      }

      if (finalPayloads.length === 0) {
        return;
      }

      await sendFollowupPayloads(finalPayloads, queued);
    } finally {
      // Both signals are required for the typing controller to clean up.
      // The main inbound dispatch path calls markDispatchIdle() from the
      // buffered dispatcher's finally block, but followup turns bypass the
      // dispatcher entirely — so we must fire both signals here.  Without
      // this, NO_REPLY / empty-payload followups leave the typing indicator
      // stuck (the keepalive loop keeps sending "typing" to Telegram
      // indefinitely until the TTL expires).
      typing.markRunComplete();
      typing.markDispatchIdle();
    }
  };
}
