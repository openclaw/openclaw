import crypto from "node:crypto";
import { resolveAgentModelFallbacksOverride } from "../../agents/agent-scope.js";
import { lookupContextTokens } from "../../agents/context.js";
import { DEFAULT_CONTEXT_TOKENS } from "../../agents/defaults.js";
import {
  createSdkMainAgentRuntime,
  resolveMainAgentRuntimeKind,
} from "../../agents/main-agent-runtime-factory.js";
import { runWithModelFallback } from "../../agents/model-fallback.js";
import {
  createPiAgentRuntime,
  splitRunEmbeddedPiAgentParamsForRuntime,
} from "../../agents/pi-agent-runtime.js";
import type { EmbeddedPiRunResult } from "../../agents/pi-embedded-runner/types.js";
import { resolveAgentIdFromSessionKey, type SessionEntry } from "../../config/sessions.js";
import type { TypingMode } from "../../config/types.js";
import { logVerbose } from "../../globals.js";
import { emitAgentEvent, registerAgentRunContext } from "../../infra/agent-events.js";
import { defaultRuntime } from "../../runtime.js";
import { stripHeartbeatToken } from "../heartbeat.js";
import type { OriginatingChannelType } from "../templating.js";
import { isSilentReplyText, SILENT_REPLY_TOKEN } from "../tokens.js";
import type { GetReplyOptions, ReplyPayload } from "../types.js";
import type { FollowupRun } from "./queue.js";
import { isCompactionEndWithoutRetry } from "../../agents/agent-event-checks.js";
import {
  applyReplyThreading,
  filterMessagingToolDuplicates,
  shouldSuppressMessagingToolReplies,
} from "./reply-payloads.js";
import { resolveReplyToMode } from "./reply-threading.js";
import { isRoutableChannel, routeReply } from "./route-reply.js";
import { persistSessionUsageUpdate } from "./session-usage.js";
import { incrementCompactionCount } from "./session-updates.js";
import type { TypingController } from "./typing.js";
import { createTypingSignaler } from "./typing-mode.js";

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
    const shouldRouteToOriginating = isRoutableChannel(originatingChannel) && originatingTo;

    if (!shouldRouteToOriginating && !opts?.onBlockReply) {
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
          // Log error and fall back to dispatcher if available.
          const errorMsg = result.error ?? "unknown error";
          logVerbose(`followup queue: route-reply failed: ${errorMsg}`);
          // Fallback: try the dispatcher if routing failed.
          if (opts?.onBlockReply) {
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
      let runResult: EmbeddedPiRunResult;
      let fallbackProvider = queued.run.provider;
      let fallbackModel = queued.run.model;
      try {
        const runtimeKind = resolveMainAgentRuntimeKind(queued.run.config);
        if (runtimeKind === "sdk") {
          const sdkRuntime = await createSdkMainAgentRuntime({
            config: queued.run.config,
            sessionKey: queued.run.sessionKey,
            sessionFile: queued.run.sessionFile,
            workspaceDir: queued.run.workspaceDir,
            agentDir: queued.run.agentDir,
            abortSignal: opts?.abortSignal,
            messageProvider: queued.run.messageProvider,
            agentAccountId: queued.run.agentAccountId,
            messageTo: queued.originatingTo,
            messageThreadId: queued.originatingThreadId,
            groupId: queued.run.groupId,
            groupChannel: queued.run.groupChannel,
            groupSpace: queued.run.groupSpace,
            senderId: queued.run.senderId,
            senderName: queued.run.senderName,
            senderUsername: queued.run.senderUsername,
            senderE164: queued.run.senderE164,
          });

          runResult = await sdkRuntime.run({
            sessionId: queued.run.sessionId,
            sessionKey: queued.run.sessionKey,
            sessionFile: queued.run.sessionFile,
            workspaceDir: queued.run.workspaceDir,
            agentDir: queued.run.agentDir,
            config: queued.run.config,
            prompt: queued.prompt,
            extraSystemPrompt: queued.run.extraSystemPrompt,
            ownerNumbers: queued.run.ownerNumbers,
            timeoutMs: queued.run.timeoutMs,
            runId,
            abortSignal: opts?.abortSignal,
            onAgentEvent: (evt) => {
              emitAgentEvent({
                runId,
                stream: evt.stream,
                data: evt.data,
                sessionKey: queued.run.sessionKey,
              });
            },
          });

          fallbackProvider = runResult.meta.agentMeta?.provider ?? "sdk";
          fallbackModel = runResult.meta.agentMeta?.model ?? "default";
        } else {
          const fallbackResult = await runWithModelFallback({
            cfg: queued.run.config,
            provider: queued.run.provider,
            model: queued.run.model,
            agentDir: queued.run.agentDir,
            fallbacksOverride: resolveAgentModelFallbacksOverride(
              queued.run.config,
              resolveAgentIdFromSessionKey(queued.run.sessionKey),
            ),
            run: (provider, model) => {
              const authProfileId =
                provider === queued.run.provider ? queued.run.authProfileId : undefined;
              const piParams = {
                sessionId: queued.run.sessionId,
                sessionKey: queued.run.sessionKey,
                messageProvider: queued.run.messageProvider,
                agentAccountId: queued.run.agentAccountId,
                messageTo: queued.originatingTo,
                messageThreadId: queued.originatingThreadId,
                groupId: queued.run.groupId,
                groupChannel: queued.run.groupChannel,
                groupSpace: queued.run.groupSpace,
                senderId: queued.run.senderId,
                senderName: queued.run.senderName,
                senderUsername: queued.run.senderUsername,
                senderE164: queued.run.senderE164,
                sessionFile: queued.run.sessionFile,
                workspaceDir: queued.run.workspaceDir,
                config: queued.run.config,
                skillsSnapshot: queued.run.skillsSnapshot,
                prompt: queued.prompt,
                extraSystemPrompt: queued.run.extraSystemPrompt,
                ownerNumbers: queued.run.ownerNumbers,
                enforceFinalTag: queued.run.enforceFinalTag,
                provider,
                model,
                authProfileId,
                authProfileIdSource: authProfileId ? queued.run.authProfileIdSource : undefined,
                thinkLevel: queued.run.thinkLevel,
                verboseLevel: queued.run.verboseLevel,
                reasoningLevel: queued.run.reasoningLevel,
                execOverrides: queued.run.execOverrides,
                bashElevated: queued.run.bashElevated,
                timeoutMs: queued.run.timeoutMs,
                runId,
                blockReplyBreak: queued.run.blockReplyBreak,
                onAgentEvent: (evt: { stream: string; data: Record<string, unknown> }) => {
                  if (evt.stream !== "compaction") return;
                  const phase = typeof evt.data.phase === "string" ? evt.data.phase : "";
                  const willRetry = Boolean(evt.data.willRetry);
                  if (isCompactionEndWithoutRetry(phase, willRetry)) {
                    autoCompactionCompleted = true;
                  }
                },
              };
              const { context, run } = splitRunEmbeddedPiAgentParamsForRuntime(piParams);
              return createPiAgentRuntime(context).run(run);
            },
          });
          runResult = fallbackResult.result;
          fallbackProvider = fallbackResult.provider;
          fallbackModel = fallbackResult.model;
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        defaultRuntime.error?.(`Followup agent failed before reply: ${message}`);
        return;
      }

      if (storePath && sessionKey) {
        const usage = runResult.meta.agentMeta?.usage;
        const modelUsed = runResult.meta.agentMeta?.model ?? fallbackModel ?? defaultModel;
        const contextTokensUsed =
          agentCfgContextTokens ??
          lookupContextTokens(modelUsed) ??
          sessionEntry?.contextTokens ??
          DEFAULT_CONTEXT_TOKENS;

        await persistSessionUsageUpdate({
          storePath,
          sessionKey,
          usage,
          modelUsed,
          providerUsed: fallbackProvider,
          contextTokensUsed,
          logLabel: "followup",
        });
      }

      const payloadArray = runResult.payloads ?? [];
      if (payloadArray.length === 0) return;
      const sanitizedPayloads = payloadArray.flatMap((payload) => {
        const text = payload.text;
        if (!text || !text.includes("HEARTBEAT_OK")) return [payload];
        const stripped = stripHeartbeatToken(text, { mode: "message" });
        const hasMedia = Boolean(payload.mediaUrl) || (payload.mediaUrls?.length ?? 0) > 0;
        if (stripped.shouldSkip && !hasMedia) return [];
        return [{ ...payload, text: stripped.text }];
      });
      const replyToChannel =
        queued.originatingChannel ??
        (queued.run.messageProvider?.toLowerCase() as OriginatingChannelType | undefined);
      const replyToMode = resolveReplyToMode(
        queued.run.config,
        replyToChannel,
        queued.originatingAccountId,
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
      const suppressMessagingToolReplies = shouldSuppressMessagingToolReplies({
        messageProvider: queued.run.messageProvider,
        messagingToolSentTargets: runResult.messagingToolSentTargets,
        originatingTo: queued.originatingTo,
        accountId: queued.run.agentAccountId,
      });
      const finalPayloads = suppressMessagingToolReplies ? [] : dedupedPayloads;

      if (finalPayloads.length === 0) return;

      if (autoCompactionCompleted) {
        const count = await incrementCompactionCount({
          sessionEntry,
          sessionStore,
          sessionKey,
          storePath,
        });
        if (queued.run.verboseLevel && queued.run.verboseLevel !== "off") {
          const suffix = typeof count === "number" ? ` (count ${count})` : "";
          finalPayloads.unshift({
            text: `🧹 Auto-compaction complete${suffix}.`,
          });
        }
      }

      await sendFollowupPayloads(finalPayloads, queued);
    } finally {
      typing.markRunComplete();
    }
  };
}
