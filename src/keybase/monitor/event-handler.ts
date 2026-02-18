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
  type HistoryEntry,
} from "../../auto-reply/reply/history.js";
import { finalizeInboundContext } from "../../auto-reply/reply/inbound-context.js";
import { buildMentionRegexes, matchesMentionPatterns } from "../../auto-reply/reply/mentions.js";
import { createReplyDispatcherWithTyping } from "../../auto-reply/reply/reply-dispatcher.js";
import type { ReplyPayload } from "../../auto-reply/types.js";
import { resolveControlCommandGate } from "../../channels/command-gating.js";
import { logInboundDrop } from "../../channels/logging.js";
import { resolveMentionGatingWithBypass } from "../../channels/mention-gating.js";
import { normalizeKeybaseMessagingTarget } from "../../channels/plugins/normalize/keybase.js";
import { createReplyPrefixOptions } from "../../channels/reply-prefix.js";
import { recordInboundSession } from "../../channels/session.js";
import type { OpenClawConfig } from "../../config/config.js";
import { resolveChannelGroupRequireMention } from "../../config/group-policy.js";
import { readSessionUpdatedAt, resolveStorePath } from "../../config/sessions.js";
import { danger, logVerbose, shouldLogVerbose } from "../../globals.js";
import { buildPairingReply } from "../../pairing/pairing-messages.js";
import {
  readChannelAllowFromStore,
  upsertChannelPairingRequest,
} from "../../pairing/pairing-store.js";
import { resolveAgentRoute } from "../../routing/resolve-route.js";
import type { RuntimeEnv } from "../../runtime.js";
import {
  formatKeybasePairingIdLine,
  formatKeybaseSenderDisplay,
  formatKeybaseSenderId,
  isKeybaseSenderAllowed,
  resolveKeybasePeerId,
  resolveKeybaseRecipient,
  resolveKeybaseSender,
} from "../identity.js";
import { sendMessageKeybase } from "../send.js";

export type KeybaseMessage = {
  type: string;
  source?: string;
  msg?: {
    id?: number;
    conversation_id?: string;
    channel?: {
      name?: string;
      members_type?: string;
      topic_type?: string;
      topic_name?: string;
    };
    sender?: {
      uid?: string;
      username?: string;
      device_id?: string;
      device_name?: string;
    };
    sent_at?: number;
    sent_at_ms?: number;
    content?: {
      type?: string;
      text?: {
        body?: string;
        userMentions?: unknown;
        teamMentions?: unknown;
      };
      attachment?: {
        object?: {
          filename?: string;
          size?: number;
          mimeType?: string;
        };
      };
    };
  };
};

export type KeybaseEventHandlerDeps = {
  runtime: RuntimeEnv;
  cfg: OpenClawConfig;
  accountId: string;
  botUsername: string;
  blockStreaming?: boolean;
  historyLimit: number;
  groupHistories: Map<string, HistoryEntry[]>;
  textLimit: number;
  dmPolicy: string;
  allowFrom: string[];
  groupAllowFrom: string[];
  groupPolicy: string;
  deliverReplies: (params: {
    replies: ReplyPayload[];
    target: string;
    runtime: RuntimeEnv;
    textLimit: number;
  }) => Promise<void>;
};

type KeybaseInboundEntry = {
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
  commandAuthorized: boolean;
  wasMentioned?: boolean;
};

export function createKeybaseEventHandler(deps: KeybaseEventHandlerDeps) {
  const inboundDebounceMs = resolveInboundDebounceMs({ cfg: deps.cfg, channel: "keybase" });

  async function handleKeybaseInboundMessage(entry: KeybaseInboundEntry) {
    const fromLabel = formatInboundFromLabel({
      isGroup: entry.isGroup,
      groupLabel: entry.groupName ?? undefined,
      groupId: entry.groupId ?? "unknown",
      groupFallback: "Team",
      directLabel: entry.senderName,
      directId: entry.senderDisplay,
    });
    const route = resolveAgentRoute({
      cfg: deps.cfg,
      channel: "keybase",
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
      channel: "Keybase",
      from: fromLabel,
      timestamp: entry.timestamp ? entry.timestamp * 1000 : undefined,
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
            channel: "Keybase",
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
    const keybaseToRaw = entry.isGroup
      ? `team:${entry.groupId}`
      : `keybase:${entry.senderRecipient}`;
    const keybaseTo = normalizeKeybaseMessagingTarget(keybaseToRaw) ?? keybaseToRaw;
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
        ? `team:${entry.groupId ?? "unknown"}`
        : `keybase:${entry.senderRecipient}`,
      To: keybaseTo,
      SessionKey: route.sessionKey,
      AccountId: route.accountId,
      ChatType: entry.isGroup ? "group" : "direct",
      ConversationLabel: fromLabel,
      GroupSubject: entry.isGroup ? (entry.groupName ?? undefined) : undefined,
      SenderName: entry.senderName,
      SenderId: entry.senderDisplay,
      Provider: "keybase" as const,
      Surface: "keybase" as const,
      MessageSid: entry.messageId,
      Timestamp: entry.timestamp ? entry.timestamp * 1000 : undefined,
      WasMentioned: entry.isGroup ? entry.wasMentioned === true : undefined,
      CommandAuthorized: entry.commandAuthorized,
      OriginatingChannel: "keybase" as const,
      OriginatingTo: keybaseTo,
    });

    await recordInboundSession({
      storePath,
      sessionKey: ctxPayload.SessionKey ?? route.sessionKey,
      ctx: ctxPayload,
      updateLastRoute: !entry.isGroup
        ? {
            sessionKey: route.mainSessionKey,
            channel: "keybase",
            to: entry.senderRecipient,
            accountId: route.accountId,
          }
        : undefined,
      onRecordError: (err) => {
        logVerbose(`keybase: failed updating session meta: ${String(err)}`);
      },
    });

    if (shouldLogVerbose()) {
      const preview = body.slice(0, 200).replace(/\n/g, "\\n");
      logVerbose(
        `keybase inbound: from=${ctxPayload.From} len=${body.length} preview="${preview}"`,
      );
    }

    const { onModelSelected, ...prefixOptions } = createReplyPrefixOptions({
      cfg: deps.cfg,
      agentId: route.agentId,
      channel: "keybase",
      accountId: route.accountId,
    });

    const { dispatcher, replyOptions, markDispatchIdle } = createReplyDispatcherWithTyping({
      ...prefixOptions,
      humanDelay: resolveHumanDelayConfig(deps.cfg, route.agentId),
      deliver: async (payload) => {
        await deps.deliverReplies({
          replies: [payload],
          target: ctxPayload.To,
          runtime: deps.runtime,
          textLimit: deps.textLimit,
        });
      },
      onError: (err, info) => {
        deps.runtime.error?.(danger(`keybase ${info.kind} reply failed: ${String(err)}`));
      },
    });

    await dispatchInboundMessage({
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
    if (entry.isGroup && historyKey) {
      clearHistoryEntriesIfEnabled({
        historyMap: deps.groupHistories,
        historyKey,
        limit: deps.historyLimit,
      });
    }
  }

  const inboundDebouncer = createInboundDebouncer<KeybaseInboundEntry>({
    debounceMs: inboundDebounceMs,
    buildKey: (entry) => {
      const conversationId = entry.isGroup ? (entry.groupId ?? "unknown") : entry.senderPeerId;
      if (!conversationId || !entry.senderPeerId) {
        return null;
      }
      return `keybase:${deps.accountId}:${conversationId}:${entry.senderPeerId}`;
    },
    shouldDebounce: (entry) => {
      if (!entry.bodyText.trim()) {
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
        await handleKeybaseInboundMessage(last);
        return;
      }
      const combinedText = entries
        .map((entry) => entry.bodyText)
        .filter(Boolean)
        .join("\n");
      if (!combinedText.trim()) {
        return;
      }
      await handleKeybaseInboundMessage({
        ...last,
        bodyText: combinedText,
      });
    },
    onError: (err) => {
      deps.runtime.error?.(`keybase debounce flush failed: ${String(err)}`);
    },
  });

  return async (event: KeybaseMessage) => {
    if (event.type !== "chat") {
      return;
    }
    const msg = event.msg;
    if (!msg) {
      return;
    }

    // Only handle text messages for now
    if (msg.content?.type !== "text") {
      return;
    }

    const senderUsername = msg.sender?.username?.trim();
    if (!senderUsername) {
      return;
    }

    // Filter out own messages to avoid echo loop
    if (senderUsername.toLowerCase() === deps.botUsername.toLowerCase()) {
      return;
    }

    const sender = resolveKeybaseSender({ username: senderUsername });
    if (!sender) {
      return;
    }

    const messageText = msg.content.text?.body?.trim() ?? "";
    if (!messageText) {
      return;
    }

    const isGroup = msg.channel?.members_type === "team";
    const groupId = isGroup ? msg.channel?.name : undefined;
    const groupName = isGroup
      ? `${msg.channel?.name ?? ""}${msg.channel?.topic_name ? `#${msg.channel.topic_name}` : ""}`
      : undefined;

    const senderDisplay = formatKeybaseSenderDisplay(sender);
    const senderRecipient = resolveKeybaseRecipient(sender);
    const senderPeerId = resolveKeybasePeerId(sender);
    const senderAllowId = formatKeybaseSenderId(sender);

    const storeAllowFrom = await readChannelAllowFromStore("keybase").catch(() => []);
    const effectiveDmAllow = [...deps.allowFrom, ...storeAllowFrom];
    const effectiveGroupAllow = [...deps.groupAllowFrom, ...storeAllowFrom];
    const dmAllowed =
      deps.dmPolicy === "open" ? true : isKeybaseSenderAllowed(sender, effectiveDmAllow);

    if (!isGroup) {
      if (deps.dmPolicy === "disabled") {
        return;
      }
      if (!dmAllowed) {
        if (deps.dmPolicy === "pairing") {
          const senderId = senderAllowId;
          const { code, created } = await upsertChannelPairingRequest({
            channel: "keybase",
            id: senderId,
            meta: { name: senderUsername },
          });
          if (created) {
            logVerbose(`keybase pairing request sender=${senderId}`);
            try {
              await sendMessageKeybase(
                senderRecipient,
                buildPairingReply({
                  channel: "keybase",
                  idLine: formatKeybasePairingIdLine(sender),
                  code,
                }),
              );
            } catch (err) {
              logVerbose(`keybase pairing reply failed for ${senderId}: ${String(err)}`);
            }
          }
        } else {
          logVerbose(`Blocked keybase sender ${senderDisplay} (dmPolicy=${deps.dmPolicy})`);
        }
        return;
      }
    }
    if (isGroup && deps.groupPolicy === "disabled") {
      logVerbose("Blocked keybase group message (groupPolicy: disabled)");
      return;
    }
    if (isGroup && deps.groupPolicy === "allowlist") {
      if (effectiveGroupAllow.length === 0) {
        logVerbose("Blocked keybase group message (groupPolicy: allowlist, no groupAllowFrom)");
        return;
      }
      if (!isKeybaseSenderAllowed(sender, effectiveGroupAllow)) {
        logVerbose(`Blocked keybase group sender ${senderDisplay} (not in groupAllowFrom)`);
        return;
      }
    }

    const useAccessGroups = deps.cfg.commands?.useAccessGroups !== false;
    const ownerAllowedForCommands = isKeybaseSenderAllowed(sender, effectiveDmAllow);
    const groupAllowedForCommands = isKeybaseSenderAllowed(sender, effectiveGroupAllow);
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
        channel: "keybase",
        reason: "control command (unauthorized)",
        target: senderDisplay,
      });
      return;
    }

    const route = resolveAgentRoute({
      cfg: deps.cfg,
      channel: "keybase",
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
        channel: "keybase",
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
        channel: "keybase",
        reason: "no mention",
        target: senderDisplay,
      });
      const historyKey = groupId ?? "unknown";
      recordPendingHistoryEntryIfEnabled({
        historyMap: deps.groupHistories,
        historyKey,
        limit: deps.historyLimit,
        entry: {
          sender: senderUsername,
          body: messageText,
          timestamp: msg.sent_at ? msg.sent_at * 1000 : undefined,
          messageId: msg.id ? String(msg.id) : undefined,
        },
      });
      return;
    }

    const senderName = senderUsername;
    const messageId = msg.id ? String(msg.id) : undefined;
    await inboundDebouncer.enqueue({
      senderName,
      senderDisplay,
      senderRecipient,
      senderPeerId,
      groupId,
      groupName,
      isGroup,
      bodyText: messageText,
      timestamp: msg.sent_at ?? undefined,
      messageId,
      commandAuthorized,
      wasMentioned: effectiveWasMentioned,
    });
  };
}
