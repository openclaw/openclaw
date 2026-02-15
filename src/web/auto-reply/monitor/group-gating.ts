import type { loadConfig } from "../../../config/config.js";
import type { MentionConfig } from "../mentions.js";
import type { WebInboundMsg } from "../types.js";
import { hasControlCommand } from "../../../auto-reply/command-detection.js";
import { parseActivationCommand } from "../../../auto-reply/group-activation.js";
import { recordPendingHistoryEntryIfEnabled } from "../../../auto-reply/reply/history.js";
import { resolveMentionGating } from "../../../channels/mention-gating.js";
import { normalizeE164 } from "../../../utils.js";
import { buildMentionConfig, debugMention, resolveOwnerList } from "../mentions.js";
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

// WhatsApp audio preflight transcription for group mention detection
async function maybeTranscribeAudioForMention(
  msg: WebInboundMsg,
  cfg: ReturnType<typeof loadConfig>,
  authDir?: string,
): Promise<string | undefined> {
  // Only for WhatsApp groups with audio and no text
  const hasAudio = Boolean(msg.mediaPath || msg.mediaUrl);
  const hasMediaType = msg.mediaType?.startsWith("audio/");
  const hasText = msg.body && msg.body.trim().length > 0 && !msg.body.startsWith("<");
  if (!hasAudio || !hasMediaType || hasText) {
    return undefined;
  }

  // Check if mention gating is enabled
  const activation = resolveGroupActivationFor({
    cfg,
    agentId: "main",
    sessionKey: "",
    conversationId: msg.conversationId ?? msg.from,
  });
  if (activation === "always") {
    return undefined; // No mention required
  }

  try {
    const { transcribeFirstAudio } = await import("../../../media-understanding/audio-preflight.js");
    const tempCtx = {
      mediaPath: msg.mediaPath,
      mediaUrl: msg.mediaUrl,
      mediaType: msg.mediaType,
    };
    const transcript = await transcribeFirstAudio({
      ctx: tempCtx,
      cfg,
      agentDir: authDir,
    });
    return transcript;
  } catch {
    return undefined; // Transcription failed, skip
  }
}

function isOwnerSender(baseMentionConfig: MentionConfig, msg: WebInboundMsg) {
  const sender = normalizeE164(msg.senderE164 ?? "");
  if (!sender) {
    return false;
  }
  const owners = resolveOwnerList(baseMentionConfig, msg.selfE164 ?? undefined);
  return owners.includes(sender);
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
    return { shouldProcess: false };
  }

  const mentionDebug = debugMention(params.msg, mentionConfig, params.authDir);
  
  // Audio preflight transcription for WhatsApp group mention detection
  // If message has audio but no text, transcribe to check for mention in speech
  let wasMentioned = mentionDebug.wasMentioned;
  if (!wasMentioned && params.msg.chatType === "group") {
    const preflightTranscript = await maybeTranscribeAudioForMention(
      params.msg,
      params.cfg,
      params.authDir,
    );
    if (preflightTranscript) {
      // Check if transcript contains mention patterns
      const transcriptText = preflightTranscript.toLowerCase();
      const mentionedInAudio = mentionConfig.mentionRegexes.some((re) => re.test(transcriptText));
      if (mentionedInAudio) {
        wasMentioned = true;
        params.logVerbose(`WhatsApp: mention detected in audio transcript`);
      }
    }
  }
  
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
  if (!shouldBypassMention && requireMention && mentionGate.shouldSkip) {
    params.logVerbose(
      `Group message stored for context (no mention detected) in ${params.conversationId}: ${params.msg.body}`,
    );
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
    return { shouldProcess: false };
  }

  return { shouldProcess: true };
}
