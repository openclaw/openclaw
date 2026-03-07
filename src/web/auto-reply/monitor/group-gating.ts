import { hasControlCommand } from "../../../auto-reply/command-detection.js";
import {
  engagementStates,
  shouldParticipateInGroup,
} from "../../../auto-reply/contextual-activation.js";
import { parseActivationCommand } from "../../../auto-reply/group-activation.js";
import { recordPendingHistoryEntryIfEnabled } from "../../../auto-reply/reply/history.js";
import { resolveMentionGating } from "../../../channels/mention-gating.js";
import type { loadConfig } from "../../../config/config.js";
import { resolveChannelGroupContextualActivation } from "../../../config/group-policy.js";
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
  replyToId?: string;
  replyToBody?: string;
  replyToSender?: string;
};

type ApplyGroupGatingParams = {
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
      replyToId: params.msg.replyToId,
      replyToBody: params.msg.replyToBody,
      replyToSender: params.msg.replyToSender,
    },
  });
}

function skipGroupMessageAndStoreHistory(params: ApplyGroupGatingParams, verboseMessage: string) {
  params.logVerbose(verboseMessage);
  recordPendingGroupHistoryEntry({
    msg: params.msg,
    groupHistories: params.groupHistories,
    groupHistoryKey: params.groupHistoryKey,
    groupHistoryLimit: params.groupHistoryLimit,
  });
  return { shouldProcess: false } as const;
}

export async function applyGroupGating(params: ApplyGroupGatingParams) {
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
    return skipGroupMessageAndStoreHistory(
      params,
      `Ignoring /activation from non-owner in group ${params.conversationId}`,
    );
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
  const implicitMention = Boolean(
    (selfJid && replySenderJid && selfJid === replySenderJid) ||
    (selfE164 && replySenderE164 && selfE164 === replySenderE164),
  );
  const mentionGate = resolveMentionGating({
    requireMention,
    canDetectMention: true,
    wasMentioned,
    implicitMention,
    shouldBypassMention,
  });
  params.msg.wasMentioned = mentionGate.effectiveWasMentioned;

  // Resolve contextual activation config once for both engaged and peeking paths
  const contextualConfig = resolveChannelGroupContextualActivation({
    cfg: params.cfg,
    channel: "whatsapp",
    groupId: params.conversationId,
  });

  // When engaged via contextual activation, skip mention gating and ask the model
  // whether to continue or disengage.
  if (contextualConfig?.model) {
    const engagement = engagementStates.get(params.groupHistoryKey);
    if (engagement?.mode === "engaged") {
      const decision = await callContextualDecision(params, contextualConfig);
      if (decision.shouldProcess) {
        return { shouldProcess: true, contextualActivationHint: decision.reason };
      }
      // Model decided to disengage — fall through to normal mention gating below
    }
  }

  if (!shouldBypassMention && requireMention && mentionGate.shouldSkip) {
    // Contextual activation (peeking): ask a decision model before skipping
    if (contextualConfig?.model) {
      const decision = await callContextualDecision(params, contextualConfig);
      if (decision.shouldProcess) {
        return { shouldProcess: true, contextualActivationHint: decision.reason };
      }
      if (decision.error) {
        params.logVerbose(
          `[contextual-activation] WhatsApp group ${params.conversationId}: error: ${decision.error}`,
        );
      }
    }
    return skipGroupMessageAndStoreHistory(
      params,
      `Group message stored for context (no mention detected) in ${params.conversationId}: ${params.msg.body}`,
    );
  }

  return { shouldProcess: true };
}

async function callContextualDecision(
  params: ApplyGroupGatingParams,
  contextualConfig: NonNullable<ReturnType<typeof resolveChannelGroupContextualActivation>>,
) {
  const existingHistory = params.groupHistories.get(params.groupHistoryKey) ?? [];
  const recentMessages = existingHistory.map((h) => ({
    sender: h.sender,
    body: h.body,
    timestamp: h.timestamp,
    messageId: h.id,
    replyToId: h.replyToId,
    replyToBody: h.replyToBody,
    replyToSender: h.replyToSender,
  }));
  const senderLabel =
    params.msg.senderName && params.msg.senderE164
      ? `${params.msg.senderName} (${params.msg.senderE164})`
      : (params.msg.senderName ?? params.msg.senderE164 ?? "Unknown");
  const imagePaths =
    params.msg.mediaPath && params.msg.mediaType?.startsWith("image/")
      ? [params.msg.mediaPath]
      : undefined;
  return shouldParticipateInGroup({
    cfg: params.cfg,
    config: contextualConfig,
    recentMessages,
    currentMessage: {
      sender: senderLabel,
      body: params.msg.body,
      timestamp: params.msg.timestamp,
      imagePaths,
      messageId: params.msg.id,
      replyToId: params.msg.replyToId,
      replyToBody: params.msg.replyToBody,
      replyToSender: params.msg.replyToSender,
    },
    groupKey: params.groupHistoryKey,
  });
}
