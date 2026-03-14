import crypto from "node:crypto";
import { resolveRunModelFallbacksOverride } from "../../agents/agent-scope.js";
import { resolveBootstrapWarningSignaturesSeen } from "../../agents/bootstrap-budget.js";
import { lookupContextTokens } from "../../agents/context.js";
import { DEFAULT_CONTEXT_TOKENS } from "../../agents/defaults.js";
import { runWithModelFallback } from "../../agents/model-fallback.js";
import { runEmbeddedPiAgent } from "../../agents/pi-embedded.js";
import type { SessionEntry } from "../../config/sessions.js";
import type { TypingMode } from "../../config/types.js";
import { logVerbose } from "../../globals.js";
import { registerAgentRunContext } from "../../infra/agent-events.js";
import { applyMediaUnderstanding } from "../../media-understanding/apply.js";
import { defaultRuntime } from "../../runtime.js";
import { isInternalMessageChannel } from "../../utils/message-channel.js";
import { stripHeartbeatToken } from "../heartbeat.js";
import { buildInboundMediaNote } from "../media-note.js";
import type { MsgContext, OriginatingChannelType } from "../templating.js";
import { isSilentReplyText, SILENT_REPLY_TOKEN } from "../tokens.js";
import type { GetReplyOptions, ReplyPayload } from "../types.js";
import { resolveRunAuthProfile } from "./agent-runner-utils.js";
import { parseInlineDirectives } from "./directive-handling.js";
import {
  resolveOriginAccountId,
  resolveOriginMessageProvider,
  resolveOriginMessageTo,
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

const MEDIA_ONLY_PLACEHOLDER = "[User sent media without caption]";
const MEDIA_REPLY_HINT_PREFIX = "To send an image back, prefer the message tool";
const LEADING_MEDIA_ATTACHED_LINE_RE = /^\[media attached(?: \d+\/\d+)?: [^\r\n]*\]$/;
const FILE_BLOCK_RE = /<file\s+name="/i;

function stripLeadingMediaAttachedLines(prompt: string): string {
  const lines = prompt.split("\n");
  let index = 0;
  while (index < lines.length) {
    const trimmed = lines[index]?.trim() ?? "";
    if (!LEADING_MEDIA_ATTACHED_LINE_RE.test(trimmed)) {
      break;
    }
    index += 1;
  }
  return lines.slice(index).join("\n").trim();
}

function stripLeadingMediaReplyHint(prompt: string): string {
  const lines = prompt.split("\n");
  if ((lines[0] ?? "").startsWith(MEDIA_REPLY_HINT_PREFIX)) {
    return lines.slice(1).join("\n").trim();
  }
  return prompt.trim();
}

function replaceLastOccurrence(
  value: string,
  search: string,
  replacement: string,
): string | undefined {
  if (!search) {
    return undefined;
  }
  const index = value.lastIndexOf(search);
  if (index < 0) {
    return undefined;
  }
  return `${value.slice(0, index)}${replacement}${value.slice(index + search.length)}`;
}

function stripInlineDirectives(text: string | undefined): string {
  return parseInlineDirectives(text ?? "").cleaned.trim();
}

function normalizeUpdatedBody(params: { originalBody?: string; updatedBody?: string }): string {
  const updatedBody = params.updatedBody?.trim();
  if (!updatedBody) {
    return "";
  }
  const originalBody = params.originalBody?.trim();
  if (!originalBody) {
    return updatedBody;
  }

  const cleanedOriginalBody = stripInlineDirectives(originalBody);
  if (!cleanedOriginalBody) {
    return updatedBody;
  }
  if (updatedBody === originalBody) {
    return cleanedOriginalBody;
  }
  return (
    replaceLastOccurrence(updatedBody, originalBody, cleanedOriginalBody) ?? updatedBody
  ).trim();
}

function rebuildQueuedPromptWithMediaUnderstanding(params: {
  prompt: string;
  originalBody?: string;
  updatedBody?: string;
  mediaNote?: string;
}): string {
  let stripped = stripLeadingMediaAttachedLines(params.prompt);
  if (!params.mediaNote) {
    stripped = stripLeadingMediaReplyHint(stripped);
  }

  const updatedBody = normalizeUpdatedBody({
    originalBody: params.originalBody,
    updatedBody: params.updatedBody,
  });
  if (!updatedBody) {
    return [params.mediaNote?.trim(), stripped].filter(Boolean).join("\n").trim();
  }

  const replacementTargets = [
    params.originalBody?.trim(),
    stripInlineDirectives(params.originalBody),
    MEDIA_ONLY_PLACEHOLDER,
  ].filter(
    (value, index, list): value is string => Boolean(value) && list.indexOf(value) === index,
  );

  let rebuilt = stripped;
  for (const target of replacementTargets) {
    const replaced = replaceLastOccurrence(rebuilt, target, updatedBody);
    if (replaced !== undefined) {
      rebuilt = replaced;
      return [params.mediaNote?.trim(), rebuilt.trim()].filter(Boolean).join("\n").trim();
    }
  }

  rebuilt = [rebuilt, updatedBody].filter(Boolean).join("\n\n");
  return [params.mediaNote?.trim(), rebuilt.trim()].filter(Boolean).join("\n").trim();
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
      let autoCompactionCompleted = false;
      let runResult: Awaited<ReturnType<typeof runEmbeddedPiAgent>>;
      let fallbackProvider = queued.run.provider;
      let fallbackModel = queued.run.model;
      const activeSessionEntry =
        (sessionKey ? sessionStore?.[sessionKey] : undefined) ?? sessionEntry;
      let bootstrapPromptWarningSignaturesSeen = resolveBootstrapWarningSignaturesSeen(
        activeSessionEntry?.systemPromptReport,
      );

      // Apply media understanding for followup-queued messages when it was
      // not applied (or failed) in the primary path.  This ensures voice
      // notes that arrived while the agent was mid-turn still get transcribed.
      if (queued.mediaContext && !queued.mediaContext.MediaUnderstanding?.length) {
        const hasMedia = Boolean(
          queued.mediaContext.MediaPath?.trim() ||
          queued.mediaContext.MediaUrl?.trim() ||
          (Array.isArray(queued.mediaContext.MediaPaths) &&
            queued.mediaContext.MediaPaths.length > 0) ||
          (Array.isArray(queued.mediaContext.MediaUrls) &&
            queued.mediaContext.MediaUrls.length > 0),
        );
        if (hasMedia) {
          try {
            const resolvedOriginalBody =
              queued.mediaContext.CommandBody ??
              queued.mediaContext.RawBody ??
              queued.mediaContext.Body;
            const mediaCtx = {
              ...queued.mediaContext,
              Body: resolvedOriginalBody,
            } as MsgContext;
            const originalBody = resolvedOriginalBody;
            // Capture whether the resolved body already contains a file block
            // BEFORE applyMediaUnderstanding mutates it — this detects prior
            // extraction so we avoid double-inserting.  Checking the body
            // (not the full queued.prompt) avoids false positives from user
            // messages that happen to contain literal "<file path=" text.
            const bodyAlreadyHasFileBlock = FILE_BLOCK_RE.test(resolvedOriginalBody ?? "");
            const muResult = await applyMediaUnderstanding({
              ctx: mediaCtx,
              cfg: queued.run.config,
              agentDir: queued.run.agentDir,
              activeModel: {
                provider: queued.run.provider,
                model: queued.run.model,
              },
            });
            const shouldRebuildPrompt =
              muResult.outputs.length > 0 ||
              muResult.appliedAudio ||
              muResult.appliedImage ||
              muResult.appliedVideo ||
              (muResult.appliedFile && !bodyAlreadyHasFileBlock);
            if (shouldRebuildPrompt) {
              // Rebuild the queued prompt from the mutated media context so the
              // deferred path matches the primary path's prompt shape.
              const newMediaNote = buildInboundMediaNote(mediaCtx);
              queued.prompt = rebuildQueuedPromptWithMediaUnderstanding({
                prompt: queued.prompt,
                originalBody,
                updatedBody: mediaCtx.Body,
                mediaNote: newMediaNote,
              });
              logVerbose(
                `followup: applied media understanding (audio=${muResult.appliedAudio}, image=${muResult.appliedImage}, video=${muResult.appliedVideo}, file=${muResult.appliedFile})`,
              );
            }
          } catch (err) {
            logVerbose(
              `followup: media understanding failed, proceeding with raw content: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        }
      }

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
            const result = await runEmbeddedPiAgent({
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
              allowTransientCooldownProbe: runOptions?.allowTransientCooldownProbe,
              blockReplyBreak: queued.run.blockReplyBreak,
              bootstrapPromptWarningSignaturesSeen,
              bootstrapPromptWarningSignature:
                bootstrapPromptWarningSignaturesSeen[
                  bootstrapPromptWarningSignaturesSeen.length - 1
                ],
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
            bootstrapPromptWarningSignaturesSeen = resolveBootstrapWarningSignaturesSeen(
              result.meta?.systemPromptReport,
            );
            return result;
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
          systemPromptReport: runResult.meta?.systemPromptReport,
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
