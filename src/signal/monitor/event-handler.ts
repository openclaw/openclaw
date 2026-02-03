import type { SignalEventHandlerDeps, SignalReceivePayload } from "./event-handler.types.js";
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
} from "../../auto-reply/reply/history.js";
import { finalizeInboundContext } from "../../auto-reply/reply/inbound-context.js";
import { createReplyDispatcherWithTyping } from "../../auto-reply/reply/reply-dispatcher.js";
import { resolveControlCommandGate } from "../../channels/command-gating.js";
import { logInboundDrop, logTypingFailure } from "../../channels/logging.js";
import { createReplyPrefixContext } from "../../channels/reply-prefix.js";
import { recordInboundSession } from "../../channels/session.js";
import { createTypingCallbacks } from "../../channels/typing.js";
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

export function createSignalEventHandler(deps: SignalEventHandlerDeps) {
  const inboundDebounceMs = resolveInboundDebounceMs({ cfg: deps.cfg, channel: "signal" });

  /**
   * Format quoted message context similar to Telegram's implementation.
   * Returns a formatted string to append to the message body.
   */
  function formatQuotedMessageContext(quote: {
    id?: number | null;
    author?: string | null;
    authorNumber?: string | null;
    authorUuid?: string | null;
    text?: string | null;
  }): string {
    if (!quote) {
      return "";
    }

    // Prefer phone number, fall back to UUID, then author
    const authorLabel =
      quote.authorNumber?.trim() || quote.authorUuid?.trim() || quote.author?.trim() || "Unknown";
    const messageId = quote.id ? String(quote.id) : undefined;
    const quoteText = quote.text?.trim() || "<no text>";

    return `\n\n[Replying to ${authorLabel}${messageId ? ` id:${messageId}` : ""}]\n${quoteText}\n[/Replying]`;
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
    mediaPaths?: string[];
    mediaTypes?: string[];
    commandAuthorized: boolean;
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
        kind: entry.isGroup ? "group" : "dm",
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
    const signalTo = entry.isGroup ? `group:${entry.groupId}` : `signal:${entry.senderRecipient}`;
    const ctxPayload = finalizeInboundContext({
      Body: combinedBody,
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
      MediaPaths: entry.mediaPaths,
      MediaTypes: entry.mediaTypes,
      MediaUrls: entry.mediaPaths,
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

    const prefixContext = createReplyPrefixContext({ cfg: deps.cfg, agentId: route.agentId });

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
      responsePrefix: prefixContext.responsePrefix,
      responsePrefixContextProvider: prefixContext.responsePrefixContextProvider,
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
        onModelSelected: (ctx) => {
          prefixContext.onModelSelected(ctx);
        },
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
      if (entry.mediaPath || entry.mediaType || entry.mediaPaths?.length) {
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
        mediaPaths: undefined,
        mediaTypes: undefined,
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
    const messageText = (dataMessage?.message ?? "").trim();
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
          kind: isGroup ? "group" : "dm",
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
    const hasControlCommandInMessage = hasControlCommand(messageText, deps.cfg);
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

    let mediaPath: string | undefined;
    let mediaType: string | undefined;
    const mediaPaths: string[] = [];
    const mediaTypes: string[] = [];
    let placeholder = "";

    const attachments = dataMessage.attachments ?? [];
    if (attachments.length > 0 && !deps.ignoreAttachments) {
      // Fetch all attachments in parallel for speed
      const validAttachments = attachments.filter((a) => a?.id);

      // Send "processing images" message for multiple attachments
      // Guard: only send if we have a valid target (groupId must be truthy for groups)
      if (validAttachments.length > 1 && (!isGroup || groupId)) {
        const target = isGroup ? `group:${groupId}` : `signal:${senderRecipient}`;
        try {
          await sendMessageSignal(target, `Processing ${validAttachments.length} images...`, {
            baseUrl: deps.baseUrl,
            account: deps.account,
            maxBytes: deps.mediaMaxBytes,
            accountId: deps.accountId,
          });
        } catch {
          // Ignore errors sending processing message
        }
      }
      const fetchResults = await Promise.all(
        validAttachments.map(async (attachment) => {
          try {
            const fetched = await deps.fetchAttachment({
              baseUrl: deps.baseUrl,
              account: deps.account,
              attachment,
              sender: senderRecipient,
              groupId,
              maxBytes: deps.mediaMaxBytes,
            });
            if (fetched) {
              return {
                path: fetched.path,
                contentType:
                  fetched.contentType ?? attachment.contentType ?? "application/octet-stream",
              };
            }
          } catch (err) {
            deps.runtime.error?.(danger(`attachment fetch failed: ${String(err)}`));
          }
          return null;
        }),
      );
      for (const result of fetchResults) {
        if (result) {
          mediaPaths.push(result.path);
          mediaTypes.push(result.contentType);
        }
      }
      // Set first attachment for backwards compatibility
      if (mediaPaths.length > 0) {
        mediaPath = mediaPaths[0];
        mediaType = mediaTypes[0];
      }
    }

    const kind = mediaKindFromMime(mediaType ?? undefined);
    if (kind) {
      placeholder = `<media:${kind}>`;
      // Add placeholders for additional attachments
      if (mediaPaths.length > 1) {
        for (let i = 1; i < mediaPaths.length; i++) {
          const additionalKind = mediaKindFromMime(mediaTypes[i] ?? undefined);
          placeholder += ` <media:${additionalKind ?? "attachment"}>`;
        }
      }
    } else if (mediaPaths.length) {
      placeholder = "<media:attachment>";
      if (mediaPaths.length > 1) {
        placeholder += ` +${mediaPaths.length - 1} more`;
      }
    }

    // Format quoted message context
    const quoteSuffix = dataMessage.quote ? formatQuotedMessageContext(dataMessage.quote) : "";

    // Build body text with quote context
    let bodyText = messageText || placeholder || "";
    if (!bodyText && dataMessage.quote?.text?.trim()) {
      // If no message text but there's a quote (quote-only reply), use quote text
      bodyText = dataMessage.quote.text.trim();
    }

    if (!bodyText) {
      return;
    }

    // Append quoted message context to body
    bodyText = bodyText + quoteSuffix;

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
      mediaPaths: mediaPaths.length > 0 ? mediaPaths : undefined,
      mediaTypes: mediaTypes.length > 0 ? mediaTypes : undefined,
      commandAuthorized,
    });
  };
}
