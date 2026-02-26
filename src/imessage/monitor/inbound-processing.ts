import { hasControlCommand } from "../../auto-reply/command-detection.js";
import {
  formatInboundEnvelope,
  formatInboundFromLabel,
  resolveEnvelopeFormatOptions,
  type EnvelopeFormatOptions,
} from "../../auto-reply/envelope.js";
import {
  buildPendingHistoryContextFromMap,
  recordPendingHistoryEntryIfEnabled,
  type HistoryEntry,
} from "../../auto-reply/reply/history.js";
import { finalizeInboundContext } from "../../auto-reply/reply/inbound-context.js";
import { buildMentionRegexes, matchesMentionPatterns } from "../../auto-reply/reply/mentions.js";
import { resolveControlCommandGate } from "../../channels/command-gating.js";
import { logInboundDrop } from "../../channels/logging.js";
import type { OpenClawConfig } from "../../config/config.js";
import {
  resolveChannelGroupPolicy,
  resolveChannelGroupRequireMention,
} from "../../config/group-policy.js";
import { resolveAgentRoute } from "../../routing/resolve-route.js";
import { resolveEffectiveAllowFromLists } from "../../security/dm-policy-shared.js";
import { truncateUtf16Safe } from "../../utils.js";
import {
  formatIMessageChatTarget,
  isAllowedIMessageSender,
  normalizeIMessageHandle,
} from "../targets.js";
import type { MonitorIMessageOpts, IMessagePayload } from "./types.js";

type IMessageReplyContext = {
  id?: string;
  body: string;
  sender?: string;
};

function normalizeReplyField(value: unknown): string | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed ? trimmed : undefined;
  }
  if (typeof value === "number") {
    return String(value);
  }
  return undefined;
}

function describeReplyContext(message: IMessagePayload): IMessageReplyContext | null {
  const body = normalizeReplyField(message.reply_to_text);
  if (!body) {
    return null;
  }
  const id = normalizeReplyField(message.reply_to_id);
  const sender = normalizeReplyField(message.reply_to_sender);
  return { body, id, sender };
}

export type IMessageInboundDispatchDecision = {
  kind: "dispatch";
  isGroup: boolean;
  chatId?: number;
  chatGuid?: string;
  chatIdentifier?: string;
  groupId?: string;
  historyKey?: string;
  sender: string;
  senderNormalized: string;
  route: ReturnType<typeof resolveAgentRoute>;
  bodyText: string;
  createdAt?: number;
  replyContext: IMessageReplyContext | null;
  effectiveWasMentioned: boolean;
  commandAuthorized: boolean;
  // Used for allowlist checks for control commands.
  effectiveDmAllowFrom: string[];
  effectiveGroupAllowFrom: string[];
};

export type IMessageInboundDecision =
  | { kind: "drop"; reason: string }
  | { kind: "pairing"; senderId: string }
  | IMessageInboundDispatchDecision;

export function resolveIMessageInboundDecision(params: {
  cfg: OpenClawConfig;
  accountId: string;
  message: IMessagePayload;
  opts?: Pick<MonitorIMessageOpts, "requireMention">;
  messageText: string;
  bodyText: string;
  allowFrom: string[];
  groupAllowFrom: string[];
  groupPolicy: string;
  dmPolicy: string;
  storeAllowFrom: string[];
  historyLimit: number;
  groupHistories: Map<string, HistoryEntry[]>;
  echoCache?: { has: (scope: string, lookup: { text?: string; messageId?: string }) => boolean };
  logVerbose?: (msg: string) => void;
}): IMessageInboundDecision {
  const senderRaw = params.message.sender ?? "";
  const sender = senderRaw.trim();
  if (!sender) {
    return { kind: "drop", reason: "missing sender" };
  }
  const senderNormalized = normalizeIMessageHandle(sender);
  if (params.message.is_from_me) {
    return { kind: "drop", reason: "from me" };
  }

  const chatId = params.message.chat_id ?? undefined;
  const chatGuid = params.message.chat_guid ?? undefined;
  const chatIdentifier = params.message.chat_identifier ?? undefined;

  const groupIdCandidate = chatId !== undefined ? String(chatId) : undefined;
  const groupListPolicy = groupIdCandidate
    ? resolveChannelGroupPolicy({
        cfg: params.cfg,
        channel: "imessage",
        accountId: params.accountId,
        groupId: groupIdCandidate,
      })
    : {
        allowlistEnabled: false,
        allowed: true,
        groupConfig: undefined,
        defaultConfig: undefined,
      };

  // If the owner explicitly configures a chat_id under imessage.groups, treat that thread as a
  // "group" for permission gating + session isolation, even when is_group=false.
  const treatAsGroupByConfig = Boolean(
    groupIdCandidate && groupListPolicy.allowlistEnabled && groupListPolicy.groupConfig,
  );
  const isGroup = Boolean(params.message.is_group) || treatAsGroupByConfig;
  if (isGroup && !chatId) {
    return { kind: "drop", reason: "group without chat_id" };
  }

  const groupId = isGroup ? groupIdCandidate : undefined;
  const { effectiveAllowFrom: effectiveDmAllowFrom, effectiveGroupAllowFrom } =
    resolveEffectiveAllowFromLists({
      allowFrom: params.allowFrom,
      groupAllowFrom: params.groupAllowFrom,
      storeAllowFrom: params.storeAllowFrom,
      dmPolicy: params.dmPolicy,
      groupAllowFromFallbackToAllowFrom: false,
    });

  if (isGroup) {
    if (params.groupPolicy === "disabled") {
      params.logVerbose?.("Blocked iMessage group message (groupPolicy: disabled)");
      return { kind: "drop", reason: "groupPolicy disabled" };
    }
    if (params.groupPolicy === "allowlist") {
      if (effectiveGroupAllowFrom.length === 0) {
        params.logVerbose?.(
          "Blocked iMessage group message (groupPolicy: allowlist, no groupAllowFrom)",
        );
        return { kind: "drop", reason: "groupPolicy allowlist (empty groupAllowFrom)" };
      }
      const allowed = isAllowedIMessageSender({
        allowFrom: effectiveGroupAllowFrom,
        sender,
        chatId,
        chatGuid,
        chatIdentifier,
      });
      if (!allowed) {
        params.logVerbose?.(`Blocked iMessage sender ${sender} (not in groupAllowFrom)`);
        return { kind: "drop", reason: "not in groupAllowFrom" };
      }
    }
    if (groupListPolicy.allowlistEnabled && !groupListPolicy.allowed) {
      params.logVerbose?.(
        `imessage: skipping group message (${groupId ?? "unknown"}) not in allowlist`,
      );
      return { kind: "drop", reason: "group id not in allowlist" };
    }
  }

  const dmHasWildcard = effectiveDmAllowFrom.includes("*");
  const dmAuthorized =
    params.dmPolicy === "open"
      ? true
      : dmHasWildcard ||
        (effectiveDmAllowFrom.length > 0 &&
          isAllowedIMessageSender({
            allowFrom: effectiveDmAllowFrom,
            sender,
            chatId,
            chatGuid,
            chatIdentifier,
          }));

  if (!isGroup) {
    if (params.dmPolicy === "disabled") {
      return { kind: "drop", reason: "dmPolicy disabled" };
    }
    if (!dmAuthorized) {
      if (params.dmPolicy === "pairing") {
        return { kind: "pairing", senderId: senderNormalized };
      }
      params.logVerbose?.(`Blocked iMessage sender ${sender} (dmPolicy=${params.dmPolicy})`);
      return { kind: "drop", reason: "dmPolicy blocked" };
    }
  }

  const route = resolveAgentRoute({
    cfg: params.cfg,
    channel: "imessage",
    accountId: params.accountId,
    peer: {
      kind: isGroup ? "group" : "direct",
      id: isGroup ? String(chatId ?? "unknown") : senderNormalized,
    },
  });
  const mentionRegexes = buildMentionRegexes(params.cfg, route.agentId);
  const messageText = params.messageText.trim();
  const bodyText = params.bodyText.trim();
  if (!bodyText) {
    return { kind: "drop", reason: "empty body" };
  }

  // Echo detection: check if the received message matches a recently sent message (within 5 seconds).
  // Scope by conversation so same text in different chats is not conflated.
  const inboundMessageId = params.message.id != null ? String(params.message.id) : undefined;
  if (params.echoCache && (messageText || inboundMessageId)) {
    const echoScope = buildIMessageEchoScope({
      accountId: params.accountId,
      isGroup,
      chatId,
      sender,
    });
    if (
      params.echoCache.has(echoScope, {
        text: messageText || undefined,
        messageId: inboundMessageId,
      })
    ) {
      params.logVerbose?.(
        describeIMessageEchoDropLog({ messageText, messageId: inboundMessageId }),
      );
      return { kind: "drop", reason: "echo" };
    }
  }

  const replyContext = describeReplyContext(params.message);
  const createdAt = params.message.created_at ? Date.parse(params.message.created_at) : undefined;
  const historyKey = isGroup
    ? String(chatId ?? chatGuid ?? chatIdentifier ?? "unknown")
    : undefined;

  const mentioned = isGroup ? matchesMentionPatterns(messageText, mentionRegexes) : true;
  const requireMention = resolveChannelGroupRequireMention({
    cfg: params.cfg,
    channel: "imessage",
    accountId: params.accountId,
    groupId,
    requireMentionOverride: params.opts?.requireMention,
    overrideOrder: "before-config",
  });
  const canDetectMention = mentionRegexes.length > 0;

  const useAccessGroups = params.cfg.commands?.useAccessGroups !== false;
  const ownerAllowedForCommands =
    effectiveDmAllowFrom.length > 0
      ? isAllowedIMessageSender({
          allowFrom: effectiveDmAllowFrom,
          sender,
          chatId,
          chatGuid,
          chatIdentifier,
        })
      : false;
  const groupAllowedForCommands =
    effectiveGroupAllowFrom.length > 0
      ? isAllowedIMessageSender({
          allowFrom: effectiveGroupAllowFrom,
          sender,
          chatId,
          chatGuid,
          chatIdentifier,
        })
      : false;
  const hasControlCommandInMessage = hasControlCommand(messageText, params.cfg);
  const commandGate = resolveControlCommandGate({
    useAccessGroups,
    authorizers: [
      { configured: effectiveDmAllowFrom.length > 0, allowed: ownerAllowedForCommands },
      { configured: effectiveGroupAllowFrom.length > 0, allowed: groupAllowedForCommands },
    ],
    allowTextCommands: true,
    hasControlCommand: hasControlCommandInMessage,
  });
  const commandAuthorized = isGroup ? commandGate.commandAuthorized : dmAuthorized;
  if (isGroup && commandGate.shouldBlock) {
    if (params.logVerbose) {
      logInboundDrop({
        log: params.logVerbose,
        channel: "imessage",
        reason: "control command (unauthorized)",
        target: sender,
      });
    }
    return { kind: "drop", reason: "control command (unauthorized)" };
  }

  const shouldBypassMention =
    isGroup && requireMention && !mentioned && commandAuthorized && hasControlCommandInMessage;
  const effectiveWasMentioned = mentioned || shouldBypassMention;
  if (isGroup && requireMention && canDetectMention && !mentioned && !shouldBypassMention) {
    params.logVerbose?.(`imessage: skipping group message (no mention)`);
    recordPendingHistoryEntryIfEnabled({
      historyMap: params.groupHistories,
      historyKey: historyKey ?? "",
      limit: params.historyLimit,
      entry: historyKey
        ? {
            sender: senderNormalized,
            body: bodyText,
            timestamp: createdAt,
            messageId: params.message.id ? String(params.message.id) : undefined,
          }
        : null,
    });
    return { kind: "drop", reason: "no mention" };
  }

  return {
    kind: "dispatch",
    isGroup,
    chatId,
    chatGuid,
    chatIdentifier,
    groupId,
    historyKey,
    sender,
    senderNormalized,
    route,
    bodyText,
    createdAt,
    replyContext,
    effectiveWasMentioned,
    commandAuthorized,
    effectiveDmAllowFrom,
    effectiveGroupAllowFrom,
  };
}

export function buildIMessageInboundContext(params: {
  cfg: OpenClawConfig;
  decision: IMessageInboundDispatchDecision;
  message: IMessagePayload;
  envelopeOptions?: EnvelopeFormatOptions;
  previousTimestamp?: number;
  remoteHost?: string;
  media?: {
    path?: string;
    type?: string;
    paths?: string[];
    types?: Array<string | undefined>;
  };
  historyLimit: number;
  groupHistories: Map<string, HistoryEntry[]>;
}): {
  ctxPayload: ReturnType<typeof finalizeInboundContext>;
  fromLabel: string;
  chatTarget?: string;
  imessageTo: string;
  inboundHistory?: Array<{ sender: string; body: string; timestamp?: number }>;
} {
  const envelopeOptions = params.envelopeOptions ?? resolveEnvelopeFormatOptions(params.cfg);
  const { decision } = params;
  const chatId = decision.chatId;
  const chatTarget =
    decision.isGroup && chatId != null ? formatIMessageChatTarget(chatId) : undefined;

  const replySuffix = decision.replyContext
    ? `\n\n[Replying to ${decision.replyContext.sender ?? "unknown sender"}${
        decision.replyContext.id ? ` id:${decision.replyContext.id}` : ""
      }]\n${decision.replyContext.body}\n[/Replying]`
    : "";

  const fromLabel = formatInboundFromLabel({
    isGroup: decision.isGroup,
    groupLabel: params.message.chat_name ?? undefined,
    groupId: chatId !== undefined ? String(chatId) : "unknown",
    groupFallback: "Group",
    directLabel: decision.senderNormalized,
    directId: decision.sender,
  });

  const body = formatInboundEnvelope({
    channel: "iMessage",
    from: fromLabel,
    timestamp: decision.createdAt,
    body: `${decision.bodyText}${replySuffix}`,
    chatType: decision.isGroup ? "group" : "direct",
    sender: { name: decision.senderNormalized, id: decision.sender },
    previousTimestamp: params.previousTimestamp,
    envelope: envelopeOptions,
  });

  let combinedBody = body;
  if (decision.isGroup && decision.historyKey) {
    combinedBody = buildPendingHistoryContextFromMap({
      historyMap: params.groupHistories,
      historyKey: decision.historyKey,
      limit: params.historyLimit,
      currentMessage: combinedBody,
      formatEntry: (entry) =>
        formatInboundEnvelope({
          channel: "iMessage",
          from: fromLabel,
          timestamp: entry.timestamp,
          body: `${entry.body}${entry.messageId ? ` [id:${entry.messageId}]` : ""}`,
          chatType: "group",
          senderLabel: entry.sender,
          envelope: envelopeOptions,
        }),
    });
  }

  const imessageTo = (decision.isGroup ? chatTarget : undefined) || `imessage:${decision.sender}`;
  const inboundHistory =
    decision.isGroup && decision.historyKey && params.historyLimit > 0
      ? (params.groupHistories.get(decision.historyKey) ?? []).map((entry) => ({
          sender: entry.sender,
          body: entry.body,
          timestamp: entry.timestamp,
        }))
      : undefined;

  const ctxPayload = finalizeInboundContext({
    Body: combinedBody,
    BodyForAgent: decision.bodyText,
    InboundHistory: inboundHistory,
    RawBody: decision.bodyText,
    CommandBody: decision.bodyText,
    From: decision.isGroup
      ? `imessage:group:${chatId ?? "unknown"}`
      : `imessage:${decision.sender}`,
    To: imessageTo,
    SessionKey: decision.route.sessionKey,
    AccountId: decision.route.accountId,
    ChatType: decision.isGroup ? "group" : "direct",
    ConversationLabel: fromLabel,
    GroupSubject: decision.isGroup ? (params.message.chat_name ?? undefined) : undefined,
    GroupMembers: decision.isGroup
      ? (params.message.participants ?? []).filter(Boolean).join(", ")
      : undefined,
    SenderName: decision.senderNormalized,
    SenderId: decision.sender,
    Provider: "imessage",
    Surface: "imessage",
    MessageSid: params.message.id ? String(params.message.id) : undefined,
    ReplyToId: decision.replyContext?.id,
    ReplyToBody: decision.replyContext?.body,
    ReplyToSender: decision.replyContext?.sender,
    Timestamp: decision.createdAt,
    MediaPath: params.media?.path,
    MediaType: params.media?.type,
    MediaUrl: params.media?.path,
    MediaPaths:
      params.media?.paths && params.media.paths.length > 0 ? params.media.paths : undefined,
    MediaTypes:
      params.media?.types && params.media.types.length > 0 ? params.media.types : undefined,
    MediaUrls:
      params.media?.paths && params.media.paths.length > 0 ? params.media.paths : undefined,
    MediaRemoteHost: params.remoteHost,
    WasMentioned: decision.effectiveWasMentioned,
    CommandAuthorized: decision.commandAuthorized,
    OriginatingChannel: "imessage" as const,
    OriginatingTo: imessageTo,
  });

  return { ctxPayload, fromLabel, chatTarget, imessageTo, inboundHistory };
}

export function buildIMessageEchoScope(params: {
  accountId: string;
  isGroup: boolean;
  chatId?: number;
  sender: string;
}): string {
  return `${params.accountId}:${params.isGroup ? formatIMessageChatTarget(params.chatId) : `imessage:${params.sender}`}`;
}

export function describeIMessageEchoDropLog(params: {
  messageText: string;
  messageId?: string;
}): string {
  const preview = truncateUtf16Safe(params.messageText, 50);
  const messageIdPart = params.messageId ? ` id=${params.messageId}` : "";
  return `imessage: skipping echo message${messageIdPart}: "${preview}"`;
}
