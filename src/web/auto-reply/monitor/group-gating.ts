import { hasControlCommand } from "../../../auto-reply/command-detection.js";
import { parseActivationCommand } from "../../../auto-reply/group-activation.js";
import { recordPendingHistoryEntryIfEnabled } from "../../../auto-reply/reply/history.js";
import { resolveMentionGating } from "../../../channels/mention-gating.js";
import type { loadConfig } from "../../../config/config.js";
import { normalizeE164 } from "../../../utils.js";
import type { MentionConfig } from "../mentions.js";
import { buildMentionConfig, debugMention, resolveOwnerList } from "../mentions.js";
import type { WebInboundMsg } from "../types.js";
import { stripMentionsForCommand } from "./commands.js";
import { resolveGroupActivationFor, resolveGroupPolicyFor } from "./group-activation.js";
import { noteGroupMember } from "./group-members.js";

export type GroupHistoryEntry = {
  sender: string;
  body: string;
  timestamp?: number;
  id?: string;
  senderJid?: string;
};

const DEFAULT_FOLLOW_UP_WINDOW_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Tracks recent bot replies per group so follow-up messages from the same
 * sender can be treated as implicit mentions.
 *
 * Outer key: group conversation ID.
 * Inner key: sender E.164. Value: timestamp (ms) of the bot's reply.
 */
const groupFollowUpTracker = new Map<string, Map<string, number>>();

/**
 * Record that the bot just replied to `senderE164` in `conversationId`.
 * Call this after every successful auto-reply in a group.
 */
export function recordGroupReply(conversationId: string, senderE164: string): void {
  let senders = groupFollowUpTracker.get(conversationId);
  if (!senders) {
    senders = new Map();
    groupFollowUpTracker.set(conversationId, senders);
  }
  senders.set(senderE164, Date.now());
}

/**
 * Returns true if `senderE164` sent a message to `conversationId` within
 * `windowMs` milliseconds of the bot's last reply to them.
 * Returns false immediately when `windowMs` is 0 (feature disabled).
 */
function isFollowUp(
  conversationId: string,
  senderE164: string | undefined,
  windowMs: number,
): boolean {
  if (!senderE164 || windowMs === 0) {
    return false;
  }
  const senders = groupFollowUpTracker.get(conversationId);
  if (!senders) {
    return false;
  }
  const repliedAt = senders.get(senderE164);
  if (repliedAt === undefined) {
    return false;
  }
  if (Date.now() - repliedAt > windowMs) {
    senders.delete(senderE164);
    if (senders.size === 0) {
      groupFollowUpTracker.delete(conversationId);
    }
    return false;
  }
  return true;
}

/**
 * Test helper: exposes internal follow-up logic for unit tests.
 * @internal
 */
export const isFollowUpForTest = {
  check: isFollowUp,
  reset: () => groupFollowUpTracker.clear(),
};

function isOwnerSender(baseMentionConfig: MentionConfig, msg: WebInboundMsg) {
  const sender = normalizeE164(msg.senderE164 ?? "");
  if (!sender) {
    return false;
  }
  const owners = resolveOwnerList(baseMentionConfig, msg.selfE164 ?? undefined);
  return owners.includes(sender);
}

function recordPendingGroupHistoryEntry(params: {
  msg: WebInboundMsg;
  groupHistories: Map<string, GroupHistoryEntry[]>;
  groupHistoryKey: string;
  groupHistoryLimit: number;
}) {
  const sender =
    params.msg.senderName && params.msg.senderE164
      ? `${params.msg.senderName} (${params.msg.senderE164})`
      : (params.msg.senderName ?? params.msg.senderE164 ?? "Unknown");
  recordPendingHistoryEntryIfEnabled({
    historyMap: params.groupHistories,
    historyKey: params.groupHistoryKey,
    limit: params.groupHistoryLimit,
    entry: {
      sender,
      body: params.msg.body,
      timestamp: params.msg.timestamp,
      id: params.msg.id,
      senderJid: params.msg.senderJid,
    },
  });
}

export function applyGroupGating(params: {
  cfg: ReturnType<typeof loadConfig>;
  msg: WebInboundMsg;
  conversationId: string;
  groupHistoryKey: string;
  agentId: string;
  sessionKey: string;
  baseMentionConfig: MentionConfig;
  authDir?: string;
  groupHistories: Map<string, GroupHistoryEntry[]>;
  groupHistoryLimit: number;
  groupMemberNames: Map<string, Map<string, string>>;
  logVerbose: (msg: string) => void;
  replyLogger: { debug: (obj: unknown, msg: string) => void };
}) {
  const groupPolicy = resolveGroupPolicyFor(params.cfg, params.conversationId);
  if (groupPolicy.allowlistEnabled && !groupPolicy.allowed) {
    params.logVerbose(`Skipping group message ${params.conversationId} (not in allowlist)`);
    return { shouldProcess: false };
  }

  noteGroupMember(
    params.groupMemberNames,
    params.groupHistoryKey,
    params.msg.senderE164,
    params.msg.senderName,
  );

  const mentionConfig = buildMentionConfig(params.cfg, params.agentId);
  const commandBody = stripMentionsForCommand(
    params.msg.body,
    mentionConfig.mentionRegexes,
    params.msg.selfE164,
  );
  const activationCommand = parseActivationCommand(commandBody);
  const owner = isOwnerSender(params.baseMentionConfig, params.msg);
  const shouldBypassMention = owner && hasControlCommand(commandBody, params.cfg);

  if (activationCommand.hasCommand && !owner) {
    params.logVerbose(`Ignoring /activation from non-owner in group ${params.conversationId}`);
    recordPendingGroupHistoryEntry({
      msg: params.msg,
      groupHistories: params.groupHistories,
      groupHistoryKey: params.groupHistoryKey,
      groupHistoryLimit: params.groupHistoryLimit,
    });
    return { shouldProcess: false };
  }

  const mentionDebug = debugMention(params.msg, mentionConfig, params.authDir);
  params.replyLogger.debug(
    {
      conversationId: params.conversationId,
      wasMentioned: mentionDebug.wasMentioned,
      ...mentionDebug.details,
    },
    "group mention debug",
  );
  const wasMentioned = mentionDebug.wasMentioned;
  const activation = resolveGroupActivationFor({
    cfg: params.cfg,
    agentId: params.agentId,
    sessionKey: params.sessionKey,
    conversationId: params.conversationId,
  });
  const requireMention = activation !== "always";
  const selfJid = params.msg.selfJid?.replace(/:\\d+/, "");
  const replySenderJid = params.msg.replyToSenderJid?.replace(/:\\d+/, "");
  const selfE164 = params.msg.selfE164 ? normalizeE164(params.msg.selfE164) : null;
  const replySenderE164 = params.msg.replyToSenderE164
    ? normalizeE164(params.msg.replyToSenderE164)
    : null;
  const isSwipeReply = Boolean(
    (selfJid && replySenderJid && selfJid === replySenderJid) ||
    (selfE164 && replySenderE164 && selfE164 === replySenderE164),
  );
  const followUpWindowMs =
    groupPolicy.groupConfig?.followUpWindowMs ??
    groupPolicy.defaultConfig?.followUpWindowMs ??
    params.cfg.messages?.groupChat?.followUpWindowMs ??
    DEFAULT_FOLLOW_UP_WINDOW_MS;
  const senderNorm = params.msg.senderE164 ? normalizeE164(params.msg.senderE164) : undefined;
  const isConversationFollowUp = isFollowUp(
    params.conversationId,
    senderNorm ?? undefined,
    followUpWindowMs,
  );
  const implicitMention = isSwipeReply || isConversationFollowUp;
  const mentionGate = resolveMentionGating({
    requireMention,
    canDetectMention: true,
    wasMentioned,
    implicitMention,
    shouldBypassMention,
  });
  params.msg.wasMentioned = mentionGate.effectiveWasMentioned;
  if (!shouldBypassMention && requireMention && mentionGate.shouldSkip) {
    params.logVerbose(
      `Group message stored for context (no mention detected) in ${params.conversationId}: ${params.msg.body}`,
    );
    recordPendingGroupHistoryEntry({
      msg: params.msg,
      groupHistories: params.groupHistories,
      groupHistoryKey: params.groupHistoryKey,
      groupHistoryLimit: params.groupHistoryLimit,
    });
    return { shouldProcess: false };
  }

  return { shouldProcess: true };
}
