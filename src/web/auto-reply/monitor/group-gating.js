import { hasControlCommand } from "../../../auto-reply/command-detection.js";
import { parseActivationCommand } from "../../../auto-reply/group-activation.js";
import { recordPendingHistoryEntryIfEnabled } from "../../../auto-reply/reply/history.js";
import { resolveMentionGating } from "../../../channels/mention-gating.js";
import { normalizeE164 } from "../../../utils.js";
import { buildMentionConfig, debugMention, resolveOwnerList } from "../mentions.js";
import { stripMentionsForCommand } from "./commands.js";
import { resolveGroupActivationFor, resolveGroupPolicyFor } from "./group-activation.js";
import { noteGroupMember } from "./group-members.js";
function isOwnerSender(baseMentionConfig, msg) {
    const sender = normalizeE164(msg.senderE164 ?? "");
    if (!sender) {
        return false;
    }
    const owners = resolveOwnerList(baseMentionConfig, msg.selfE164 ?? undefined);
    return owners.includes(sender);
}
function recordPendingGroupHistoryEntry(params) {
    const sender = params.msg.senderName && params.msg.senderE164
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
function skipGroupMessageAndStoreHistory(params, verboseMessage) {
    params.logVerbose(verboseMessage);
    recordPendingGroupHistoryEntry({
        msg: params.msg,
        groupHistories: params.groupHistories,
        groupHistoryKey: params.groupHistoryKey,
        groupHistoryLimit: params.groupHistoryLimit,
    });
    return { shouldProcess: false };
}
export function applyGroupGating(params) {
    const groupPolicy = resolveGroupPolicyFor(params.cfg, params.conversationId);
    if (groupPolicy.allowlistEnabled && !groupPolicy.allowed) {
        params.logVerbose(`Skipping group message ${params.conversationId} (not in allowlist)`);
        return { shouldProcess: false };
    }
    noteGroupMember(params.groupMemberNames, params.groupHistoryKey, params.msg.senderE164, params.msg.senderName);
    const mentionConfig = buildMentionConfig(params.cfg, params.agentId);
    const commandBody = stripMentionsForCommand(params.msg.body, mentionConfig.mentionRegexes, params.msg.selfE164);
    const activationCommand = parseActivationCommand(commandBody);
    const owner = isOwnerSender(params.baseMentionConfig, params.msg);
    const shouldBypassMention = owner && hasControlCommand(commandBody, params.cfg);
    if (activationCommand.hasCommand && !owner) {
        return skipGroupMessageAndStoreHistory(params, `Ignoring /activation from non-owner in group ${params.conversationId}`);
    }
    const mentionDebug = debugMention(params.msg, mentionConfig, params.authDir);
    params.replyLogger.debug({
        conversationId: params.conversationId,
        wasMentioned: mentionDebug.wasMentioned,
        ...mentionDebug.details,
    }, "group mention debug");
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
    const implicitMention = Boolean((selfJid && replySenderJid && selfJid === replySenderJid) ||
        (selfE164 && replySenderE164 && selfE164 === replySenderE164));
    const mentionGate = resolveMentionGating({
        requireMention,
        canDetectMention: true,
        wasMentioned,
        implicitMention,
        shouldBypassMention,
    });
    params.msg.wasMentioned = mentionGate.effectiveWasMentioned;
    if (!shouldBypassMention && requireMention && mentionGate.shouldSkip) {
        return skipGroupMessageAndStoreHistory(params, `Group message stored for context (no mention detected) in ${params.conversationId}: ${params.msg.body}`);
    }
    return { shouldProcess: true };
}
