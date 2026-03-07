import type { Bot } from "grammy";
import {
  ensureConfiguredAcpRouteReady,
  resolveConfiguredAcpRoute,
} from "../acp/persistent-bindings.route.js";
import { resolveAckReaction } from "../agents/identity.js";
import {
  findModelInCatalog,
  loadModelCatalog,
  modelSupportsVision,
} from "../agents/model-catalog.js";
import { resolveDefaultModelForAgent } from "../agents/model-selection.js";
import { hasControlCommand } from "../auto-reply/command-detection.js";
import { normalizeCommandBody } from "../auto-reply/commands-registry.js";
import {
  engagementStates,
  shouldParticipateInGroup,
  shouldRespondToMention,
} from "../auto-reply/contextual-activation.js";
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
import {
  createStatusReactionController,
  type StatusReactionController,
} from "../channels/status-reactions.js";
import type { OpenClawConfig } from "../config/config.js";
import { loadConfig } from "../config/config.js";
import { readSessionUpdatedAt, resolveStorePath } from "../config/sessions.js";
import type {
  DmPolicy,
  TelegramDirectConfig,
  TelegramGroupConfig,
  TelegramTopicConfig,
} from "../config/types.js";
import { logVerbose, shouldLogVerbose } from "../globals.js";
import { recordChannelActivity } from "../infra/channel-activity.js";
import { getSessionBindingService } from "../infra/outbound/session-binding-service.js";
import {
  buildAgentSessionKey,
  pickFirstExistingAgentId,
  resolveAgentRoute,
  type ResolvedAgentRoute,
} from "../routing/resolve-route.js";
import {
  DEFAULT_ACCOUNT_ID,
  buildAgentMainSessionKey,
  resolveAgentIdFromSessionKey,
  resolveThreadSessionKeys,
} from "../routing/session-key.js";
import { resolvePinnedMainDmOwnerFromAllowlist } from "../security/dm-policy-shared.js";
import { withTelegramApiErrorLogging } from "./api-logging.js";
import {
  firstDefined,
  isSenderAllowed,
  normalizeAllowFrom,
  normalizeDmAllowFromWithStore,
} from "./bot-access.js";
import {
  buildGroupLabel,
  buildSenderLabel,
  buildSenderName,
  resolveTelegramDirectPeerId,
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
import { enforceTelegramDmAccess } from "./dm-access.js";
import { isTelegramForumServiceMessage } from "./forum-service-message.js";
import { evaluateTelegramGroupBaseAccess } from "./group-access.js";
import { resolveTelegramGroupPromptSettings } from "./group-config-helpers.js";
import {
  buildTelegramStatusReactionVariants,
  resolveTelegramAllowedEmojiReactions,
  resolveTelegramReactionVariant,
  resolveTelegramStatusReactionEmojis,
} from "./status-reaction-variants.js";
import { getCachedSticker } from "./sticker-cache.js";

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
) => {
  groupConfig?: TelegramGroupConfig | TelegramDirectConfig;
  topicConfig?: TelegramTopicConfig;
};

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
  replyMedia?: TelegramMediaRef[];
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
  ackReactionScope: "off" | "none" | "group-mentions" | "group-all" | "direct" | "all";
  logger: TelegramLogger;
  resolveGroupActivation: ResolveGroupActivation;
  resolveGroupRequireMention: ResolveGroupRequireMention;
  resolveTelegramGroupConfig: ResolveTelegramGroupConfig;
  /** Global (per-account) handler for sendChatAction 401 backoff (#27092). */
  sendChatActionHandler: import("./sendchataction-401-backoff.js").TelegramSendChatActionHandler;
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

// oxlint-disable-next-line typescript/no-explicit-any
function formatStickerReplyBody(sticker: any): string {
  // Try to get cached description from sticker cache
  const cached = sticker?.file_unique_id ? getCachedSticker(sticker.file_unique_id) : null;
  if (cached?.description) {
    const emoji = sticker?.emoji ?? cached.emoji ?? "";
    const setName = cached.setName ? ` from "${cached.setName}"` : "";
    return `[sticker${emoji ? ` ${emoji}` : ""}${setName}] ${cached.description}`;
  }
  // Fallback: emoji + set name
  const emoji = sticker?.emoji ?? "";
  const setName = sticker?.set_name ? ` from "${sticker.set_name}"` : "";
  return `[sticker${emoji ? ` ${emoji}` : ""}${setName}]`;
}

export const buildTelegramMessageContext = async ({
  primaryCtx,
  allMedia,
  replyMedia = [],
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
  sendChatActionHandler,
}: BuildTelegramMessageContextParams) => {
  const msg = primaryCtx.message;
  const chatId = msg.chat.id;
  const isGroup = msg.chat.type === "group" || msg.chat.type === "supergroup";
  const senderId = msg.from?.id ? String(msg.from.id) : "";
  const messageThreadId = (msg as { message_thread_id?: number }).message_thread_id;
  const isForum = (msg.chat as { is_forum?: boolean }).is_forum === true;
  const threadSpec = resolveTelegramThreadSpec({
    isGroup,
    isForum,
    messageThreadId,
  });
  const resolvedThreadId = threadSpec.scope === "forum" ? threadSpec.id : undefined;
  const replyThreadId = threadSpec.id;
  const dmThreadId = threadSpec.scope === "dm" ? threadSpec.id : undefined;
  const threadIdForConfig = resolvedThreadId ?? dmThreadId;
  const { groupConfig, topicConfig } = resolveTelegramGroupConfig(chatId, threadIdForConfig);
  // Use direct config dmPolicy override if available for DMs
  const effectiveDmPolicy =
    !isGroup && groupConfig && "dmPolicy" in groupConfig
      ? (groupConfig.dmPolicy ?? dmPolicy)
      : dmPolicy;
  const peerId = isGroup
    ? buildTelegramGroupPeerId(chatId, resolvedThreadId)
    : resolveTelegramDirectPeerId({ chatId, senderId });
  const parentPeer = buildTelegramParentPeer({ isGroup, resolvedThreadId, chatId });
  // Fresh config for bindings lookup; other routing inputs are payload-derived.
  const freshCfg = loadConfig();
  let route: ResolvedAgentRoute = resolveAgentRoute({
    cfg: freshCfg,
    channel: "telegram",
    accountId: account.accountId,
    peer: {
      kind: isGroup ? "group" : "direct",
      id: peerId,
    },
    parentPeer,
  });
  // Per-topic agentId override: re-derive session key under the topic's agent.
  const rawTopicAgentId = topicConfig?.agentId?.trim();
  if (rawTopicAgentId) {
    // Validate agentId against configured agents; falls back to default if not found.
    const topicAgentId = pickFirstExistingAgentId(freshCfg, rawTopicAgentId);
    const overrideSessionKey = buildAgentSessionKey({
      agentId: topicAgentId,
      channel: "telegram",
      accountId: account.accountId,
      peer: { kind: isGroup ? "group" : "direct", id: peerId },
      dmScope: freshCfg.session?.dmScope,
      identityLinks: freshCfg.session?.identityLinks,
    }).toLowerCase();
    const overrideMainSessionKey = buildAgentMainSessionKey({
      agentId: topicAgentId,
    }).toLowerCase();
    route = {
      ...route,
      agentId: topicAgentId,
      sessionKey: overrideSessionKey,
      mainSessionKey: overrideMainSessionKey,
    };
    logVerbose(
      `telegram: per-topic agent override: topic=${resolvedThreadId ?? dmThreadId} agent=${topicAgentId} sessionKey=${overrideSessionKey}`,
    );
  }
  const configuredRoute = resolveConfiguredAcpRoute({
    cfg: freshCfg,
    route,
    channel: "telegram",
    accountId: account.accountId,
    conversationId: peerId,
    parentConversationId: isGroup ? String(chatId) : undefined,
  });
  let configuredBinding = configuredRoute.configuredBinding;
  let configuredBindingSessionKey = configuredRoute.boundSessionKey ?? "";
  route = configuredRoute.route;
  const threadBindingConversationId =
    replyThreadId != null
      ? `${chatId}:topic:${replyThreadId}`
      : !isGroup
        ? String(chatId)
        : undefined;
  if (threadBindingConversationId) {
    const threadBinding = getSessionBindingService().resolveByConversation({
      channel: "telegram",
      accountId: account.accountId,
      conversationId: threadBindingConversationId,
    });
    const boundSessionKey = threadBinding?.targetSessionKey?.trim();
    if (threadBinding && boundSessionKey) {
      route = {
        ...route,
        sessionKey: boundSessionKey,
        agentId: resolveAgentIdFromSessionKey(boundSessionKey),
        matchedBy: "binding.channel",
      };
      configuredBinding = null;
      configuredBindingSessionKey = "";
      getSessionBindingService().touch(threadBinding.bindingId);
      logVerbose(
        `telegram: routed via bound conversation ${threadBindingConversationId} -> ${boundSessionKey}`,
      );
    }
  }
  const requiresExplicitAccountBinding = (candidate: ResolvedAgentRoute): boolean =>
    candidate.accountId !== DEFAULT_ACCOUNT_ID && candidate.matchedBy === "default";
  // Fail closed for named Telegram accounts when route resolution falls back to
  // default-agent routing. This prevents cross-account DM/session contamination.
  if (requiresExplicitAccountBinding(route)) {
    logInboundDrop({
      log: logVerbose,
      channel: "telegram",
      reason: "non-default account requires explicit binding",
      target: route.accountId,
    });
    return null;
  }
  // Calculate groupAllowOverride first - it's needed for both DM and group allowlist checks
  const groupAllowOverride = firstDefined(topicConfig?.allowFrom, groupConfig?.allowFrom);
  // For DMs, prefer per-DM/topic allowFrom (groupAllowOverride) over account-level allowFrom
  const dmAllowFrom = groupAllowOverride ?? allowFrom;
  const effectiveDmAllow = normalizeDmAllowFromWithStore({
    allowFrom: dmAllowFrom,
    storeAllowFrom,
    dmPolicy: effectiveDmPolicy,
  });
  // Group sender checks are explicit and must not inherit DM pairing-store entries.
  const effectiveGroupAllow = normalizeAllowFrom(groupAllowOverride ?? groupAllowFrom);
  const hasGroupAllowOverride = typeof groupAllowOverride !== "undefined";
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
    logVerbose(
      isGroup
        ? `Blocked telegram group sender ${senderId || "unknown"} (group allowFrom override)`
        : `Blocked telegram DM sender ${senderId || "unknown"} (DM allowFrom override)`,
    );
    return null;
  }

  const requireTopic = (groupConfig as TelegramDirectConfig | undefined)?.requireTopic;
  const topicRequiredButMissing = !isGroup && requireTopic === true && dmThreadId == null;
  if (topicRequiredButMissing) {
    logVerbose(`Blocked telegram DM ${chatId}: requireTopic=true but no topic present`);
    return null;
  }

  const sendTyping = async () => {
    await withTelegramApiErrorLogging({
      operation: "sendChatAction",
      fn: () =>
        sendChatActionHandler.sendChatAction(
          chatId,
          "typing",
          buildTypingThreadParams(replyThreadId),
        ),
    });
  };

  const sendRecordVoice = async () => {
    try {
      await withTelegramApiErrorLogging({
        operation: "sendChatAction",
        fn: () =>
          sendChatActionHandler.sendChatAction(
            chatId,
            "record_voice",
            buildTypingThreadParams(replyThreadId),
          ),
      });
    } catch (err) {
      logVerbose(`telegram record_voice cue failed for chat ${chatId}: ${String(err)}`);
    }
  };

  if (
    !(await enforceTelegramDmAccess({
      isGroup,
      dmPolicy: effectiveDmPolicy,
      msg,
      chatId,
      effectiveDmAllow,
      accountId: account.accountId,
      bot,
      logger,
    }))
  ) {
    return null;
  }
  const ensureConfiguredBindingReady = async (): Promise<boolean> => {
    if (!configuredBinding) {
      return true;
    }
    const ensured = await ensureConfiguredAcpRouteReady({
      cfg: freshCfg,
      configuredBinding,
    });
    if (ensured.ok) {
      logVerbose(
        `telegram: using configured ACP binding for ${configuredBinding.spec.conversationId} -> ${configuredBindingSessionKey}`,
      );
      return true;
    }
    logVerbose(
      `telegram: configured ACP binding unavailable for ${configuredBinding.spec.conversationId}: ${ensured.error}`,
    );
    logInboundDrop({
      log: logVerbose,
      channel: "telegram",
      reason: "configured ACP binding unavailable",
      target: configuredBinding.spec.conversationId,
    });
    return false;
  };

  const baseSessionKey = route.sessionKey;
  // DMs: use thread suffix for session isolation (works regardless of dmScope)
  const threadKeys =
    dmThreadId != null
      ? resolveThreadSessionKeys({ baseSessionKey, threadId: `${chatId}:${dmThreadId}` })
      : null;
  const sessionKey = threadKeys?.sessionKey ?? baseSessionKey;
  const mentionRegexes = buildMentionRegexes(cfg, route.agentId);
  // Compute requireMention after access checks and final route selection.
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
    (groupConfig as TelegramGroupConfig | undefined)?.requireMention,
    baseRequireMention,
  );

  recordChannelActivity({
    channel: "telegram",
    accountId: account.accountId,
    direction: "inbound",
  });

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

  // Extract reply metadata once for use in history entries
  const replyMsg = msg.reply_to_message;
  const historyReplyToId = replyMsg?.message_id != null ? String(replyMsg.message_id) : undefined;
  const historyReplyToBody =
    replyMsg?.text ??
    replyMsg?.caption ??
    (replyMsg?.photo
      ? "[image]"
      : replyMsg?.sticker
        ? formatStickerReplyBody(replyMsg.sticker)
        : replyMsg?.video
          ? "[video]"
          : replyMsg?.voice
            ? "[voice message]"
            : replyMsg?.animation
              ? "[GIF]"
              : replyMsg?.document
                ? `[file: ${replyMsg.document.file_name ?? "unknown"}]`
                : undefined);
  const historyReplyToSender = replyMsg?.from?.first_name
    ? `${replyMsg.from.first_name}${replyMsg.from.last_name ? ` ${replyMsg.from.last_name}` : ""}`
    : (replyMsg?.from?.username ?? undefined);

  const hasAudio = allMedia.some((media) => media.contentType?.startsWith("audio/"));

  const disableAudioPreflight =
    firstDefined(
      topicConfig?.disableAudioPreflight,
      (groupConfig as TelegramGroupConfig | undefined)?.disableAudioPreflight,
    ) === true;

  // Preflight audio transcription for mention detection in groups
  // This allows voice notes to be checked for mentions before being dropped
  let preflightTranscript: string | undefined;
  const needsPreflightTranscription =
    isGroup &&
    requireMention &&
    hasAudio &&
    !hasUserText &&
    mentionRegexes.length > 0 &&
    !disableAudioPreflight;

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
  // Exclude forum-topic service messages (auto-generated "Topic created" etc. messages
  // by the bot) so that every message inside a bot-created topic does not incorrectly
  // bypass requireMention (#32256).
  // We detect service messages by the presence of Telegram's forum_topic_* fields
  // rather than by the absence of text/caption, because legitimate bot media messages
  // (stickers, voice notes, captionless photos) also lack text/caption.
  const botId = primaryCtx.me?.id;
  const replyFromId = msg.reply_to_message?.from?.id;
  const replyToBotMessage = botId != null && replyFromId === botId;
  const isReplyToServiceMessage =
    replyToBotMessage && isTelegramForumServiceMessage(msg.reply_to_message);
  const implicitMention = replyToBotMessage && !isReplyToServiceMessage;
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
  const contextualConfig = (groupConfig as TelegramGroupConfig | undefined)?.contextualActivation;
  const groupKey = historyKey ?? "";
  let contextualActivationHint: string | undefined;

  // When engaged via contextual activation, skip mention gating entirely and ask
  // the model whether to continue or disengage.
  if (isGroup && contextualConfig?.model) {
    const engagement = engagementStates.get(groupKey);
    if (engagement?.mode === "engaged") {
      const decision = await callTelegramContextualDecision({
        cfg,
        contextualConfig,
        groupHistories,
        groupKey,
        msg,
        rawBody,
        senderId: senderId || chatId,
        botName: primaryCtx.me?.first_name ?? primaryCtx.me?.username,
        allMedia,
      });
      if (decision.shouldProcess) {
        contextualActivationHint = decision.reason;
        // Stay engaged, skip mention gate — fall through to process
      } else {
        // Model disengaged — fall through to normal mention gating below
      }
    }
  }

  if (isGroup && requireMention && canDetectMention) {
    if (mentionGate.shouldSkip) {
      // Contextual activation (peeking): ask the decision model before skipping
      if (contextualConfig?.model) {
        const decision = await callTelegramContextualDecision({
          cfg,
          contextualConfig,
          groupHistories,
          groupKey,
          msg,
          rawBody,
          senderId: senderId || chatId,
          botName: primaryCtx.me?.first_name ?? primaryCtx.me?.username,
          allMedia,
        });
        if (decision.shouldProcess) {
          contextualActivationHint = decision.reason;
          logVerbose(`[contextual-activation] Telegram group ${chatId}: decided to participate`);
          // Fall through — treat as if mentioned
        } else {
          if (decision.error) {
            logVerbose(
              `[contextual-activation] Telegram group ${chatId}: error: ${decision.error}`,
            );
          }
          logger.info({ chatId, reason: "no-mention-contextual-skip" }, "skipping group message");
          recordPendingHistoryEntryIfEnabled({
            historyMap: groupHistories,
            historyKey: groupKey,
            limit: historyLimit,
            entry: historyKey
              ? {
                  sender: buildSenderLabel(msg, senderId || chatId),
                  body: rawBody,
                  timestamp: msg.date ? msg.date * 1000 : undefined,
                  messageId:
                    typeof msg.message_id === "number" ? String(msg.message_id) : undefined,
                  replyToId: historyReplyToId,
                  replyToBody: historyReplyToBody,
                  replyToSender: historyReplyToSender,
                }
              : null,
          });
          return null;
        }
      } else {
        logger.info({ chatId, reason: "no-mention" }, "skipping group message");
        recordPendingHistoryEntryIfEnabled({
          historyMap: groupHistories,
          historyKey: groupKey,
          limit: historyLimit,
          entry: historyKey
            ? {
                sender: buildSenderLabel(msg, senderId || chatId),
                body: rawBody,
                timestamp: msg.date ? msg.date * 1000 : undefined,
                messageId: typeof msg.message_id === "number" ? String(msg.message_id) : undefined,
                replyToId: historyReplyToId,
                replyToBody: historyReplyToBody,
                replyToSender: historyReplyToSender,
              }
            : null,
        });
        return null;
      }
    }
  }

  // Mention filter: when mentioned/replied to, optionally ask the model if a response is warranted
  if (
    isGroup &&
    !mentionGate.shouldSkip &&
    !contextualActivationHint &&
    contextualConfig?.model &&
    contextualConfig.mentionFilter?.enabled
  ) {
    const decision = await callTelegramMentionFilterDecision({
      cfg,
      contextualConfig,
      groupHistories,
      groupKey,
      msg,
      rawBody,
      senderId: senderId || chatId,
      botName: primaryCtx.me?.first_name ?? primaryCtx.me?.username,
      allMedia,
    });
    if (!decision.shouldProcess) {
      logVerbose(
        `[contextual-activation] Telegram group ${chatId}: mention filtered — ${decision.reason ?? "not warranted"}`,
      );
      recordPendingHistoryEntryIfEnabled({
        historyMap: groupHistories,
        historyKey: groupKey,
        limit: historyLimit,
        entry: historyKey
          ? {
              sender: buildSenderLabel(msg, senderId || chatId),
              body: rawBody,
              timestamp: msg.date ? msg.date * 1000 : undefined,
              messageId: typeof msg.message_id === "number" ? String(msg.message_id) : undefined,
              replyToId: historyReplyToId,
              replyToBody: historyReplyToBody,
              replyToSender: historyReplyToSender,
            }
          : null,
      });
      return null;
    }
  }

  if (!(await ensureConfiguredBindingReady())) {
    return null;
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
    getChat?: (chatId: number | string) => Promise<unknown>;
  };
  const reactionApi =
    typeof api.setMessageReaction === "function" ? api.setMessageReaction.bind(api) : null;
  const getChatApi = typeof api.getChat === "function" ? api.getChat.bind(api) : null;

  // Status Reactions controller (lifecycle reactions)
  const statusReactionsConfig = cfg.messages?.statusReactions;
  const statusReactionsEnabled =
    statusReactionsConfig?.enabled === true && Boolean(reactionApi) && shouldAckReaction();
  const resolvedStatusReactionEmojis = resolveTelegramStatusReactionEmojis({
    initialEmoji: ackReaction,
    overrides: statusReactionsConfig?.emojis,
  });
  const statusReactionVariantsByEmoji = buildTelegramStatusReactionVariants(
    resolvedStatusReactionEmojis,
  );
  let allowedStatusReactionEmojisPromise: Promise<Set<string> | null> | null = null;
  const statusReactionController: StatusReactionController | null =
    statusReactionsEnabled && msg.message_id
      ? createStatusReactionController({
          enabled: true,
          adapter: {
            setReaction: async (emoji: string) => {
              if (reactionApi) {
                if (!allowedStatusReactionEmojisPromise) {
                  allowedStatusReactionEmojisPromise = resolveTelegramAllowedEmojiReactions({
                    chat: msg.chat,
                    chatId,
                    getChat: getChatApi ?? undefined,
                  }).catch((err) => {
                    logVerbose(
                      `telegram status-reaction available_reactions lookup failed for chat ${chatId}: ${String(err)}`,
                    );
                    return null;
                  });
                }
                const allowedStatusReactionEmojis = await allowedStatusReactionEmojisPromise;
                const resolvedEmoji = resolveTelegramReactionVariant({
                  requestedEmoji: emoji,
                  variantsByRequestedEmoji: statusReactionVariantsByEmoji,
                  allowedEmojiReactions: allowedStatusReactionEmojis,
                });
                if (!resolvedEmoji) {
                  return;
                }
                await reactionApi(chatId, msg.message_id, [
                  { type: "emoji", emoji: resolvedEmoji },
                ]);
              }
            },
            // Telegram replaces atomically — no removeReaction needed
          },
          initialEmoji: ackReaction,
          emojis: resolvedStatusReactionEmojis,
          timing: statusReactionsConfig?.timing,
          onError: (err) => {
            logVerbose(`telegram status-reaction error for chat ${chatId}: ${String(err)}`);
          },
        })
      : null;

  // When status reactions are enabled, setQueued() replaces the simple ack reaction
  const ackReactionPromise = statusReactionController
    ? shouldAckReaction()
      ? Promise.resolve(statusReactionController.setQueued()).then(
          () => true,
          () => false,
        )
      : null
    : shouldAckReaction() && msg.message_id && reactionApi
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
  // Build forward annotation for reply target if it was itself a forwarded message (issue #9619)
  const replyForwardAnnotation = replyTarget?.forwardedFrom
    ? `[Forwarded from ${replyTarget.forwardedFrom.from}${
        replyTarget.forwardedFrom.date
          ? ` at ${new Date(replyTarget.forwardedFrom.date * 1000).toISOString()}`
          : ""
      }]\n`
    : "";
  const replySuffix = replyTarget
    ? replyTarget.kind === "quote"
      ? `\n\n[Quoting ${replyTarget.sender}${
          replyTarget.id ? ` id:${replyTarget.id}` : ""
        }]\n${replyForwardAnnotation}"${replyTarget.body}"\n[/Quoting]`
      : `\n\n[Replying to ${replyTarget.sender}${
          replyTarget.id ? ` id:${replyTarget.id}` : ""
        }]\n${replyForwardAnnotation}${replyTarget.body}\n[/Replying]`
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

  const { skillFilter, groupSystemPrompt } = resolveTelegramGroupPromptSettings({
    groupConfig,
    topicConfig,
  });
  const commandBody = normalizeCommandBody(rawBody, { botUsername });
  const inboundHistory =
    isGroup && historyKey && historyLimit > 0
      ? (groupHistories.get(historyKey) ?? []).map((entry) => ({
          sender: entry.sender,
          body: entry.body,
          timestamp: entry.timestamp,
        }))
      : undefined;
  const currentMediaForContext = stickerCacheHit ? [] : allMedia;
  const contextMedia = [...currentMediaForContext, ...replyMedia];
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
    GroupSystemPrompt:
      isGroup || (!isGroup && groupConfig)
        ? contextualActivationHint
          ? [
              groupSystemPrompt,
              `\nYou've been silently reading the group chat. You noticed: "${contextualActivationHint}". Join the conversation naturally, like a human group member chiming in.`,
            ]
              .filter(Boolean)
              .join("\n")
          : groupSystemPrompt
        : undefined,
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
    // Forward context from reply target (issue #9619: forward + comment bundling)
    ReplyToForwardedFrom: replyTarget?.forwardedFrom?.from,
    ReplyToForwardedFromType: replyTarget?.forwardedFrom?.fromType,
    ReplyToForwardedFromId: replyTarget?.forwardedFrom?.fromId,
    ReplyToForwardedFromUsername: replyTarget?.forwardedFrom?.fromUsername,
    ReplyToForwardedFromTitle: replyTarget?.forwardedFrom?.fromTitle,
    ReplyToForwardedDate: replyTarget?.forwardedFrom?.date
      ? replyTarget.forwardedFrom.date * 1000
      : undefined,
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
    // Filter out cached stickers from current-message media; reply media is still valid context.
    MediaPath: contextMedia.length > 0 ? contextMedia[0]?.path : undefined,
    MediaType: contextMedia.length > 0 ? contextMedia[0]?.contentType : undefined,
    MediaUrl: contextMedia.length > 0 ? contextMedia[0]?.path : undefined,
    MediaPaths: contextMedia.length > 0 ? contextMedia.map((m) => m.path) : undefined,
    MediaUrls: contextMedia.length > 0 ? contextMedia.map((m) => m.path) : undefined,
    MediaTypes:
      contextMedia.length > 0
        ? (contextMedia.map((m) => m.contentType).filter(Boolean) as string[])
        : undefined,
    Sticker: allMedia[0]?.stickerMetadata,
    StickerMediaIncluded: allMedia[0]?.stickerMetadata ? !stickerCacheHit : undefined,
    ...(locationData ? toLocationContext(locationData) : undefined),
    CommandAuthorized: commandAuthorized,
    // For groups: use resolved forum topic id; for DMs: use raw messageThreadId
    MessageThreadId: threadSpec.id,
    IsForum: isForum,
    // Originating channel for reply routing.
    OriginatingChannel: "telegram" as const,
    OriginatingTo: `telegram:${chatId}`,
  });

  const pinnedMainDmOwner = !isGroup
    ? resolvePinnedMainDmOwnerFromAllowlist({
        dmScope: cfg.session?.dmScope,
        allowFrom: dmAllowFrom,
        normalizeEntry: (entry) => normalizeAllowFrom([entry]).entries[0],
      })
    : null;

  await recordInboundSession({
    storePath,
    sessionKey: ctxPayload.SessionKey ?? sessionKey,
    ctx: ctxPayload,
    updateLastRoute: !isGroup
      ? {
          sessionKey: route.mainSessionKey,
          channel: "telegram",
          to: `telegram:${chatId}`,
          accountId: route.accountId,
          // Preserve DM topic threadId for replies (fixes #8891)
          threadId: dmThreadId != null ? String(dmThreadId) : undefined,
          mainDmOwnerPin:
            pinnedMainDmOwner && senderId
              ? {
                  ownerRecipient: pinnedMainDmOwner,
                  senderRecipient: senderId,
                  onSkip: ({ ownerRecipient, senderRecipient }) => {
                    logVerbose(
                      `telegram: skip main-session last route for ${senderRecipient} (pinned owner ${ownerRecipient})`,
                    );
                  },
                }
              : undefined,
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
    statusReactionController,
    accountId: account.accountId,
  };
};

async function callTelegramContextualDecision(params: {
  cfg: OpenClawConfig;
  contextualConfig: NonNullable<TelegramGroupConfig["contextualActivation"]>;
  groupHistories: Map<string, HistoryEntry[]>;
  groupKey: string;
  // oxlint-disable-next-line typescript/no-explicit-any
  msg: any;
  rawBody: string;
  senderId: string | number;
  botName?: string;
  allMedia?: TelegramMediaRef[];
}) {
  const existingHistory = params.groupHistories.get(params.groupKey) ?? [];
  const recentMessages = existingHistory.map((h) => ({
    sender: h.sender,
    body: h.body,
    timestamp: h.timestamp,
    messageId: h.messageId,
    replyToId: h.replyToId,
    replyToBody: h.replyToBody,
    replyToSender: h.replyToSender,
  }));
  const imagePaths = (params.allMedia ?? [])
    .filter((m) => m.path && m.contentType?.startsWith("image/"))
    .map((m) => m.path);
  // Extract reply context from the Telegram message
  const replyTo = params.msg.reply_to_message;
  const replyToId = replyTo?.message_id != null ? String(replyTo.message_id) : undefined;
  const replyToBody =
    replyTo?.text ??
    replyTo?.caption ??
    (replyTo?.photo
      ? "[image]"
      : replyTo?.sticker
        ? formatStickerReplyBody(replyTo.sticker)
        : replyTo?.video
          ? "[video]"
          : replyTo?.voice
            ? "[voice message]"
            : replyTo?.animation
              ? "[GIF]"
              : replyTo?.document
                ? `[file: ${replyTo.document?.file_name ?? "unknown"}]`
                : undefined);
  const replyToSender = replyTo
    ? replyTo.from?.first_name
      ? `${replyTo.from.first_name}${replyTo.from.last_name ? ` ${replyTo.from.last_name}` : ""}`
      : (replyTo.from?.username ?? undefined)
    : undefined;
  return shouldParticipateInGroup({
    cfg: params.cfg,
    config: params.contextualConfig,
    recentMessages,
    currentMessage: {
      sender: buildSenderLabel(params.msg as never, params.senderId),
      body: params.rawBody,
      timestamp: params.msg.date ? params.msg.date * 1000 : undefined,
      imagePaths: imagePaths.length > 0 ? imagePaths : undefined,
      messageId:
        typeof params.msg.message_id === "number" ? String(params.msg.message_id) : undefined,
      replyToId,
      replyToBody,
      replyToSender,
    },
    groupKey: params.groupKey,
    botName: params.botName,
  });
}

async function callTelegramMentionFilterDecision(params: {
  cfg: OpenClawConfig;
  contextualConfig: NonNullable<TelegramGroupConfig["contextualActivation"]>;
  groupHistories: Map<string, HistoryEntry[]>;
  groupKey: string;
  // oxlint-disable-next-line typescript/no-explicit-any
  msg: any;
  rawBody: string;
  senderId: string | number;
  botName?: string;
  allMedia?: TelegramMediaRef[];
}) {
  const existingHistory = params.groupHistories.get(params.groupKey) ?? [];
  const recentMessages = existingHistory.map((h) => ({
    sender: h.sender,
    body: h.body,
    timestamp: h.timestamp,
    messageId: h.messageId,
    replyToId: h.replyToId,
    replyToBody: h.replyToBody,
    replyToSender: h.replyToSender,
  }));
  const imagePaths = (params.allMedia ?? [])
    .filter((m) => m.path && m.contentType?.startsWith("image/"))
    .map((m) => m.path);
  const replyTo = params.msg.reply_to_message;
  const replyToId = replyTo?.message_id != null ? String(replyTo.message_id) : undefined;
  const replyToBody =
    replyTo?.text ??
    replyTo?.caption ??
    (replyTo?.photo
      ? "[image]"
      : replyTo?.sticker
        ? formatStickerReplyBody(replyTo.sticker)
        : replyTo?.video
          ? "[video]"
          : replyTo?.voice
            ? "[voice message]"
            : replyTo?.animation
              ? "[GIF]"
              : replyTo?.document
                ? `[file: ${replyTo.document?.file_name ?? "unknown"}]`
                : undefined);
  const replyToSender = replyTo
    ? replyTo.from?.first_name
      ? `${replyTo.from.first_name}${replyTo.from.last_name ? ` ${replyTo.from.last_name}` : ""}`
      : (replyTo.from?.username ?? undefined)
    : undefined;
  return shouldRespondToMention({
    cfg: params.cfg,
    config: params.contextualConfig,
    recentMessages,
    currentMessage: {
      sender: buildSenderLabel(params.msg as never, params.senderId),
      body: params.rawBody,
      timestamp: params.msg.date ? params.msg.date * 1000 : undefined,
      imagePaths: imagePaths.length > 0 ? imagePaths : undefined,
      messageId:
        typeof params.msg.message_id === "number" ? String(params.msg.message_id) : undefined,
      replyToId,
      replyToBody,
      replyToSender,
    },
    groupKey: params.groupKey,
    botName: params.botName,
  });
}

export type TelegramMessageContext = NonNullable<
  Awaited<ReturnType<typeof buildTelegramMessageContext>>
>;
