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
import { mediaKindFromMime } from "../../media/constants.js";
import { buildPairingReply } from "../../pairing/pairing-messages.js";
import {
  readChannelAllowFromStore,
  upsertChannelPairingRequest,
} from "../../pairing/pairing-store.js";
import { resolveAgentRoute } from "../../routing/resolve-route.js";
import { normalizeE164 } from "../../utils.js";
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
import type {
  SignalEventHandlerDeps,
  SignalReceivePayload,
  SignalTextStyleRange,
} from "./event-handler.types.js";
import { renderSignalMentions } from "./mentions.js";

function attachmentLooksLikeVoiceNote(attachment: {
  voiceNote?: boolean | null;
  filename?: string | null;
}): boolean {
  if (attachment.voiceNote === true) {
    return true;
  }
  const fileName = attachment.filename?.trim().toLowerCase() ?? "";
  if (fileName.includes("voice") || fileName.includes("ptt")) {
    return true;
  }
  return false;
}

function normalizeDimensionValue(value?: number | null): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return undefined;
  }
  return Math.round(value);
}

function normalizeCaptionValue(value?: string | null): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim();
  return normalized || undefined;
}

const SIGNAL_MARKDOWN_STYLE_MARKERS: Record<string, { open: string; close: string }> = {
  BOLD: { open: "**", close: "**" },
  ITALIC: { open: "_", close: "_" },
  MONOSPACE: { open: "`", close: "`" },
  STRIKETHROUGH: { open: "~~", close: "~~" },
  SPOILER: { open: "||", close: "||" },
};

function applySignalTextStyles(text: string, styles?: SignalTextStyleRange[] | null): string {
  if (!text || !Array.isArray(styles) || styles.length === 0) {
    return text;
  }

  const opens = new Map<number, string[]>();
  const closes = new Map<number, string[]>();

  const normalizedRanges = styles
    .map((style) => {
      const marker = style.style ? SIGNAL_MARKDOWN_STYLE_MARKERS[style.style] : undefined;
      if (!marker) {
        return null;
      }
      if (typeof style.start !== "number" || typeof style.length !== "number") {
        return null;
      }
      if (!Number.isFinite(style.start) || !Number.isFinite(style.length)) {
        return null;
      }
      const start = Math.max(0, Math.trunc(style.start));
      const length = Math.max(0, Math.trunc(style.length));
      if (length <= 0 || start >= text.length) {
        return null;
      }
      const end = Math.min(text.length, start + length);
      if (end <= start) {
        return null;
      }
      return { start, end, marker };
    })
    .filter(
      (range): range is { start: number; end: number; marker: { open: string; close: string } } =>
        Boolean(range),
    )
    .toSorted((a, b) => {
      if (a.start !== b.start) {
        return b.start - a.start;
      }
      return b.end - a.end;
    });

  for (const range of normalizedRanges) {
    const openList = opens.get(range.start) ?? [];
    openList.push(range.marker.open);
    opens.set(range.start, openList);

    const closeList = closes.get(range.end) ?? [];
    closeList.push(range.marker.close);
    closes.set(range.end, closeList);
  }

  let output = text;
  for (let index = text.length; index >= 0; index -= 1) {
    const closeList = closes.get(index);
    const openList = opens.get(index);
    if (!closeList && !openList) {
      continue;
    }
    const insertion = `${(closeList ?? []).join("")}${(openList ?? []).join("")}`;
    output = `${output.slice(0, index)}${insertion}${output.slice(index)}`;
  }

  return output;
}

function buildSignalLinkPreviewContext(
  previews?: Array<{
    url?: string | null;
    title?: string | null;
    description?: string | null;
  }> | null,
): string[] {
  if (!Array.isArray(previews) || previews.length === 0) {
    return [];
  }

  const context: string[] = [];
  for (const preview of previews) {
    const url = preview.url?.trim();
    if (!url) {
      continue;
    }
    const title = preview.title?.trim();
    const description = preview.description?.trim();
    const label = title && description ? `${title} - ${description}` : title || description || url;
    context.push(`Link preview: ${label} (${url})`);
  }
  return context;
}

export function createSignalEventHandler(deps: SignalEventHandlerDeps) {
  const inboundDebounceMs = resolveInboundDebounceMs({ cfg: deps.cfg, channel: "signal" });

  type SignalInboundEntry = {
    senderName: string;
    senderDisplay: string;
    senderRecipient: string;
    senderPeerId: string;
    groupId?: string;
    groupName?: string;
    isGroup: boolean;
    bodyText: string;
    bodyTextPlain: string;
    timestamp?: number;
    messageId?: string;
    editTargetTimestamp?: number;
    isEdit?: boolean;
    mediaPath?: string;
    mediaType?: string;
    mediaCaption?: string;
    mediaPaths?: string[];
    mediaTypes?: string[];
    mediaCaptions?: string[];
    mediaDimension?: { width?: number; height?: number };
    mediaDimensions?: Array<{ width?: number; height?: number }>;
    untrustedContext?: string[];
    replyToId?: string;
    replyToBody?: string;
    replyToSender?: string;
    replyToIsQuote?: boolean;
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
      EditTargetTimestamp: entry.editTargetTimestamp,
      ReplyToId: entry.replyToId,
      ReplyToBody: entry.replyToBody,
      ReplyToSender: entry.replyToSender,
      ReplyToIsQuote: entry.replyToIsQuote,
      UntrustedContext: entry.untrustedContext,
      Timestamp: entry.timestamp ?? undefined,
      MediaPath: entry.mediaPath,
      MediaType: entry.mediaType,
      MediaCaption: entry.mediaCaption,
      MediaUrl: entry.mediaPath,
      MediaPaths: entry.mediaPaths,
      MediaUrls: entry.mediaPaths,
      MediaTypes: entry.mediaTypes,
      MediaCaptions: entry.mediaCaptions,
      MediaDimension: entry.mediaDimension,
      MediaDimensions: entry.mediaDimensions,
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
      if (entry.isEdit) {
        return false;
      }
      if (
        entry.mediaPath ||
        entry.mediaType ||
        entry.mediaCaption ||
        (Array.isArray(entry.mediaPaths) && entry.mediaPaths.length > 0) ||
        (Array.isArray(entry.mediaTypes) && entry.mediaTypes.length > 0) ||
        (Array.isArray(entry.mediaCaptions) && entry.mediaCaptions.length > 0)
      ) {
        return false;
      }
      return !hasControlCommand(entry.bodyTextPlain, deps.cfg);
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
      const combinedTextPlain = entries
        .map((entry) => entry.bodyTextPlain)
        .filter(Boolean)
        .join("\\n");
      if (!combinedText.trim()) {
        return;
      }
      await handleSignalInboundMessage({
        ...last,
        bodyText: combinedText,
        bodyTextPlain: combinedTextPlain,
        mediaPath: undefined,
        mediaType: undefined,
        mediaCaption: undefined,
        mediaPaths: undefined,
        mediaTypes: undefined,
        mediaCaptions: undefined,
        mediaDimension: undefined,
        mediaDimensions: undefined,
        untrustedContext: undefined,
        replyToId: undefined,
        replyToBody: undefined,
        replyToSender: undefined,
        replyToIsQuote: undefined,
        editTargetTimestamp: undefined,
        isEdit: undefined,
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
    const editTargetTimestamp =
      typeof envelope.editMessage?.targetSentTimestamp === "number" &&
      Number.isFinite(envelope.editMessage.targetSentTimestamp)
        ? envelope.editMessage.targetSentTimestamp
        : undefined;
    const isEditMessage = Boolean(envelope.editMessage);
    const reaction = deps.isSignalReactionMessage(envelope.reactionMessage)
      ? envelope.reactionMessage
      : deps.isSignalReactionMessage(dataMessage?.reaction)
        ? dataMessage?.reaction
        : null;

    // Replace ￼ (object replacement character) with @uuid or @phone from mentions
    // Signal encodes mentions as the object replacement character; hydrate them from metadata first.
    const rawMessage = dataMessage?.message ?? "";
    const mentionResult = renderSignalMentions(rawMessage, dataMessage?.mentions);
    const normalizedMessage = mentionResult.text;

    // Adjust text style offsets to account for mention expansions
    // textStyles from Signal reference the original message offsets, but we need them
    // to reference the expanded message (after @uuid replacements)
    const adjustedTextStyles =
      dataMessage?.textStyles && mentionResult.offsetShifts.size > 0
        ? (() => {
            const sortedShiftPositions = Array.from(mentionResult.offsetShifts.keys()).toSorted(
              (a, b) => a - b,
            );
            return dataMessage.textStyles.map((style) => {
              if (typeof style.start !== "number") {
                return style;
              }
              // Calculate cumulative shift up to this style's start position
              let cumulativeShift = 0;
              for (const shiftPos of sortedShiftPositions) {
                if (shiftPos <= style.start) {
                  cumulativeShift += mentionResult.offsetShifts.get(shiftPos) ?? 0;
                } else {
                  break;
                }
              }
              return {
                ...style,
                start: style.start + cumulativeShift,
              };
            });
          })()
        : dataMessage?.textStyles;

    const styledMessage =
      deps.preserveTextStyles !== false
        ? applySignalTextStyles(normalizedMessage, adjustedTextStyles)
        : normalizedMessage;
    const messageTextPlain = normalizedMessage.trim();
    const messageText = styledMessage.trim();

    const quote = dataMessage?.quote;
    const quoteText = quote?.text?.trim() ?? "";
    const quoteReplyId = (() => {
      const raw = quote?.id ?? quote?.timestamp;
      if (raw == null) {
        return undefined;
      }
      const value = String(raw).trim();
      return value || undefined;
    })();
    const quoteReplySender = (() => {
      const raw = quote?.authorUuid ?? quote?.authorNumber ?? quote?.author;
      if (typeof raw !== "string") {
        return undefined;
      }
      const value = raw.trim();
      return value || undefined;
    })();
    const sticker = dataMessage?.sticker;
    const stickerPackId = (() => {
      const raw = sticker?.packId;
      if (raw == null) {
        return undefined;
      }
      const value = String(raw).trim();
      return value || undefined;
    })();
    const stickerId = (() => {
      const raw = sticker?.stickerId;
      if (raw == null) {
        return undefined;
      }
      const value = String(raw).trim();
      return value || undefined;
    })();
    const stickerContext = [
      stickerPackId ? `Signal sticker packId: ${stickerPackId}` : undefined,
      stickerId ? `Signal stickerId: ${stickerId}` : undefined,
    ].filter((entry): entry is string => Boolean(entry));
    const linkPreviewContext =
      deps.injectLinkPreviews !== false ? buildSignalLinkPreviewContext(dataMessage?.previews) : [];
    const attachments = dataMessage?.attachments ?? [];
    const allAttachments = sticker?.attachment ? [...attachments, sticker.attachment] : attachments;
    const voiceNoteIndices = allAttachments.flatMap((attachment, index) =>
      attachmentLooksLikeVoiceNote(attachment) ? [index + 1] : [],
    );
    const voiceContext =
      voiceNoteIndices.length > 0
        ? [`Signal voice note attachment indexes: ${voiceNoteIndices.join(",")}`]
        : [];
    const firstAttachmentIsVoiceNote = voiceNoteIndices.includes(1);
    const hasBodyContent =
      Boolean(messageText || quoteText) || Boolean(!reaction && allAttachments.length > 0);

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

    const useAccessGroups = deps.cfg.commands?.useAccessGroups !== false;
    const ownerAllowedForCommands = isSignalSenderAllowed(sender, effectiveDmAllow);
    const groupAllowedForCommands = isSignalSenderAllowed(sender, effectiveGroupAllow);
    const hasControlCommandInMessage = hasControlCommand(messageTextPlain, deps.cfg);
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
    const wasMentioned = isGroup && matchesMentionPatterns(messageTextPlain, mentionRegexes);
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
      const pendingPlaceholder = (() => {
        if (dataMessage.sticker) {
          return "<media:sticker>";
        }
        if (allAttachments.length === 0) {
          return "";
        }
        // When we're skipping a message we intentionally avoid downloading attachments.
        // Still record a useful placeholder for pending-history context.
        if (deps.ignoreAttachments) {
          if (firstAttachmentIsVoiceNote) {
            return "<media:audio> (voice note)";
          }
          return "<media:attachment>";
        }
        const firstContentType = allAttachments[0]?.contentType;
        const pendingKind = mediaKindFromMime(firstContentType ?? undefined);
        if (pendingKind === "audio" && firstAttachmentIsVoiceNote) {
          return "<media:audio> (voice note)";
        }
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
    let mediaCaption: string | undefined;
    let mediaPaths: string[] | undefined;
    let mediaTypes: string[] | undefined;
    let mediaCaptions: string[] | undefined;
    let mediaDimension: { width?: number; height?: number } | undefined;
    let mediaDimensions: Array<{ width?: number; height?: number }> | undefined;
    let placeholder = "";
    if (!deps.ignoreAttachments && allAttachments.length > 0) {
      const fetchedMedia: Array<{
        path: string;
        contentType?: string;
        caption?: string;
        width?: number;
        height?: number;
      }> = [];
      const fetchResults = await Promise.allSettled(
        allAttachments.map(async (attachment) => {
          if (!attachment?.id) {
            return null;
          }
          const fetched = await deps.fetchAttachment({
            baseUrl: deps.baseUrl,
            account: deps.account,
            attachment,
            sender: senderRecipient,
            groupId,
            maxBytes: deps.mediaMaxBytes,
          });
          if (!fetched) {
            return null;
          }
          return {
            path: fetched.path,
            contentType: fetched.contentType ?? attachment.contentType ?? undefined,
            caption: normalizeCaptionValue(attachment.caption),
            width: normalizeDimensionValue(attachment.width),
            height: normalizeDimensionValue(attachment.height),
          };
        }),
      );
      for (const result of fetchResults) {
        if (result.status === "rejected") {
          deps.runtime.error?.(danger(`attachment fetch failed: ${String(result.reason)}`));
          continue;
        }
        if (result.value) {
          fetchedMedia.push(result.value);
        }
      }
      mediaPath = fetchedMedia[0]?.path;
      mediaType =
        fetchedMedia.length > 0
          ? (fetchedMedia[0]?.contentType ?? "application/octet-stream")
          : undefined;
      mediaCaption = fetchedMedia[0]?.caption;
      mediaPaths = fetchedMedia.length > 0 ? fetchedMedia.map((entry) => entry.path) : undefined;
      mediaTypes =
        fetchedMedia.length > 0
          ? fetchedMedia.map((entry) => entry.contentType ?? "application/octet-stream")
          : undefined;
      mediaCaptions =
        fetchedMedia.length > 0 ? fetchedMedia.map((entry) => entry.caption ?? "") : undefined;
      if (mediaCaptions && !mediaCaptions.some((entry) => entry.trim().length > 0)) {
        mediaCaptions = undefined;
      }
      const fetchedDimensions = fetchedMedia.map((entry) => ({
        width: entry.width,
        height: entry.height,
      }));
      const hasAnyDimensions = fetchedDimensions.some((entry) => entry.width || entry.height);
      mediaDimension = hasAnyDimensions ? fetchedDimensions[0] : undefined;
      mediaDimensions = hasAnyDimensions ? fetchedDimensions : undefined;
    }

    const firstAttachmentContentType = allAttachments[0]?.contentType ?? undefined;
    const kind = mediaKindFromMime(mediaType ?? firstAttachmentContentType);
    if (sticker) {
      placeholder = "<media:sticker>";
    } else if (firstAttachmentIsVoiceNote) {
      placeholder = "<media:audio> (voice note)";
    } else if (kind) {
      placeholder = `<media:${kind}>`;
    } else if (allAttachments.length) {
      placeholder = "<media:attachment>";
    }

    const bodyText = messageText || placeholder || quoteText;
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
      bodyTextPlain: messageTextPlain,
      timestamp: envelope.timestamp ?? undefined,
      messageId,
      editTargetTimestamp,
      isEdit: isEditMessage,
      mediaPath,
      mediaType,
      mediaCaption,
      mediaPaths,
      mediaTypes,
      mediaCaptions,
      mediaDimension,
      mediaDimensions,
      untrustedContext:
        stickerContext.length > 0 || voiceContext.length > 0 || linkPreviewContext.length > 0
          ? [...stickerContext, ...voiceContext, ...linkPreviewContext]
          : undefined,
      replyToId: quoteReplyId,
      replyToBody: quoteText || undefined,
      replyToSender: quoteReplySender,
      replyToIsQuote: quote ? true : undefined,
      commandAuthorized,
      wasMentioned: effectiveWasMentioned,
    });
  };
}
