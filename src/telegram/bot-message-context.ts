import type { Bot } from "grammy";
import { resolveAckReaction } from "../agents/identity.js";
import {
  findModelInCatalog,
  loadModelCatalog,
  modelSupportsVision,
} from "../agents/model-catalog.js";
import { resolveDefaultModelForAgent } from "../agents/model-selection.js";
import { hasControlCommand } from "../auto-reply/command-detection.js";
import { normalizeCommandBody } from "../auto-reply/commands-registry.js";
import { formatInboundEnvelope, resolveEnvelopeFormatOptions } from "../auto-reply/envelope.js";
import {
  buildPendingHistoryContextFromMap,
  recordPendingHistoryEntryIfEnabled,
  type HistoryEntry,
} from "../auto-reply/reply/history.js";
import { finalizeInboundContext } from "../auto-reply/reply/inbound-context.js";
import { buildMentionRegexes, matchesMentionWithExplicit } from "../auto-reply/reply/mentions.js";
import type { MsgContext } from "../auto-reply/templating.js";
import { shouldAckReaction as shouldAckReactionGate } from "../channels/ack-reactions.js";
import { resolveControlCommandGate } from "../channels/command-gating.js";
import { formatLocationText, toLocationContext } from "../channels/location.js";
import { logInboundDrop } from "../channels/logging.js";
import { resolveMentionGatingWithBypass } from "../channels/mention-gating.js";
import { recordInboundSession } from "../channels/session.js";
import type { OpenClawConfig } from "../config/config.js";
import { loadConfig } from "../config/config.js";
import { readSessionUpdatedAt, resolveStorePath } from "../config/sessions.js";
import type { DmPolicy, TelegramGroupConfig, TelegramTopicConfig } from "../config/types.js";
import { logVerbose, shouldLogVerbose } from "../globals.js";
import { recordChannelActivity } from "../infra/channel-activity.js";
import { buildPairingReply } from "../pairing/pairing-messages.js";
import { upsertChannelPairingRequest } from "../pairing/pairing-store.js";
import { resolveAgentRoute } from "../routing/resolve-route.js";
import { resolveThreadSessionKeys } from "../routing/session-key.js";
import { withTelegramApiErrorLogging } from "./api-logging.js";
import {
  firstDefined,
  isSenderAllowed,
  normalizeAllowFromWithStore,
  resolveSenderAllowMatch,
} from "./bot-access.js";
import {
  buildGroupLabel,
  buildSenderLabel,
  buildSenderName,
  buildTelegramGroupFrom,
  buildTelegramGroupPeerId,
  buildTelegramParentPeer,
  buildTypingThreadParams,
  resolveTelegramMediaPlaceholder,
  expandTextLinks,
  normalizeForwardedContext,
  describeReplyTarget,
  extractTelegramLocation,
  hasBotMention,
  resolveTelegramThreadSpec,
} from "./bot/helpers.js";
import type { StickerMetadata, TelegramContext } from "./bot/types.js";
import { evaluateTelegramGroupBaseAccess } from "./group-access.js";

export type TelegramMediaRef = {
  path: string;
  contentType?: string;
  stickerMetadata?: StickerMetadata;
};

type TelegramMessageContextOptions = {
  forceWasMentioned?: boolean;
  messageIdOverride?: string;
};

type TelegramLogger = {
  info: (obj: Record<string, unknown>, msg: string) => void;
};

type ResolveTelegramGroupConfig = (
  chatId: string | number,
  messageThreadId?: number,
) => { groupConfig?: TelegramGroupConfig; topicConfig?: TelegramTopicConfig };

type ResolveGroupActivation = (params: {
  chatId: string | number;
  agentId?: string;
  messageThreadId?: number;
  sessionKey?: string;
}) => boolean | undefined;

type ResolveGroupRequireMention = (chatId: string | number) => boolean;

export type BuildTelegramMessageContextParams = {
  primaryCtx: TelegramContext;
  allMedia: TelegramMediaRef[];
  storeAllowFrom: string[];
  options?: TelegramMessageContextOptions;
  bot: Bot;
  cfg: OpenClawConfig;
  account: { accountId: string };
  historyLimit: number;
  groupHistories: Map<string, HistoryEntry[]>;
  dmPolicy: DmPolicy;
  allowFrom?: Array<string | number>;
  groupAllowFrom?: Array<string | number>;
  ackReactionScope: "off" | "group-mentions" | "group-all" | "direct" | "all";
  logger: TelegramLogger;
  resolveGroupActivation: ResolveGroupActivation;
  resolveGroupRequireMention: ResolveGroupRequireMention;
  resolveTelegramGroupConfig: ResolveTelegramGroupConfig;
};

async function resolveStickerVisionSupport(params: {
  cfg: OpenClawConfig;
  agentId?: string;
}): Promise<boolean> {
  try {
    const catalog = await loadModelCatalog({ config: params.cfg });
    const defaultModel = resolveDefaultModelForAgent({
      cfg: params.cfg,
      agentId: params.agentId,
    });
    const entry = findModelInCatalog(catalog, defaultModel.provider, defaultModel.model);
    if (!entry) {
      return false;
    }
    return modelSupportsVision(entry);
  } catch {
    return false;
  }
}

export const buildTelegramMessageContext = async ({
  primaryCtx,
  allMedia,
  storeAllowFrom,
  options,
  bot,
  cfg,
  account,
  historyLimit,
  groupHistories,
  dmPolicy,
  allowFrom,
  groupAllowFrom,
  ackReactionScope,
  logger,
  resolveGroupActivation,
  resolveGroupRequireMention,
  resolveTelegramGroupConfig,
}: BuildTelegramMessageContextParams) => {
  const msg = primaryCtx.message;
  recordChannelActivity({
    channel: "telegram",
    accountId: account.accountId,
    direction: "inbound",
  });
  const chatId = msg.chat.id;
  const isGroup = msg.chat.type === "group" || msg.chat.type === "supergroup";
  const messageThreadId = (msg as { message_thread_id?: number }).message_thread_id;
  const isForum = (msg.chat as { is_forum?: boolean }).is_forum === true;
  const threadSpec = resolveTelegramThreadSpec({
    isGroup,
    isForum,
    messageThreadId,
  });
  const resolvedThreadId = threadSpec.scope === "forum" ? threadSpec.id : undefined;
  const replyThreadId = threadSpec.id;
  const { groupConfig, topicConfig } = resolveTelegramGroupConfig(chatId, resolvedThreadId);
  const peerId = isGroup ? buildTelegramGroupPeerId(chatId, resolvedThreadId) : String(chatId);
  const parentPeer = buildTelegramParentPeer({ isGroup, resolvedThreadId, chatId });
  // Fresh config for bindings lookup; other routing inputs are payload-derived.
  const route = resolveAgentRoute({
    cfg: loadConfig(),
    channel: "telegram",
    accountId: account.accountId,
    peer: {
      kind: isGroup ? "group" : "direct",
      id: peerId,
    },
    parentPeer,
  });
  const baseSessionKey = route.sessionKey;
  // DMs: use raw messageThreadId for thread sessions (not forum topic ids)
  const dmThreadId = threadSpec.scope === "dm" ? threadSpec.id : undefined;
  const threadKeys =
    dmThreadId != null
      ? resolveThreadSessionKeys({ baseSessionKey, threadId: String(dmThreadId) })
      : null;
  const sessionKey = threadKeys?.sessionKey ?? baseSessionKey;
  const mentionRegexes = buildMentionRegexes(cfg, route.agentId);
  const effectiveDmAllow = normalizeAllowFromWithStore({ allowFrom, storeAllowFrom });
  const groupAllowOverride = firstDefined(topicConfig?.allowFrom, groupConfig?.allowFrom);
  const effectiveGroupAllow = normalizeAllowFromWithStore({
    allowFrom: groupAllowOverride ?? groupAllowFrom,
    storeAllowFrom,
  });
  const hasGroupAllowOverride = typeof groupAllowOverride !== "undefined";
  const senderId = msg.from?.id ? String(msg.from.id) : "";
  const senderUsername = msg.from?.username ?? "";
  const baseAccess = evaluateTelegramGroupBaseAccess({
    isGroup,
    groupConfig,
    topicConfig,
    hasGroupAllowOverride,
    effectiveGroupAllow,
    senderId,
    senderUsername,
    enforceAllowOverride: true,
    requireSenderForAllowOverride: false,
  });
  if (!baseAccess.allowed) {
    if (baseAccess.reason === "group-disabled") {
      logVerbose(`Blocked telegram group ${chatId} (group disabled)`);
      return null;
    }
    if (baseAccess.reason === "topic-disabled") {
      logVerbose(
        `Blocked telegram topic ${chatId} (${resolvedThreadId ?? "unknown"}) (topic disabled)`,
      );
      return null;
    }
    logVerbose(`Blocked telegram group sender ${senderId || "unknown"} (group allowFrom override)`);
    return null;
  }

  // Compute requireMention early for preflight transcription gating
  const activationOverride = resolveGroupActivation({
    chatId,
    messageThreadId: resolvedThreadId,
    sessionKey: sessionKey,
    agentId: route.agentId,
  });
  const baseRequireMention = resolveGroupRequireMention(chatId);
  const requireMention = firstDefined(
    activationOverride,
    topicConfig?.requireMention,
    groupConfig?.requireMention,
    baseRequireMention,
  );

  const sendTyping = async () => {
    await withTelegramApiErrorLogging({
      operation: "sendChatAction",
      fn: () => bot.api.sendChatAction(chatId, "typing", buildTypingThreadParams(replyThreadId)),
    });
  };

  const sendRecordVoice = async () => {
    try {
      await withTelegramApiErrorLogging({
        operation: "sendChatAction",
        fn: () =>
          bot.api.sendChatAction(chatId, "record_voice", buildTypingThreadParams(replyThreadId)),
      });
    } catch (err) {
      logVerbose(`telegram record_voice cue failed for chat ${chatId}: ${String(err)}`);
    }
  };

  // DM access control (secure defaults): "pairing" (default) / "allowlist" / "open" / "disabled"
  if (!isGroup) {
    if (dmPolicy === "disabled") {
      return null;
    }

    if (dmPolicy !== "open") {
      const senderUsername = msg.from?.username ?? "";
      const senderUserId = msg.from?.id != null ? String(msg.from.id) : null;
      const candidate = senderUserId ?? String(chatId);
      const allowMatch = resolveSenderAllowMatch({
        allow: effectiveDmAllow,
        senderId: candidate,
        senderUsername,
      });
      const allowMatchMeta = `matchKey=${allowMatch.matchKey ?? "none"} matchSource=${
        allowMatch.matchSource ?? "none"
      }`;
      const allowed =
        effectiveDmAllow.hasWildcard || (effectiveDmAllow.hasEntries && allowMatch.allowed);
      if (!allowed) {
        if (dmPolicy === "pairing") {
          try {
            const from = msg.from as
              | {
                  first_name?: string;
                  last_name?: string;
                  username?: string;
                  id?: number;
                }
              | undefined;
            const telegramUserId = from?.id ? String(from.id) : candidate;
            const { code, created } = await upsertChannelPairingRequest({
              channel: "telegram",
              id: telegramUserId,
              accountId: account.accountId,
              meta: {
                username: from?.username,
                firstName: from?.first_name,
                lastName: from?.last_name,
              },
            });
            if (created) {
              logger.info(
                {
                  chatId: String(chatId),
                  senderUserId: senderUserId ?? undefined,
                  username: from?.username,
                  firstName: from?.first_name,
                  lastName: from?.last_name,
                  matchKey: allowMatch.matchKey ?? "none",
                  matchSource: allowMatch.matchSource ?? "none",
                },
                "telegram pairing request",
              );
              await withTelegramApiErrorLogging({
                operation: "sendMessage",
                fn: () =>
                  bot.api.sendMessage(
                    chatId,
                    buildPairingReply({
                      channel: "telegram",
                      idLine: `Your Telegram user id: ${telegramUserId}`,
                      code,
                    }),
                  ),
              });
            }
          } catch (err) {
            logVerbose(`telegram pairing reply failed for chat ${chatId}: ${String(err)}`);
          }
        } else {
          logVerbose(
            `Blocked unauthorized telegram sender ${candidate} (dmPolicy=${dmPolicy}, ${allowMatchMeta})`,
          );
        }
        return null;
      }
    }
  }

  const botUsername = primaryCtx.me?.username?.toLowerCase();
  const allowForCommands = isGroup ? effectiveGroupAllow : effectiveDmAllow;
  const senderAllowedForCommands = isSenderAllowed({
    allow: allowForCommands,
    senderId,
    senderUsername,
  });
  const useAccessGroups = cfg.commands?.useAccessGroups !== false;
  const hasControlCommandInMessage = hasControlCommand(msg.text ?? msg.caption ?? "", cfg, {
    botUsername,
  });
  const commandGate = resolveControlCommandGate({
    useAccessGroups,
    authorizers: [{ configured: allowForCommands.hasEntries, allowed: senderAllowedForCommands }],
    allowTextCommands: true,
    hasControlCommand: hasControlCommandInMessage,
  });
  const commandAuthorized = commandGate.commandAuthorized;
  const historyKey = isGroup ? buildTelegramGroupPeerId(chatId, resolvedThreadId) : undefined;

  let placeholder = resolveTelegramMediaPlaceholder(msg) ?? "";

  // Check if sticker has a cached description - if so, use it instead of sending the image
  const cachedStickerDescription = allMedia[0]?.stickerMetadata?.cachedDescription;
  const stickerSupportsVision = msg.sticker
    ? await resolveStickerVisionSupport({ cfg, agentId: route.agentId })
    : false;
  const stickerCacheHit = Boolean(cachedStickerDescription) && !stickerSupportsVision;
  if (stickerCacheHit) {
    // Format cached description with sticker context
    const emoji = allMedia[0]?.stickerMetadata?.emoji;
    const setName = allMedia[0]?.stickerMetadata?.setName;
    const stickerContext = [emoji, setName ? `from "${setName}"` : null].filter(Boolean).join(" ");
    placeholder = `[Sticker${stickerContext ? ` ${stickerContext}` : ""}] ${cachedStickerDescription}`;
  }

  const locationData = extractTelegramLocation(msg);
  const locationText = locationData ? formatLocationText(locationData) : undefined;
  const rawTextSource = msg.text ?? msg.caption ?? "";
  const rawText = expandTextLinks(rawTextSource, msg.entities ?? msg.caption_entities).trim();
  const hasUserText = Boolean(rawText || locationText);
  let rawBody = [rawText, locationText].filter(Boolean).join("\n").trim();
  if (!rawBody) {
    rawBody = placeholder;
  }
  if (!rawBody && allMedia.length === 0) {
    return null;
  }

  let bodyText = rawBody;
  const hasAudio = allMedia.some((media) => media.contentType?.startsWith("audio/"));

  // Preflight audio transcription for mention detection in groups
  // This allows voice notes to be checked for mentions before being dropped
  let preflightTranscript: string | undefined;
  const needsPreflightTranscription =
    isGroup && requireMention && hasAudio && !hasUserText && mentionRegexes.length > 0;

  if (needsPreflightTranscription) {
    try {
      const { transcribeFirstAudio } = await import("../media-understanding/audio-preflight.js");
      // Build a minimal context for transcription
      const tempCtx: MsgContext = {
        MediaPaths: allMedia.length > 0 ? allMedia.map((m) => m.path) : undefined,
        MediaTypes:
          allMedia.length > 0
            ? (allMedia.map((m) => m.contentType).filter(Boolean) as string[])
            : undefined,
      };
      preflightTranscript = await transcribeFirstAudio({
        ctx: tempCtx,
        cfg,
        agentDir: undefined,
      });
    } catch (err) {
      logVerbose(`telegram: audio preflight transcription failed: ${String(err)}`);
    }
  }

  // Replace audio placeholder with transcript when preflight succeeds.
  if (hasAudio && bodyText === "<media:audio>" && preflightTranscript) {
    bodyText = preflightTranscript;
  }

  // Build bodyText fallback for messages that still have no text.
  if (!bodyText && allMedia.length > 0) {
    if (hasAudio) {
      bodyText = preflightTranscript || "<media:audio>";
    } else {
      bodyText = `<media:image>${allMedia.length > 1 ? ` (${allMedia.length} images)` : ""}`;
    }
  }

  const hasAnyMention = (msg.entities ?? msg.caption_entities ?? []).some(
    (ent) => ent.type === "mention",
  );
  const explicitlyMentioned = botUsername ? hasBotMention(msg, botUsername) : false;

  const computedWasMentioned = matchesMentionWithExplicit({
    text: msg.text ?? msg.caption ?? "",
    mentionRegexes,
    explicit: {
      hasAnyMention,
      isExplicitlyMentioned: explicitlyMentioned,
      canResolveExplicit: Boolean(botUsername),
    },
    transcript: preflightTranscript,
  });
  const wasMentioned = options?.forceWasMentioned === true ? true : computedWasMentioned;
  if (isGroup && commandGate.shouldBlock) {
    logInboundDrop({
      log: logVerbose,
      channel: "telegram",
      reason: "control command (unauthorized)",
      target: senderId ?? "unknown",
    });
    return null;
  }
  // Reply-chain detection: replying to a bot message acts like an implicit mention.
  const botId = primaryCtx.me?.id;
  const replyFromId = msg.reply_to_message?.from?.id;
  const implicitMention = botId != null && replyFromId === botId;
  const canDetectMention = Boolean(botUsername) || mentionRegexes.length > 0;
  const mentionGate = resolveMentionGatingWithBypass({
    isGroup,
    requireMention: Boolean(requireMention),
    canDetectMention,
    wasMentioned,
    implicitMention: isGroup && Boolean(requireMention) && implicitMention,
    hasAnyMention,
    allowTextCommands: true,
    hasControlCommand: hasControlCommandInMessage,
    commandAuthorized,
  });
  const effectiveWasMentioned = mentionGate.effectiveWasMentioned;
  if (isGroup && requireMention && canDetectMention) {
    if (mentionGate.shouldSkip) {
      logger.info({ chatId, reason: "no-mention" }, "skipping group message");
      recordPendingHistoryEntryIfEnabled({
        historyMap: groupHistories,
        historyKey: historyKey ?? "",
        limit: historyLimit,
        entry: historyKey
          ? {
              sender: buildSenderLabel(msg, senderId || chatId),
              body: rawBody,
              timestamp: msg.date ? msg.date * 1000 : undefined,
              messageId: typeof msg.message_id === "number" ? String(msg.message_id) : undefined,
            }
          : null,
      });
      return null;
    }
  }

  // ACK reactions
  const ackReaction = resolveAckReaction(cfg, route.agentId, {
    channel: "telegram",
    accountId: account.accountId,
  });
  const removeAckAfterReply = cfg.messages?.removeAckAfterReply ?? false;
  const shouldAckReaction = () =>
    Boolean(
      ackReaction &&
      shouldAckReactionGate({
        scope: ackReactionScope,
        isDirect: !isGroup,
        isGroup,
        isMentionableGroup: isGroup,
        requireMention: Boolean(requireMention),
        canDetectMention,
        effectiveWasMentioned,
        shouldBypassMention: mentionGate.shouldBypassMention,
      }),
    );
  const api = bot.api as unknown as {
    setMessageReaction?: (
      chatId: number | string,
      messageId: number,
      reactions: Array<{ type: "emoji"; emoji: string }>,
    ) => Promise<void>;
  };
  const reactionApi =
    typeof api.setMessageReaction === "function" ? api.setMessageReaction.bind(api) : null;
  const ackReactionPromise =
    shouldAckReaction() && msg.message_id && reactionApi
      ? withTelegramApiErrorLogging({
          operation: "setMessageReaction",
          fn: () => reactionApi(chatId, msg.message_id, [{ type: "emoji", emoji: ackReaction }]),
        }).then(
          () => true,
          (err) => {
            logVerbose(`telegram react failed for chat ${chatId}: ${String(err)}`);
            return false;
          },
        )
      : null;

  const replyTarget = describeReplyTarget(msg);
  const forwardOrigin = normalizeForwardedContext(msg);
  const replySuffix = replyTarget
    ? replyTarget.kind === "quote"
      ? `\n\n[Quoting ${replyTarget.sender}${
          replyTarget.id ? ` id:${replyTarget.id}` : ""
        }]\n"${replyTarget.body}"\n[/Quoting]`
      : `\n\n[Replying to ${replyTarget.sender}${
          replyTarget.id ? ` id:${replyTarget.id}` : ""
        }]\n${replyTarget.body}\n[/Replying]`
    : "";
  const forwardPrefix = forwardOrigin
    ? `[Forwarded from ${forwardOrigin.from}${
        forwardOrigin.date ? ` at ${new Date(forwardOrigin.date * 1000).toISOString()}` : ""
      }]\n`
    : "";
  const groupLabel = isGroup ? buildGroupLabel(msg, chatId, resolvedThreadId) : undefined;
  const senderName = buildSenderName(msg);
  const conversationLabel = isGroup
    ? (groupLabel ?? `group:${chatId}`)
    : buildSenderLabel(msg, senderId || chatId);
  const storePath = resolveStorePath(cfg.session?.store, {
    agentId: route.agentId,
  });
  const envelopeOptions = resolveEnvelopeFormatOptions(cfg);
  const previousTimestamp = readSessionUpdatedAt({
    storePath,
    sessionKey: sessionKey,
  });
  const body = formatInboundEnvelope({
    channel: "Telegram",
    from: conversationLabel,
    timestamp: msg.date ? msg.date * 1000 : undefined,
    body: `${forwardPrefix}${bodyText}${replySuffix}`,
    chatType: isGroup ? "group" : "direct",
    sender: {
      name: senderName,
      username: senderUsername || undefined,
      id: senderId || undefined,
    },
    previousTimestamp,
    envelope: envelopeOptions,
  });
  let combinedBody = body;
  if (isGroup && historyKey && historyLimit > 0) {
    combinedBody = buildPendingHistoryContextFromMap({
      historyMap: groupHistories,
      historyKey,
      limit: historyLimit,
      currentMessage: combinedBody,
      formatEntry: (entry) =>
        formatInboundEnvelope({
          channel: "Telegram",
          from: groupLabel ?? `group:${chatId}`,
          timestamp: entry.timestamp,
          body: `${entry.body} [id:${entry.messageId ?? "unknown"} chat:${chatId}]`,
          chatType: "group",
          senderLabel: entry.sender,
          envelope: envelopeOptions,
        }),
    });
  }

  const skillFilter = firstDefined(topicConfig?.skills, groupConfig?.skills);
  const systemPromptParts = [
    groupConfig?.systemPrompt?.trim() || null,
    topicConfig?.systemPrompt?.trim() || null,
  ].filter((entry): entry is string => Boolean(entry));
  const groupSystemPrompt =
    systemPromptParts.length > 0 ? systemPromptParts.join("\n\n") : undefined;
  const commandBody = normalizeCommandBody(rawBody, { botUsername });
  const inboundHistory =
    isGroup && historyKey && historyLimit > 0
      ? (groupHistories.get(historyKey) ?? []).map((entry) => ({
          sender: entry.sender,
          body: entry.body,
          timestamp: entry.timestamp,
        }))
      : undefined;
  const ctxPayload = finalizeInboundContext({
    Body: combinedBody,
    // Agent prompt should be the raw user text only; metadata/context is provided via system prompt.
    BodyForAgent: bodyText,
    InboundHistory: inboundHistory,
    RawBody: rawBody,
    CommandBody: commandBody,
    From: isGroup ? buildTelegramGroupFrom(chatId, resolvedThreadId) : `telegram:${chatId}`,
    To: `telegram:${chatId}`,
    SessionKey: sessionKey,
    AccountId: route.accountId,
    ChatType: isGroup ? "group" : "direct",
    ConversationLabel: conversationLabel,
    GroupSubject: isGroup ? (msg.chat.title ?? undefined) : undefined,
    GroupSystemPrompt: isGroup ? groupSystemPrompt : undefined,
    SenderName: senderName,
    SenderId: senderId || undefined,
    SenderUsername: senderUsername || undefined,
    Provider: "telegram",
    Surface: "telegram",
    MessageSid: options?.messageIdOverride ?? String(msg.message_id),
    ReplyToId: replyTarget?.id,
    ReplyToBody: replyTarget?.body,
    ReplyToSender: replyTarget?.sender,
    ReplyToIsQuote: replyTarget?.kind === "quote" ? true : undefined,
    ForwardedFrom: forwardOrigin?.from,
    ForwardedFromType: forwardOrigin?.fromType,
    ForwardedFromId: forwardOrigin?.fromId,
    ForwardedFromUsername: forwardOrigin?.fromUsername,
    ForwardedFromTitle: forwardOrigin?.fromTitle,
    ForwardedFromSignature: forwardOrigin?.fromSignature,
    ForwardedFromChatType: forwardOrigin?.fromChatType,
    ForwardedFromMessageId: forwardOrigin?.fromMessageId,
    ForwardedDate: forwardOrigin?.date ? forwardOrigin.date * 1000 : undefined,
    Timestamp: msg.date ? msg.date * 1000 : undefined,
    WasMentioned: isGroup ? effectiveWasMentioned : undefined,
    // Filter out cached stickers from media - their description is already in the message body
    MediaPath: stickerCacheHit ? undefined : allMedia[0]?.path,
    MediaType: stickerCacheHit ? undefined : allMedia[0]?.contentType,
    MediaUrl: stickerCacheHit ? undefined : allMedia[0]?.path,
    MediaPaths: stickerCacheHit
      ? undefined
      : allMedia.length > 0
        ? allMedia.map((m) => m.path)
        : undefined,
    MediaUrls: stickerCacheHit
      ? undefined
      : allMedia.length > 0
        ? allMedia.map((m) => m.path)
        : undefined,
    MediaTypes: stickerCacheHit
      ? undefined
      : allMedia.length > 0
        ? (allMedia.map((m) => m.contentType).filter(Boolean) as string[])
        : undefined,
    Sticker: allMedia[0]?.stickerMetadata,
    ...(locationData ? toLocationContext(locationData) : undefined),
    CommandAuthorized: commandAuthorized,
    // For groups: use resolved forum topic id; for DMs: use raw messageThreadId
    MessageThreadId: threadSpec.id,
    IsForum: isForum,
    // Originating channel for reply routing.
    OriginatingChannel: "telegram" as const,
    OriginatingTo: `telegram:${chatId}`,
  });

  await recordInboundSession({
    storePath,
    sessionKey: ctxPayload.SessionKey ?? sessionKey,
    ctx: ctxPayload,
    updateLastRoute: !isGroup
      ? {
          sessionKey: route.mainSessionKey,
          channel: "telegram",
          to: String(chatId),
          accountId: route.accountId,
          // Preserve DM topic threadId for replies (fixes #8891)
          threadId: dmThreadId != null ? String(dmThreadId) : undefined,
        }
      : undefined,
    onRecordError: (err) => {
      logVerbose(`telegram: failed updating session meta: ${String(err)}`);
    },
  });

  if (replyTarget && shouldLogVerbose()) {
    const preview = replyTarget.body.replace(/\s+/g, " ").slice(0, 120);
    logVerbose(
      `telegram reply-context: replyToId=${replyTarget.id} replyToSender=${replyTarget.sender} replyToBody="${preview}"`,
    );
  }

  if (forwardOrigin && shouldLogVerbose()) {
    logVerbose(
      `telegram forward-context: forwardedFrom="${forwardOrigin.from}" type=${forwardOrigin.fromType}`,
    );
  }

  if (shouldLogVerbose()) {
    const preview = body.slice(0, 200).replace(/\n/g, "\\n");
    const mediaInfo = allMedia.length > 1 ? ` mediaCount=${allMedia.length}` : "";
    const topicInfo = resolvedThreadId != null ? ` topic=${resolvedThreadId}` : "";
    logVerbose(
      `telegram inbound: chatId=${chatId} from=${ctxPayload.From} len=${body.length}${mediaInfo}${topicInfo} preview="${preview}"`,
    );
  }

  return {
    ctxPayload,
    primaryCtx,
    msg,
    chatId,
    isGroup,
    resolvedThreadId,
    threadSpec,
    replyThreadId,
    isForum,
    historyKey,
    historyLimit,
    groupHistories,
    route,
    skillFilter,
    sendTyping,
    sendRecordVoice,
    ackReactionPromise,
    reactionApi,
    removeAckAfterReply,
    accountId: account.accountId,
  };
};

export type TelegramMessageContext = NonNullable<
  Awaited<ReturnType<typeof buildTelegramMessageContext>>
>;
