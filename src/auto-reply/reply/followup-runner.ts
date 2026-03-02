import crypto from "node:crypto";
import { resolveRunModelFallbacksOverride } from "../../agents/agent-scope.js";
import { lookupContextTokens } from "../../agents/context.js";
import { DEFAULT_CONTEXT_TOKENS } from "../../agents/defaults.js";
import { runWithModelFallback } from "../../agents/model-fallback.js";
import { runEmbeddedPiAgent } from "../../agents/pi-embedded.js";
import type { SessionEntry } from "../../config/sessions.js";
import type { TypingMode } from "../../config/types.js";
import { logVerbose } from "../../globals.js";
import { registerAgentRunContext } from "../../infra/agent-events.js";
import { defaultRuntime } from "../../runtime.js";
import { stripHeartbeatToken } from "../heartbeat.js";
import type { OriginatingChannelType } from "../templating.js";
import { hasRelaySkipToken, isSilentReplyText, SILENT_REPLY_TOKEN } from "../tokens.js";
import type { GetReplyOptions, ReplyPayload } from "../types.js";
import { resolveRunAuthProfile } from "./agent-runner-utils.js";
import {
  resolveOriginAccountId,
  resolveOriginMessageProvider,
  resolveOriginMessageTo,
  resolveRunDeliveryTarget,
  type RunDeliveryTarget,
} from "./origin-routing.js";
import type { FollowupRun } from "./queue.js";
import {
  applyReplyThreading,
  filterMessagingToolDuplicates,
  filterMessagingToolMediaDuplicates,
  shouldSuppressMessagingToolReplies,
} from "./reply-payloads.js";
import { resolveReplyToMode } from "./reply-threading.js";
import { isRoutableChannel, routeReply } from "./route-reply.js";
import { incrementRunCompactionCount, persistRunSessionUsage } from "./session-run-accounting.js";
import { createTypingSignaler } from "./typing-mode.js";
import type { TypingController } from "./typing.js";

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
  const sendFollowupPayloads = async (
    payloads: ReplyPayload[],
    queued: FollowupRun,
    deliveryTarget: RunDeliveryTarget,
  ) => {
    const { channel, to, accountId, threadId, relayMode, viaRelayOutput } = deliveryTarget;
    const shouldRouteToTarget = isRoutableChannel(channel) && to;

    if (relayMode === "read-only" && !shouldRouteToTarget) {
      logVerbose("followup queue: read-only relay target unavailable; dropping payloads");
      return;
    }

    if (!shouldRouteToTarget && !opts?.onBlockReply) {
      logVerbose("followup queue: no onBlockReply handler; dropping payloads");
      return;
    }

    for (const payload of payloads) {
      if (!payload?.text && !payload?.mediaUrl && !payload?.mediaUrls?.length) {
        continue;
      }
      if (
        isSilentReplyText(payload.text, SILENT_REPLY_TOKEN) &&
        !payload.mediaUrl &&
        !payload.mediaUrls?.length
      ) {
        continue;
      }
      if (relayMode === "read-only" && hasRelaySkipToken(payload.text)) {
        continue;
      }
      await typingSignals.signalTextDelta(payload.text);

      // Route to resolved target if set, otherwise fall back to dispatcher.
      if (shouldRouteToTarget) {
        const result = await routeReply({
          payload,
          channel,
          to,
          sessionKey: queued.run.sessionKey,
          accountId,
          threadId,
          cfg: queued.run.config,
        });
        if (!result.ok) {
          const errorMsg = result.error ?? "unknown error";
          logVerbose(`followup queue: route-reply failed: ${errorMsg}`);
          if (viaRelayOutput) {
            logVerbose("followup queue: read-only relay route failed; dropping payload");
            continue;
          }
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
            originatingChannel: channel,
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
      if (queued.run.sessionKey) {
        registerAgentRunContext(runId, {
          sessionKey: queued.run.sessionKey,
          verboseLevel: queued.run.verboseLevel,
        });
      }
      let autoCompactionCompleted = false;
      let runResult: Awaited<ReturnType<typeof runEmbeddedPiAgent>>;
      let fallbackProvider = queued.run.provider;
      let fallbackModel = queued.run.model;
      try {
        const fallbackResult = await runWithModelFallback({
          cfg: queued.run.config,
          provider: queued.run.provider,
          model: queued.run.model,
          agentDir: queued.run.agentDir,
          fallbacksOverride: resolveRunModelFallbacksOverride({
            cfg: queued.run.config,
            agentId: queued.run.agentId,
            sessionKey: queued.run.sessionKey,
          }),
          run: (provider, model) => {
            const authProfile = resolveRunAuthProfile(queued.run, provider);
            return runEmbeddedPiAgent({
              sessionId: queued.run.sessionId,
              sessionKey: queued.run.sessionKey,
              agentId: queued.run.agentId,
              messageProvider: queued.run.messageProvider,
              agentAccountId: queued.run.agentAccountId,
              messageTo: queued.originatingTo,
              messageThreadId: queued.originatingThreadId,
              currentChannelId: queued.originatingTo,
              currentThreadTs:
                queued.originatingThreadId != null ? String(queued.originatingThreadId) : undefined,
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
              blockReplyBreak: queued.run.blockReplyBreak,
              onAgentEvent: (evt) => {
                if (evt.stream !== "compaction") {
                  return;
                }
                const phase = typeof evt.data.phase === "string" ? evt.data.phase : "";
                if (phase === "end") {
                  autoCompactionCompleted = true;
                }
              },
            });
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
      const contextTokensUsed =
        agentCfgContextTokens ??
        lookupContextTokens(modelUsed) ??
        sessionEntry?.contextTokens ??
        DEFAULT_CONTEXT_TOKENS;

      if (storePath && sessionKey) {
        await persistRunSessionUsage({
          storePath,
          sessionKey,
          usage,
          lastCallUsage: runResult.meta?.agentMeta?.lastCallUsage,
          promptTokens,
          modelUsed,
          providerUsed: fallbackProvider,
          contextTokensUsed,
          logLabel: "followup",
        });
      }

      const payloadArray = runResult.payloads ?? [];
      if (payloadArray.length === 0) {
        return;
      }
      const sanitizedPayloads = payloadArray.flatMap((payload) => {
        const text = payload.text;
        if (!text || !text.includes("HEARTBEAT_OK")) {
          return [payload];
        }
        const stripped = stripHeartbeatToken(text, { mode: "message" });
        const hasMedia = Boolean(payload.mediaUrl) || (payload.mediaUrls?.length ?? 0) > 0;
        if (stripped.shouldSkip && !hasMedia) {
          return [];
        }
        return [{ ...payload, text: stripped.text }];
      });
      const deliveryTarget = resolveRunDeliveryTarget({
        relayMode: queued.relayMode,
        relayOutput: queued.relayOutput,
        originatingChannel: queued.originatingChannel,
        originatingTo: queued.originatingTo,
        originatingAccountId: queued.originatingAccountId,
        originatingThreadId: queued.originatingThreadId,
      });
      const replyToChannel = resolveOriginMessageProvider({
        originatingChannel: deliveryTarget.channel ?? queued.originatingChannel,
        provider: queued.run.messageProvider,
      }) as OriginatingChannelType | undefined;
      const replyToMode = resolveReplyToMode(
        queued.run.config,
        replyToChannel,
        deliveryTarget.accountId ?? queued.originatingAccountId,
        queued.originatingChatType,
      );

      const replyTaggedPayloads: ReplyPayload[] = applyReplyThreading({
        payloads: sanitizedPayloads,
        replyToMode,
        replyToChannel,
      });

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
          originatingChannel: deliveryTarget.channel ?? queued.originatingChannel,
          provider: queued.run.messageProvider,
        }),
        messagingToolSentTargets: runResult.messagingToolSentTargets,
        originatingTo: resolveOriginMessageTo({
          originatingTo: deliveryTarget.to ?? queued.originatingTo,
        }),
        accountId: resolveOriginAccountId({
          originatingAccountId: deliveryTarget.accountId ?? queued.originatingAccountId,
          accountId: queued.run.agentAccountId,
        }),
      });
      const finalPayloads = suppressMessagingToolReplies ? [] : mediaFilteredPayloads;

      if (finalPayloads.length === 0) {
        return;
      }

      if (autoCompactionCompleted) {
        const count = await incrementRunCompactionCount({
          sessionEntry,
          sessionStore,
          sessionKey,
          storePath,
          lastCallUsage: runResult.meta?.agentMeta?.lastCallUsage,
          contextTokensUsed,
        });
        if (queued.run.verboseLevel && queued.run.verboseLevel !== "off") {
          const suffix = typeof count === "number" ? ` (count ${count})` : "";
          finalPayloads.unshift({
            text: `🧹 Auto-compaction complete${suffix}.`,
          });
        }
      }

      await sendFollowupPayloads(finalPayloads, queued, deliveryTarget);
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
