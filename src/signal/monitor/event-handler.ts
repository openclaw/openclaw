import fs from "node:fs/promises";
import path from "node:path";
import type {
  SignalEventHandlerDeps,
  SignalQuote,
  SignalReceivePayload,
  SignalSticker,
} from "./event-handler.types.js";
import { resolveHumanDelayConfig } from "../../agents/identity.js";
import { hasControlCommand } from "../../auto-reply/command-detection.js";
import { dispatchInboundMessage } from "../../auto-reply/dispatch.js";
import {
  formatInboundEnvelope,
  formatInboundFromLabel,
  resolveEnvelopeFormatOptions,
} from "../../auto-reply/envelope.js";
import {
  createInboundDebouncer,
  resolveInboundDebounceMs,
} from "../../auto-reply/inbound-debounce.js";
import {
  buildPendingHistoryContextFromMap,
  clearHistoryEntriesIfEnabled,
  recordPendingHistoryEntryIfEnabled,
} from "../../auto-reply/reply/history.js";
import { finalizeInboundContext } from "../../auto-reply/reply/inbound-context.js";
import { buildMentionRegexes, matchesMentionPatterns } from "../../auto-reply/reply/mentions.js";
import { createReplyDispatcherWithTyping } from "../../auto-reply/reply/reply-dispatcher.js";
import { resolveControlCommandGate } from "../../channels/command-gating.js";
import { logInboundDrop, logTypingFailure } from "../../channels/logging.js";
import { resolveMentionGatingWithBypass } from "../../channels/mention-gating.js";
import { normalizeSignalMessagingTarget } from "../../channels/plugins/normalize/signal.js";
import { createReplyPrefixOptions } from "../../channels/reply-prefix.js";
import { recordInboundSession } from "../../channels/session.js";
import { createTypingCallbacks } from "../../channels/typing.js";
import { resolveChannelGroupRequireMention } from "../../config/group-policy.js";
import { readSessionUpdatedAt, resolveStorePath } from "../../config/sessions.js";
import { danger, logVerbose, shouldLogVerbose } from "../../globals.js";
import { enqueueSystemEvent } from "../../infra/system-events.js";
import { saveToAgentCache } from "../../media/agent-cache.js";
import { mediaKindFromMime } from "../../media/constants.js";
import { buildPairingReply } from "../../pairing/pairing-messages.js";
import {
  readChannelAllowFromStore,
  upsertChannelPairingRequest,
} from "../../pairing/pairing-store.js";
import { resolveAgentRoute } from "../../routing/resolve-route.js";
import { normalizeE164, resolveConfigDir } from "../../utils.js";
import {
  formatSignalPairingIdLine,
  formatSignalSenderDisplay,
  formatSignalSenderId,
  isSignalSenderAllowed,
  resolveSignalPeerId,
  resolveSignalRecipient,
  resolveSignalSender,
} from "../identity.js";
import { sendMessageSignal, sendReadReceiptSignal, sendTypingSignal } from "../send.js";
import { renderSignalMentions } from "./mentions.js";

// === 持久化 mediaCache ===
type MediaCacheEntry = { path: string; contentType?: string; savedAt: number };
type MediaCacheData = Record<string, MediaCacheEntry>;

const MEDIA_CACHE_FILE = path.join(resolveConfigDir(), "media", "signal-media-cache.json");
const MEDIA_CACHE_MAX_SIZE = 50000; // 最多緩存 500 條
const MEDIA_CACHE_MAX_AGE_MS = 3650 * 24 * 60 * 60 * 1000; // 3650 天過期

let mediaCacheData: MediaCacheData = {};
let mediaCacheLoaded = false;

async function loadMediaCache(): Promise<void> {
  if (mediaCacheLoaded) return;
  try {
    const content = await fs.readFile(MEDIA_CACHE_FILE, "utf-8");
    mediaCacheData = JSON.parse(content) as MediaCacheData;
    // 清理過期條目
    const now = Date.now();
    for (const [key, entry] of Object.entries(mediaCacheData)) {
      if (now - entry.savedAt > MEDIA_CACHE_MAX_AGE_MS) {
        delete mediaCacheData[key];
      }
    }
    logVerbose(`signal media cache loaded: ${Object.keys(mediaCacheData).length} entries`);
  } catch {
    mediaCacheData = {};
  }
  mediaCacheLoaded = true;
}

async function saveMediaCache(): Promise<void> {
  try {
    await fs.mkdir(path.dirname(MEDIA_CACHE_FILE), { recursive: true });
    await fs.writeFile(MEDIA_CACHE_FILE, JSON.stringify(mediaCacheData, null, 2));
  } catch (err) {
    logVerbose(`signal media cache save failed: ${String(err)}`);
  }
}

function cacheMediaPersistent(
  timestamp: number | undefined,
  media: { path: string; contentType?: string },
) {
  if (!timestamp || !media.path) return;
  const key = String(timestamp);

  // 如果緩存太大，清理最舊的條目
  const keys = Object.keys(mediaCacheData);
  if (keys.length >= MEDIA_CACHE_MAX_SIZE) {
    // 按 savedAt 排序，刪除最舊的 100 條
    const sorted = keys.sort(
      (a, b) => (mediaCacheData[a]?.savedAt ?? 0) - (mediaCacheData[b]?.savedAt ?? 0),
    );
    for (let i = 0; i < 100 && i < sorted.length; i++) {
      const oldKey = sorted[i];
      if (oldKey) delete mediaCacheData[oldKey];
    }
  }

  mediaCacheData[key] = { path: media.path, contentType: media.contentType, savedAt: Date.now() };
  logVerbose(`signal media cached (persistent): ts=${timestamp} path=${media.path}`);
  // 異步保存，不阻塞
  void saveMediaCache();
}

function getCachedMediaPersistent(
  timestamp: number | undefined,
): { path: string; contentType?: string } | null {
  if (!timestamp) return null;
  const entry = mediaCacheData[String(timestamp)];
  if (entry) {
    logVerbose(`signal media cache hit (persistent): ts=${timestamp} path=${entry.path}`);
    return { path: entry.path, contentType: entry.contentType };
  }
  return null;
}

export function createSignalEventHandler(deps: SignalEventHandlerDeps) {
  const inboundDebounceMs = resolveInboundDebounceMs({ cfg: deps.cfg, channel: "signal" });

  // 啟動時載入持久化緩存
  void loadMediaCache();

  // 兼容舊的函數名
  function cacheMedia(
    timestamp: number | undefined,
    media: { path: string; contentType?: string },
  ) {
    cacheMediaPersistent(timestamp, media);
  }

  function getCachedMedia(
    timestamp: number | undefined,
  ): { path: string; contentType?: string } | null {
    return getCachedMediaPersistent(timestamp);
  }

  // 獲取引用消息的附件（圖片/Sticker）
  async function fetchQuotedAttachment(params: {
    quote: SignalQuote;
    senderRecipient: string;
    groupId?: string;
  }): Promise<{ path: string; contentType?: string } | null> {
    const { quote, senderRecipient, groupId } = params;
    const firstAttachment = quote.attachments?.[0];
    if (!firstAttachment?.id) {
      return null;
    }
    try {
      return await deps.fetchAttachment({
        baseUrl: deps.baseUrl,
        account: deps.account,
        attachment: {
          id: firstAttachment.id,
          contentType: firstAttachment.contentType,
          filename: firstAttachment.filename,
          size: firstAttachment.size,
        },
        sender: quote.author ?? quote.authorNumber ?? senderRecipient,
        groupId,
        maxBytes: deps.mediaMaxBytes,
      });
    } catch (err) {
      logVerbose(`quoted attachment fetch failed: ${String(err)}`);
      return null;
    }
  }

  // 獲取 Sticker 圖片
  async function fetchSticker(params: {
    sticker: SignalSticker;
    senderRecipient: string;
    groupId?: string;
  }): Promise<{ path: string; contentType?: string } | null> {
    const { sticker, senderRecipient, groupId } = params;
    // 記錄 sticker 數據結構以便調試
    logVerbose(`sticker data: ${JSON.stringify(sticker)}`);
    if (!sticker.attachment?.id) {
      logVerbose(
        `sticker has no attachment.id, packId=${sticker.packId}, stickerId=${sticker.stickerId}`,
      );
      // 嘗試用 getSticker API（需要 signal-cli 支持）
      if (sticker.packId && typeof sticker.stickerId === "number") {
        try {
          return (
            (await deps.fetchSticker?.({
              baseUrl: deps.baseUrl,
              account: deps.account,
              packId: sticker.packId,
              stickerId: sticker.stickerId,
              maxBytes: deps.mediaMaxBytes,
            })) ?? null
          );
        } catch (err) {
          logVerbose(`sticker fetch via packId failed: ${String(err)}`);
        }
      }
      return null;
    }
    try {
      return await deps.fetchAttachment({
        baseUrl: deps.baseUrl,
        account: deps.account,
        attachment: {
          id: sticker.attachment.id,
          contentType: sticker.attachment.contentType ?? sticker.contentType,
          size: sticker.attachment.size,
        },
        sender: senderRecipient,
        groupId,
        maxBytes: deps.mediaMaxBytes,
      });
    } catch (err) {
      logVerbose(`sticker fetch failed: ${String(err)}`);
      return null;
    }
  }

  type SignalInboundEntry = {
    senderName: string;
    senderDisplay: string;
    senderRecipient: string;
    senderPeerId: string;
    groupId?: string;
    groupName?: string;
    isGroup: boolean;
    bodyText: string;
    timestamp?: number;
    messageId?: string;
    mediaPath?: string;
    mediaType?: string;
    commandAuthorized: boolean;
    wasMentioned?: boolean;
  };

  async function handleSignalInboundMessage(entry: SignalInboundEntry) {
    const fromLabel = formatInboundFromLabel({
      isGroup: entry.isGroup,
      groupLabel: entry.groupName ?? undefined,
      groupId: entry.groupId ?? "unknown",
      groupFallback: "Group",
      directLabel: entry.senderName,
      directId: entry.senderDisplay,
    });
    const route = resolveAgentRoute({
      cfg: deps.cfg,
      channel: "signal",
      accountId: deps.accountId,
      peer: {
        kind: entry.isGroup ? "group" : "direct",
        id: entry.isGroup ? (entry.groupId ?? "unknown") : entry.senderPeerId,
      },
    });
    const storePath = resolveStorePath(deps.cfg.session?.store, {
      agentId: route.agentId,
    });
    const envelopeOptions = resolveEnvelopeFormatOptions(deps.cfg);
    const previousTimestamp = readSessionUpdatedAt({
      storePath,
      sessionKey: route.sessionKey,
    });
    const body = formatInboundEnvelope({
      channel: "Signal",
      from: fromLabel,
      timestamp: entry.timestamp ?? undefined,
      body: entry.bodyText,
      chatType: entry.isGroup ? "group" : "direct",
      sender: { name: entry.senderName, id: entry.senderDisplay },
      previousTimestamp,
      envelope: envelopeOptions,
    });
    let combinedBody = body;
    const historyKey = entry.isGroup ? String(entry.groupId ?? "unknown") : undefined;
    if (entry.isGroup && historyKey) {
      combinedBody = buildPendingHistoryContextFromMap({
        historyMap: deps.groupHistories,
        historyKey,
        limit: deps.historyLimit,
        currentMessage: combinedBody,
        formatEntry: (historyEntry) =>
          formatInboundEnvelope({
            channel: "Signal",
            from: fromLabel,
            timestamp: historyEntry.timestamp,
            body: `${historyEntry.body}${
              historyEntry.messageId ? ` [id:${historyEntry.messageId}]` : ""
            }`,
            chatType: "group",
            senderLabel: historyEntry.sender,
            envelope: envelopeOptions,
          }),
      });
    }
    const signalToRaw = entry.isGroup
      ? `group:${entry.groupId}`
      : `signal:${entry.senderRecipient}`;
    const signalTo = normalizeSignalMessagingTarget(signalToRaw) ?? signalToRaw;
    const inboundHistory =
      entry.isGroup && historyKey && deps.historyLimit > 0
        ? (deps.groupHistories.get(historyKey) ?? []).map((historyEntry) => ({
            sender: historyEntry.sender,
            body: historyEntry.body,
            timestamp: historyEntry.timestamp,
          }))
        : undefined;
    const ctxPayload = finalizeInboundContext({
      Body: combinedBody,
      BodyForAgent: entry.bodyText,
      InboundHistory: inboundHistory,
      RawBody: entry.bodyText,
      CommandBody: entry.bodyText,
      From: entry.isGroup
        ? `group:${entry.groupId ?? "unknown"}`
        : `signal:${entry.senderRecipient}`,
      To: signalTo,
      SessionKey: route.sessionKey,
      AccountId: route.accountId,
      ChatType: entry.isGroup ? "group" : "direct",
      ConversationLabel: fromLabel,
      GroupSubject: entry.isGroup ? (entry.groupName ?? undefined) : undefined,
      SenderName: entry.senderName,
      SenderId: entry.senderDisplay,
      Provider: "signal" as const,
      Surface: "signal" as const,
      MessageSid: entry.messageId,
      Timestamp: entry.timestamp ?? undefined,
      MediaPath: entry.mediaPath,
      MediaType: entry.mediaType,
      MediaUrl: entry.mediaPath,
      WasMentioned: entry.isGroup ? entry.wasMentioned === true : undefined,
      CommandAuthorized: entry.commandAuthorized,
      OriginatingChannel: "signal" as const,
      OriginatingTo: signalTo,
    });

    await recordInboundSession({
      storePath,
      sessionKey: ctxPayload.SessionKey ?? route.sessionKey,
      ctx: ctxPayload,
      updateLastRoute: !entry.isGroup
        ? {
            sessionKey: route.mainSessionKey,
            channel: "signal",
            to: entry.senderRecipient,
            accountId: route.accountId,
          }
        : undefined,
      onRecordError: (err) => {
        logVerbose(`signal: failed updating session meta: ${String(err)}`);
      },
    });

    if (shouldLogVerbose()) {
      const preview = body.slice(0, 200).replace(/\\n/g, "\\\\n");
      logVerbose(`signal inbound: from=${ctxPayload.From} len=${body.length} preview="${preview}"`);
    }

    const { onModelSelected, ...prefixOptions } = createReplyPrefixOptions({
      cfg: deps.cfg,
      agentId: route.agentId,
      channel: "signal",
      accountId: route.accountId,
    });

    const typingCallbacks = createTypingCallbacks({
      start: async () => {
        if (!ctxPayload.To) {
          return;
        }
        await sendTypingSignal(ctxPayload.To, {
          baseUrl: deps.baseUrl,
          account: deps.account,
          accountId: deps.accountId,
        });
      },
      onStartError: (err) => {
        logTypingFailure({
          log: logVerbose,
          channel: "signal",
          target: ctxPayload.To ?? undefined,
          error: err,
        });
      },
    });

    const { dispatcher, replyOptions, markDispatchIdle } = createReplyDispatcherWithTyping({
      ...prefixOptions,
      humanDelay: resolveHumanDelayConfig(deps.cfg, route.agentId),
      deliver: async (payload) => {
        await deps.deliverReplies({
          replies: [payload],
          target: ctxPayload.To,
          baseUrl: deps.baseUrl,
          account: deps.account,
          accountId: deps.accountId,
          runtime: deps.runtime,
          maxBytes: deps.mediaMaxBytes,
          textLimit: deps.textLimit,
        });
      },
      onError: (err, info) => {
        deps.runtime.error?.(danger(`signal ${info.kind} reply failed: ${String(err)}`));
      },
      onReplyStart: typingCallbacks.onReplyStart,
    });

    const { queuedFinal } = await dispatchInboundMessage({
      ctx: ctxPayload,
      cfg: deps.cfg,
      dispatcher,
      replyOptions: {
        ...replyOptions,
        disableBlockStreaming:
          typeof deps.blockStreaming === "boolean" ? !deps.blockStreaming : undefined,
        onModelSelected,
      },
    });
    markDispatchIdle();
    if (!queuedFinal) {
      if (entry.isGroup && historyKey) {
        clearHistoryEntriesIfEnabled({
          historyMap: deps.groupHistories,
          historyKey,
          limit: deps.historyLimit,
        });
      }
      return;
    }
    if (entry.isGroup && historyKey) {
      clearHistoryEntriesIfEnabled({
        historyMap: deps.groupHistories,
        historyKey,
        limit: deps.historyLimit,
      });
    }
  }

  const inboundDebouncer = createInboundDebouncer<SignalInboundEntry>({
    debounceMs: inboundDebounceMs,
    buildKey: (entry) => {
      const conversationId = entry.isGroup ? (entry.groupId ?? "unknown") : entry.senderPeerId;
      if (!conversationId || !entry.senderPeerId) {
        return null;
      }
      return `signal:${deps.accountId}:${conversationId}:${entry.senderPeerId}`;
    },
    shouldDebounce: (entry) => {
      if (!entry.bodyText.trim()) {
        return false;
      }
      if (entry.mediaPath || entry.mediaType) {
        return false;
      }
      return !hasControlCommand(entry.bodyText, deps.cfg);
    },
    onFlush: async (entries) => {
      const last = entries.at(-1);
      if (!last) {
        return;
      }
      if (entries.length === 1) {
        await handleSignalInboundMessage(last);
        return;
      }
      const combinedText = entries
        .map((entry) => entry.bodyText)
        .filter(Boolean)
        .join("\\n");
      if (!combinedText.trim()) {
        return;
      }
      await handleSignalInboundMessage({
        ...last,
        bodyText: combinedText,
        mediaPath: undefined,
        mediaType: undefined,
      });
    },
    onError: (err) => {
      deps.runtime.error?.(`signal debounce flush failed: ${String(err)}`);
    },
  });

  return async (event: { event?: string; data?: string }) => {
    if (event.event !== "receive" || !event.data) {
      return;
    }

    let payload: SignalReceivePayload | null = null;
    try {
      payload = JSON.parse(event.data) as SignalReceivePayload;
    } catch (err) {
      deps.runtime.error?.(`failed to parse event: ${String(err)}`);
      return;
    }
    if (payload?.exception?.message) {
      deps.runtime.error?.(`receive exception: ${payload.exception.message}`);
    }
    const envelope = payload?.envelope;
    if (!envelope) {
      return;
    }
    if (envelope.syncMessage) {
      return;
    }

    const sender = resolveSignalSender(envelope);
    if (!sender) {
      return;
    }
    if (deps.account && sender.kind === "phone") {
      if (sender.e164 === normalizeE164(deps.account)) {
        return;
      }
    }

    const dataMessage = envelope.dataMessage ?? envelope.editMessage?.dataMessage;
    const reaction = deps.isSignalReactionMessage(envelope.reactionMessage)
      ? envelope.reactionMessage
      : deps.isSignalReactionMessage(dataMessage?.reaction)
        ? dataMessage?.reaction
        : null;

    // Replace ￼ (object replacement character) with @uuid or @phone from mentions
    // Signal encodes mentions as the object replacement character; hydrate them from metadata first.
    const rawMessage = dataMessage?.message ?? "";
    const normalizedMessage = renderSignalMentions(rawMessage, dataMessage?.mentions);
    const messageText = normalizedMessage.trim();

    const quoteText = dataMessage?.quote?.text?.trim() ?? "";
    const hasBodyContent =
      Boolean(messageText || quoteText) || Boolean(!reaction && dataMessage?.attachments?.length);

    if (reaction && !hasBodyContent) {
      if (reaction.isRemove) {
        return;
      } // Ignore reaction removals
      const emojiLabel = reaction.emoji?.trim() || "emoji";
      const senderDisplay = formatSignalSenderDisplay(sender);
      const senderName = envelope.sourceName ?? senderDisplay;
      logVerbose(`signal reaction: ${emojiLabel} from ${senderName}`);
      const targets = deps.resolveSignalReactionTargets(reaction);
      const shouldNotify = deps.shouldEmitSignalReactionNotification({
        mode: deps.reactionMode,
        account: deps.account,
        targets,
        sender,
        allowlist: deps.reactionAllowlist,
      });
      if (!shouldNotify) {
        return;
      }

      const groupId = reaction.groupInfo?.groupId ?? undefined;
      const groupName = reaction.groupInfo?.groupName ?? undefined;
      const isGroup = Boolean(groupId);
      const senderPeerId = resolveSignalPeerId(sender);
      const route = resolveAgentRoute({
        cfg: deps.cfg,
        channel: "signal",
        accountId: deps.accountId,
        peer: {
          kind: isGroup ? "group" : "direct",
          id: isGroup ? (groupId ?? "unknown") : senderPeerId,
        },
      });
      const groupLabel = isGroup ? `${groupName ?? "Signal Group"} id:${groupId}` : undefined;
      const messageId = reaction.targetSentTimestamp
        ? String(reaction.targetSentTimestamp)
        : "unknown";
      const text = deps.buildSignalReactionSystemEventText({
        emojiLabel,
        actorLabel: senderName,
        messageId,
        targetLabel: targets[0]?.display,
        groupLabel,
      });
      const senderId = formatSignalSenderId(sender);
      const contextKey = [
        "signal",
        "reaction",
        "added",
        messageId,
        senderId,
        emojiLabel,
        groupId ?? "",
      ]
        .filter(Boolean)
        .join(":");
      enqueueSystemEvent(text, { sessionKey: route.sessionKey, contextKey });
      return;
    }
    if (!dataMessage) {
      return;
    }

    const senderDisplay = formatSignalSenderDisplay(sender);
    const senderRecipient = resolveSignalRecipient(sender);
    const senderPeerId = resolveSignalPeerId(sender);
    const senderAllowId = formatSignalSenderId(sender);
    if (!senderRecipient) {
      return;
    }
    const senderIdLine = formatSignalPairingIdLine(sender);
    const groupId = dataMessage.groupInfo?.groupId ?? undefined;
    const groupName = dataMessage.groupInfo?.groupName ?? undefined;
    const isGroup = Boolean(groupId);
    const storeAllowFrom = await readChannelAllowFromStore("signal").catch(() => []);
    const effectiveDmAllow = [...deps.allowFrom, ...storeAllowFrom];
    const effectiveGroupAllow = [...deps.groupAllowFrom, ...storeAllowFrom];
    const dmAllowed =
      deps.dmPolicy === "open" ? true : isSignalSenderAllowed(sender, effectiveDmAllow);

    if (!isGroup) {
      if (deps.dmPolicy === "disabled") {
        return;
      }
      if (!dmAllowed) {
        if (deps.dmPolicy === "pairing") {
          const senderId = senderAllowId;
          const { code, created } = await upsertChannelPairingRequest({
            channel: "signal",
            id: senderId,
            meta: { name: envelope.sourceName ?? undefined },
          });
          if (created) {
            logVerbose(`signal pairing request sender=${senderId}`);
            try {
              await sendMessageSignal(
                `signal:${senderRecipient}`,
                buildPairingReply({
                  channel: "signal",
                  idLine: senderIdLine,
                  code,
                }),
                {
                  baseUrl: deps.baseUrl,
                  account: deps.account,
                  maxBytes: deps.mediaMaxBytes,
                  accountId: deps.accountId,
                },
              );
            } catch (err) {
              logVerbose(`signal pairing reply failed for ${senderId}: ${String(err)}`);
            }
          }
        } else {
          logVerbose(`Blocked signal sender ${senderDisplay} (dmPolicy=${deps.dmPolicy})`);
        }
        return;
      }
    }
    if (isGroup && deps.groupPolicy === "disabled") {
      logVerbose("Blocked signal group message (groupPolicy: disabled)");
      return;
    }
    if (isGroup && deps.groupPolicy === "allowlist") {
      if (effectiveGroupAllow.length === 0) {
        logVerbose("Blocked signal group message (groupPolicy: allowlist, no groupAllowFrom)");
        return;
      }
      if (!isSignalSenderAllowed(sender, effectiveGroupAllow)) {
        logVerbose(`Blocked signal group sender ${senderDisplay} (not in groupAllowFrom)`);
        return;
      }
    }

    // === 先緩存群組附件（在 requireMention 檢查之前）===
    // 這樣即使消息因為沒有 @mention 被 block，附件也會被保存
    const hasAttachmentOrSticker = Boolean(dataMessage.attachments?.length || dataMessage.sticker);
    if (isGroup && hasAttachmentOrSticker && !deps.ignoreAttachments) {
      // 先獲取 agentId 用於緩存
      const routeForCache = resolveAgentRoute({
        cfg: deps.cfg,
        channel: "signal",
        accountId: deps.accountId,
        peer: { kind: "group", id: groupId ?? "unknown" },
      });

      // 緩存普通附件
      const firstAtt = dataMessage.attachments?.[0];
      if (firstAtt?.id) {
        try {
          const fetched = await deps.fetchAttachment({
            baseUrl: deps.baseUrl,
            account: deps.account,
            attachment: firstAtt,
            sender: senderRecipient,
            groupId,
            maxBytes: deps.mediaMaxBytes,
          });
          if (fetched) {
            // 保存到 agent cache（獨立存儲，不受 TTL 影響）
            const buffer = await fs.readFile(fetched.path);
            await saveToAgentCache({
              agentId: routeForCache.agentId,
              buffer,
              contentType: fetched.contentType ?? firstAtt.contentType ?? undefined,
              channel: "signal",
              groupId,
              senderId: senderAllowId,
              timestamp: dataMessage.timestamp,
              originalFilename: firstAtt.filename ?? undefined,
            });
            // 同時更新 media cache，讓引用消息可以找到
            cacheMedia(dataMessage.timestamp, {
              path: fetched.path,
              contentType: fetched.contentType ?? firstAtt.contentType ?? undefined,
            });
            logVerbose(`signal: pre-cached attachment for group ${groupId} from ${senderDisplay}`);
          }
        } catch (err) {
          logVerbose(`signal: pre-cache attachment failed: ${String(err)}`);
        }
      }

      // 緩存 Sticker
      const stk = dataMessage.sticker;
      if (stk) {
        try {
          const stickerFetched = await fetchSticker({ sticker: stk, senderRecipient, groupId });
          if (stickerFetched) {
            const buffer = await fs.readFile(stickerFetched.path);
            await saveToAgentCache({
              agentId: routeForCache.agentId,
              buffer,
              contentType: stickerFetched.contentType ?? stk.contentType ?? "image/webp",
              channel: "signal",
              groupId,
              senderId: senderAllowId,
              timestamp: dataMessage.timestamp,
            });
            // 同時更新 media cache，讓引用消息可以找到
            cacheMedia(dataMessage.timestamp, {
              path: stickerFetched.path,
              contentType: stickerFetched.contentType ?? stk.contentType ?? "image/webp",
            });
            logVerbose(`signal: pre-cached sticker for group ${groupId} from ${senderDisplay}`);
          }
        } catch (err) {
          logVerbose(`signal: pre-cache sticker failed: ${String(err)}`);
        }
      }
    }

    // Check requireMention for group messages
    if (isGroup && deps.requireMention) {
      const mentions = dataMessage.mentions ?? [];
      const botAccount = deps.account?.replace(/^\+/, "") ?? "";
      const botAccountId = deps.accountId ?? "";
      logVerbose(
        `[requireMention] mentions=${JSON.stringify(mentions)}, botAccount=${botAccount}, botAccountId=${botAccountId}`,
      );
      const isMentioned = mentions.some((m) => {
        // Check by phone number
        const mentionNumber = m.number?.replace(/^\+/, "") ?? "";
        if (mentionNumber && mentionNumber === botAccount) return true;
        // Check by UUID (signal-cli may use uuid instead of number)
        const mentionUuid = m.uuid ?? "";
        if (mentionUuid && mentionUuid === botAccountId) return true;
        return false;
      });
      if (!isMentioned) {
        logVerbose(`Blocked signal group message (requireMention, not mentioned)`);
        return;
      }
      logVerbose(`[requireMention] mention detected, proceeding`);
    }

    const useAccessGroups = deps.cfg.commands?.useAccessGroups !== false;
    const ownerAllowedForCommands = isSignalSenderAllowed(sender, effectiveDmAllow);
    const groupAllowedForCommands = isSignalSenderAllowed(sender, effectiveGroupAllow);
    // Strip U+FFFC (Object Replacement Character) used by Signal for mention placeholders
    // so commands like "@bot /new" are correctly detected as "/new"
    const textForCommandDetection = messageText?.replace(/\uFFFC/g, "").trim() ?? "";
    const hasControlCommandInMessage = hasControlCommand(textForCommandDetection, deps.cfg);
    const commandGate = resolveControlCommandGate({
      useAccessGroups,
      authorizers: [
        { configured: effectiveDmAllow.length > 0, allowed: ownerAllowedForCommands },
        { configured: effectiveGroupAllow.length > 0, allowed: groupAllowedForCommands },
      ],
      allowTextCommands: true,
      hasControlCommand: hasControlCommandInMessage,
    });
    const commandAuthorized = isGroup ? commandGate.commandAuthorized : dmAllowed;
    if (isGroup && commandGate.shouldBlock) {
      logInboundDrop({
        log: logVerbose,
        channel: "signal",
        reason: "control command (unauthorized)",
        target: senderDisplay,
      });
      return;
    }

    const route = resolveAgentRoute({
      cfg: deps.cfg,
      channel: "signal",
      accountId: deps.accountId,
      peer: {
        kind: isGroup ? "group" : "direct",
        id: isGroup ? (groupId ?? "unknown") : senderPeerId,
      },
    });
    const mentionRegexes = buildMentionRegexes(deps.cfg, route.agentId);
    const wasMentioned = isGroup && matchesMentionPatterns(messageText, mentionRegexes);
    const requireMention =
      isGroup &&
      resolveChannelGroupRequireMention({
        cfg: deps.cfg,
        channel: "signal",
        groupId,
        accountId: deps.accountId,
      });
    const canDetectMention = mentionRegexes.length > 0;
    const mentionGate = resolveMentionGatingWithBypass({
      isGroup,
      requireMention: Boolean(requireMention),
      canDetectMention,
      wasMentioned,
      implicitMention: false,
      hasAnyMention: false,
      allowTextCommands: true,
      hasControlCommand: hasControlCommandInMessage,
      commandAuthorized,
    });
    const effectiveWasMentioned = mentionGate.effectiveWasMentioned;
    if (isGroup && requireMention && canDetectMention && mentionGate.shouldSkip) {
      logInboundDrop({
        log: logVerbose,
        channel: "signal",
        reason: "no mention",
        target: senderDisplay,
      });
      const quoteText = dataMessage.quote?.text?.trim() || "";
      const pendingPlaceholder = (() => {
        if (!dataMessage.attachments?.length) {
          return "";
        }
        // When we're skipping a message we intentionally avoid downloading attachments.
        // Still record a useful placeholder for pending-history context.
        if (deps.ignoreAttachments) {
          return "<media:attachment>";
        }
        const firstContentType = dataMessage.attachments?.[0]?.contentType;
        const pendingKind = mediaKindFromMime(firstContentType ?? undefined);
        return pendingKind ? `<media:${pendingKind}>` : "<media:attachment>";
      })();
      const pendingBodyText = messageText || pendingPlaceholder || quoteText;
      const historyKey = groupId ?? "unknown";
      recordPendingHistoryEntryIfEnabled({
        historyMap: deps.groupHistories,
        historyKey,
        limit: deps.historyLimit,
        entry: {
          sender: envelope.sourceName ?? senderDisplay,
          body: pendingBodyText,
          timestamp: envelope.timestamp ?? undefined,
          messageId:
            typeof envelope.timestamp === "number" ? String(envelope.timestamp) : undefined,
        },
      });
      return;
    }

    let mediaPath: string | undefined;
    let mediaType: string | undefined;
    let placeholder = "";

    // === 處理普通附件 ===
    const firstAttachment = dataMessage.attachments?.[0];
    if (firstAttachment?.id && !deps.ignoreAttachments) {
      try {
        const fetched = await deps.fetchAttachment({
          baseUrl: deps.baseUrl,
          account: deps.account,
          attachment: firstAttachment,
          sender: senderRecipient,
          groupId,
          maxBytes: deps.mediaMaxBytes,
        });
        if (fetched) {
          mediaPath = fetched.path;
          mediaType = fetched.contentType ?? firstAttachment.contentType ?? undefined;
          // 緩存圖片，用於後續引用時查找
          cacheMedia(dataMessage.timestamp, { path: mediaPath, contentType: mediaType });
        }
      } catch (err) {
        deps.runtime.error?.(danger(`attachment fetch failed: ${String(err)}`));
      }
    }

    // === 處理 Sticker ===
    const sticker = dataMessage.sticker;
    let stickerInfo = "";
    if (sticker && !deps.ignoreAttachments) {
      const stickerEmoji = sticker.emoji ? ` ${sticker.emoji}` : "";
      stickerInfo = `[Sticker${stickerEmoji}] `;
      // 如果沒有普通附件，嘗試獲取 Sticker 圖片
      if (!mediaPath) {
        const fetched = await fetchSticker({ sticker, senderRecipient, groupId });
        if (fetched) {
          mediaPath = fetched.path;
          mediaType = fetched.contentType ?? sticker.contentType ?? "image/webp";
          // 緩存 Sticker，用於後續引用時查找
          cacheMedia(dataMessage.timestamp, { path: mediaPath, contentType: mediaType });
        }
      }
    }

    // === 處理引用消息 ===
    const quote = dataMessage.quote;
    let quotePrefix = "";
    let quotedMediaPath: string | undefined;
    let quotedMediaType: string | undefined;

    if (quote) {
      const quoteParts: string[] = [];

      // 格式化引用作者：優先用名字，然後電話號碼，最後 UUID
      // 格式：名字 (UUID) 或 電話號碼 (UUID) 或 UUID
      let quoteAuthor: string;
      const authorId = quote.author ?? quote.authorNumber ?? "";

      if (quote.authorName) {
        // 有用戶名：顯示 "名字 (UUID)"
        quoteAuthor = authorId ? `${quote.authorName} (${authorId})` : quote.authorName;
      } else if (quote.authorNumber) {
        // 有電話號碼：顯示 "電話號碼 (UUID)" 或只顯示電話號碼
        if (quote.author) {
          quoteAuthor = `${quote.authorNumber} (${quote.author})`;
        } else {
          quoteAuthor = quote.authorNumber;
        }
      } else if (quote.author) {
        // 只有 UUID：直接顯示完整 UUID
        quoteAuthor = quote.author;
      } else {
        quoteAuthor = "對方";
      }

      // 格式化引用時間（從 quote.id = timestamp，使用 Mac Mini 本地時區）
      let quoteTime = "";
      if (typeof quote.id === "number" && quote.id > 0) {
        const date = new Date(quote.id);
        quoteTime = ` ${date.toLocaleDateString("zh-TW")} ${date.toLocaleTimeString("zh-TW", { hour: "2-digit", minute: "2-digit" })}`;
      }

      // 引用的文字
      if (quote.text?.trim()) {
        quoteParts.push(quote.text.trim());
      }

      // 引用的附件（圖片或 Sticker）
      if (quote.attachments?.length && !deps.ignoreAttachments) {
        const firstQuotedAtt = quote.attachments[0];
        const contentType = firstQuotedAtt?.contentType ?? "";
        const isSticker =
          contentType === "image/webp" || firstQuotedAtt?.filename?.endsWith(".webp");

        if (isSticker) {
          quoteParts.push("<quoted-sticker>");
        } else {
          const attType = contentType.split("/")[0] || "file";
          quoteParts.push(`<quoted-${attType}>`);
        }

        // 如果沒有普通附件，嘗試獲取被引用的圖片
        if (!mediaPath && !quotedMediaPath) {
          // 方法 1：先嘗試從緩存中查找（用 quote.id = 原消息 timestamp）
          const quoteTimestamp = typeof quote.id === "number" ? quote.id : undefined;
          const cached = getCachedMedia(quoteTimestamp);
          if (cached) {
            quotedMediaPath = cached.path;
            quotedMediaType = cached.contentType ?? contentType ?? undefined;
          } else {
            // 方法 2：嘗試通過 Signal CLI 獲取
            const fetched = await fetchQuotedAttachment({ quote, senderRecipient, groupId });
            if (fetched) {
              quotedMediaPath = fetched.path;
              quotedMediaType = fetched.contentType ?? contentType ?? undefined;
            }
          }
        }
      }

      if (quoteParts.length > 0) {
        quotePrefix = `[引用 ${quoteAuthor}${quoteTime}: ${quoteParts.join(" ")}]\n`;
      }
    }

    // === 構建 placeholder ===
    const kind = mediaKindFromMime(mediaType ?? quotedMediaType ?? undefined);
    if (kind) {
      placeholder = `<media:${kind}>`;
    } else if (dataMessage.attachments?.length || sticker) {
      placeholder = "<media:attachment>";
    }

    // 如果有引用的圖片但沒有普通附件，使用引用的圖片
    if (!mediaPath && quotedMediaPath) {
      mediaPath = quotedMediaPath;
      mediaType = quotedMediaType;
    }

    // === 合併所有內容 ===
    // Strip U+FFFC (Object Replacement Character) used by Signal for mention placeholders
    // This ensures commands like "@bot /new" are passed to agent as "/new"
    const cleanedMessageText = messageText?.replace(/\uFFFC/g, "").trim() || "";
    // 保留原始的 fallback 邏輯：如果沒有 messageText 和 placeholder，使用 quote.text
    const fallbackQuoteText = !quotePrefix && quote?.text?.trim() ? quote.text.trim() : "";
    const bodyText =
      quotePrefix + stickerInfo + (cleanedMessageText || placeholder || fallbackQuoteText);
    if (!bodyText) {
      return;
    }

    const receiptTimestamp =
      typeof envelope.timestamp === "number"
        ? envelope.timestamp
        : typeof dataMessage.timestamp === "number"
          ? dataMessage.timestamp
          : undefined;
    if (deps.sendReadReceipts && !deps.readReceiptsViaDaemon && !isGroup && receiptTimestamp) {
      try {
        await sendReadReceiptSignal(`signal:${senderRecipient}`, receiptTimestamp, {
          baseUrl: deps.baseUrl,
          account: deps.account,
          accountId: deps.accountId,
        });
      } catch (err) {
        logVerbose(`signal read receipt failed for ${senderDisplay}: ${String(err)}`);
      }
    } else if (
      deps.sendReadReceipts &&
      !deps.readReceiptsViaDaemon &&
      !isGroup &&
      !receiptTimestamp
    ) {
      logVerbose(`signal read receipt skipped (missing timestamp) for ${senderDisplay}`);
    }

    const senderName = envelope.sourceName ?? senderDisplay;
    const messageId =
      typeof envelope.timestamp === "number" ? String(envelope.timestamp) : undefined;
    await inboundDebouncer.enqueue({
      senderName,
      senderDisplay,
      senderRecipient,
      senderPeerId,
      groupId,
      groupName,
      isGroup,
      bodyText,
      timestamp: envelope.timestamp ?? undefined,
      messageId,
      mediaPath,
      mediaType,
      commandAuthorized,
      wasMentioned: effectiveWasMentioned,
    });
  };
}
