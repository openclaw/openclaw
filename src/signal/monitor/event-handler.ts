import type {
  SignalEventHandlerDeps,
  SignalMention,
  SignalReceivePayload,
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
} from "../../auto-reply/reply/history.js";
import { finalizeInboundContext } from "../../auto-reply/reply/inbound-context.js";
import { createReplyDispatcherWithTyping } from "../../auto-reply/reply/reply-dispatcher.js";
import { resolveControlCommandGate } from "../../channels/command-gating.js";
import { logInboundDrop, logTypingFailure } from "../../channels/logging.js";
import { createReplyPrefixOptions } from "../../channels/reply-prefix.js";
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
import { signalRpcRequest } from "../client.js";
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

// ---------------------------------------------------------------------------
// Signal mention resolution
// ---------------------------------------------------------------------------

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isUuid(s: string | null | undefined): boolean {
  return UUID_RE.test(s?.trim() ?? "");
}

/**
 * Cache of Signal UUID → display name.
 *
 * Seeded once from signal-cli `listContacts` (profile names) and then
 * continuously updated from `envelope.sourceName` on every inbound SSE event.
 * Used to resolve mentions whose `name` field is just the UUID (signal-cli
 * does this for users not in the local address book).
 */
const signalNameCache = new Map<string, string>();
let seedPromise: Promise<void> | null = null;

function nameCachePut(uuid: string | null | undefined, name: string | null | undefined): void {
  if (!uuid || !name || isUuid(name)) {
    return;
  }
  signalNameCache.set(uuid.toLowerCase(), name);
}

function nameCacheGet(uuid: string | null | undefined): string | undefined {
  return uuid ? signalNameCache.get(uuid.toLowerCase()) : undefined;
}

async function seedSignalNameCache(baseUrl: string, account: string | undefined): Promise<void> {
  if (seedPromise) {
    return seedPromise;
  }
  seedPromise = (async () => {
    try {
      type Contact = {
        uuid?: string;
        profile?: { givenName?: string; familyName?: string };
      };
      const contacts = await signalRpcRequest<Contact[]>(
        "listContacts",
        { account },
        { baseUrl, timeoutMs: 5000 },
      );
      if (Array.isArray(contacts)) {
        for (const c of contacts) {
          const displayName = [c.profile?.givenName, c.profile?.familyName]
            .filter(Boolean)
            .join(" ")
            .trim();
          if (c.uuid && displayName) {
            nameCachePut(c.uuid, displayName);
          }
        }
      }
    } catch {
      // Non-fatal — allow retry on next event by clearing the promise.
      seedPromise = null;
    }
  })();
  return seedPromise;
}

/**
 * Replace U+FFFC (Object Replacement Character) placeholders with `@name`
 * using the mention metadata array from signal-cli.
 *
 * signal-cli represents Signal mentions as:
 *   - `dataMessage.message` contains U+FFFC at the mention position
 *   - `dataMessage.mentions[]` contains `{name, number, uuid, start, length}`
 *
 * The `name` field is sometimes set to the UUID rather than the display name
 * (especially for users not in the local address book), so we fall back to
 * the name cache, then number, then UUID.
 */
function resolveSignalMentions(text: string, mentions: SignalMention[] | null | undefined): string {
  if (!mentions || mentions.length === 0) {
    return text;
  }

  // Process from end to start so replacements don't shift earlier indices.
  const sorted = [...mentions].toSorted((a, b) => (b.start ?? 0) - (a.start ?? 0));
  let result = text;
  for (const mention of sorted) {
    const start = Math.max(0, Math.min(mention.start ?? 0, result.length));
    const length = Math.max(0, mention.length ?? 1);

    // Skip mentions that extend beyond the text or don't point at a U+FFFC placeholder.
    if (start + length > result.length) {
      continue;
    }
    if (result.charAt(start) !== "\uFFFC") {
      continue;
    }

    let label = mention.name?.trim();
    if (!label || isUuid(label)) {
      label =
        nameCacheGet(mention.uuid) || mention.number?.trim() || mention.uuid?.trim() || "someone";
    }

    result = result.slice(0, start) + `@${label}` + result.slice(start + length);
  }
  return result;
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
    timestamp?: number;
    messageId?: string;
    mediaPath?: string;
    mediaType?: string;
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
    // Seed the mention name cache from contacts on first event.
    void seedSignalNameCache(deps.baseUrl, deps.account);

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

    // Populate mention name cache from every inbound envelope.
    const senderUuid = envelope.sourceUuid ?? (sender.kind === "uuid" ? sender.raw : undefined);
    if (senderUuid && envelope.sourceName) {
      nameCachePut(senderUuid, envelope.sourceName);
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
    const messageText = resolveSignalMentions(
      dataMessage?.message ?? "",
      dataMessage?.mentions,
    ).trim();
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
    let placeholder = "";
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
        }
      } catch (err) {
        deps.runtime.error?.(danger(`attachment fetch failed: ${String(err)}`));
      }
    }

    const kind = mediaKindFromMime(mediaType ?? undefined);
    if (kind) {
      placeholder = `<media:${kind}>`;
    } else if (dataMessage.attachments?.length) {
      placeholder = "<media:attachment>";
    }

    const bodyText = messageText || placeholder || dataMessage.quote?.text?.trim() || "";
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
    });
  };
}
