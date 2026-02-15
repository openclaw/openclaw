import { randomUUID } from "node:crypto";
import { loadConfig } from "../config/config.js";
import { resolveMarkdownTableMode } from "../config/markdown-tables.js";
import { getChildLogger } from "../logging/logger.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { convertMarkdownTables } from "../markdown/tables.js";
import { markdownToWhatsApp } from "../markdown/whatsapp.js";
import { normalizePollInput, type PollInput } from "../polls.js";
import { toWhatsappJid } from "../utils.js";
import {
  type ActiveWebSendOptions,
  type MessageKey,
  requireActiveWebListener,
} from "./active-listener.js";
import { loadWebMedia } from "./media.js";

const outboundLog = createSubsystemLogger("gateway/channels/whatsapp").child("outbound");

export async function sendMessageWhatsApp(
  to: string,
  body: string,
  options: {
    verbose: boolean;
    mediaUrl?: string;
    mediaLocalRoots?: readonly string[];
    gifPlayback?: boolean;
    accountId?: string;
  },
): Promise<{ messageId: string; toJid: string }> {
  let text = body;
  const correlationId = randomUUID();
  const startedAt = Date.now();
  const { listener: active, accountId: resolvedAccountId } = requireActiveWebListener(
    options.accountId,
  );
  const cfg = loadConfig();
  const tableMode = resolveMarkdownTableMode({
    cfg,
    channel: "whatsapp",
    accountId: resolvedAccountId ?? options.accountId,
  });
  text = convertMarkdownTables(text ?? "", tableMode);
  text = markdownToWhatsApp(text);
  const logger = getChildLogger({
    module: "web-outbound",
    correlationId,
    to,
  });
  try {
    const jid = toWhatsappJid(to);
    let mediaBuffer: Buffer | undefined;
    let mediaType: string | undefined;
    let documentFileName: string | undefined;
    if (options.mediaUrl) {
      const media = await loadWebMedia(options.mediaUrl, {
        localRoots: options.mediaLocalRoots,
      });
      const caption = text || undefined;
      mediaBuffer = media.buffer;
      mediaType = media.contentType;
      if (media.kind === "audio") {
        // WhatsApp expects explicit opus codec for PTT voice notes.
        mediaType =
          media.contentType === "audio/ogg"
            ? "audio/ogg; codecs=opus"
            : (media.contentType ?? "application/octet-stream");
      } else if (media.kind === "video") {
        text = caption ?? "";
      } else if (media.kind === "image") {
        text = caption ?? "";
      } else {
        text = caption ?? "";
        documentFileName = media.fileName;
      }
    }
    outboundLog.info(`Sending message -> ${jid}${options.mediaUrl ? " (media)" : ""}`);
    logger.info({ jid, hasMedia: Boolean(options.mediaUrl) }, "sending message");
    await active.sendComposingTo(to);
    const hasExplicitAccountId = Boolean(options.accountId?.trim());
    const accountId = hasExplicitAccountId ? resolvedAccountId : undefined;
    const sendOptions: ActiveWebSendOptions | undefined =
      options.gifPlayback || accountId || documentFileName
        ? {
            ...(options.gifPlayback ? { gifPlayback: true } : {}),
            ...(documentFileName ? { fileName: documentFileName } : {}),
            accountId,
          }
        : undefined;
    const result = sendOptions
      ? await active.sendMessage(to, text, mediaBuffer, mediaType, sendOptions)
      : await active.sendMessage(to, text, mediaBuffer, mediaType);
    const messageId = (result as { messageId?: string })?.messageId ?? "unknown";
    const durationMs = Date.now() - startedAt;
    outboundLog.info(
      `Sent message ${messageId} -> ${jid}${options.mediaUrl ? " (media)" : ""} (${durationMs}ms)`,
    );
    logger.info({ jid, messageId }, "sent message");
    return { messageId, toJid: jid };
  } catch (err) {
    logger.error(
      { err: String(err), to, hasMedia: Boolean(options.mediaUrl) },
      "failed to send via web session",
    );
    throw err;
  }
}

export async function sendReactionWhatsApp(
  chatJid: string,
  messageId: string,
  emoji: string,
  options: {
    verbose: boolean;
    fromMe?: boolean;
    participant?: string;
    accountId?: string;
  },
): Promise<void> {
  const correlationId = randomUUID();
  const { listener: active } = requireActiveWebListener(options.accountId);
  const logger = getChildLogger({
    module: "web-outbound",
    correlationId,
    chatJid,
    messageId,
  });
  try {
    const jid = toWhatsappJid(chatJid);
    outboundLog.info(`Sending reaction "${emoji}" -> message ${messageId}`);
    logger.info({ chatJid: jid, messageId, emoji }, "sending reaction");
    await active.sendReaction(
      chatJid,
      messageId,
      emoji,
      options.fromMe ?? false,
      options.participant,
    );
    outboundLog.info(`Sent reaction "${emoji}" -> message ${messageId}`);
    logger.info({ chatJid: jid, messageId, emoji }, "sent reaction");
  } catch (err) {
    logger.error(
      { err: String(err), chatJid, messageId, emoji },
      "failed to send reaction via web session",
    );
    throw err;
  }
}

export async function sendPollWhatsApp(
  to: string,
  poll: PollInput,
  options: { verbose: boolean; accountId?: string },
): Promise<{ messageId: string; toJid: string }> {
  const correlationId = randomUUID();
  const startedAt = Date.now();
  const { listener: active } = requireActiveWebListener(options.accountId);
  const logger = getChildLogger({
    module: "web-outbound",
    correlationId,
    to,
  });
  try {
    const jid = toWhatsappJid(to);
    const normalized = normalizePollInput(poll, { maxOptions: 12 });
    outboundLog.info(`Sending poll -> ${jid}: "${normalized.question}"`);
    logger.info(
      {
        jid,
        question: normalized.question,
        optionCount: normalized.options.length,
        maxSelections: normalized.maxSelections,
      },
      "sending poll",
    );
    const result = await active.sendPoll(to, normalized);
    const messageId = (result as { messageId?: string })?.messageId ?? "unknown";
    const durationMs = Date.now() - startedAt;
    outboundLog.info(`Sent poll ${messageId} -> ${jid} (${durationMs}ms)`);
    logger.info({ jid, messageId }, "sent poll");
    return { messageId, toJid: jid };
  } catch (err) {
    logger.error(
      { err: String(err), to, question: poll.question },
      "failed to send poll via web session",
    );
    throw err;
  }
}

export async function createGroupWhatsApp(
  subject: string,
  participants: string[],
  options: { verbose: boolean; accountId?: string },
): Promise<{ groupId: string; subject: string }> {
  const correlationId = randomUUID();
  const startedAt = Date.now();
  const { listener: active } = requireActiveWebListener(options.accountId);
  const logger = getChildLogger({
    module: "web-outbound",
    correlationId,
    subject,
  });
  try {
    outboundLog.info(`Creating group "${subject}" with ${participants.length} participants`);
    logger.info({ subject, participantCount: participants.length }, "creating WhatsApp group");
    const result = await active.createGroup(subject, participants);
    const durationMs = Date.now() - startedAt;
    outboundLog.info(`Created group "${result.subject}" (${result.groupId}) (${durationMs}ms)`);
    logger.info({ groupId: result.groupId, subject: result.subject }, "created WhatsApp group");
    return result;
  } catch (err) {
    logger.error(
      { err: String(err), subject, participantCount: participants.length },
      "failed to create WhatsApp group",
    );
    throw err;
  }
}

// ===== NEW CAPABILITIES =====

export async function editMessageWhatsApp(
  chatJid: string,
  messageId: string,
  newText: string,
  options: { verbose: boolean; fromMe?: boolean; participant?: string; accountId?: string },
): Promise<void> {
  const correlationId = randomUUID();
  const { listener: active } = requireActiveWebListener(options.accountId);
  const logger = getChildLogger({ module: "web-outbound", correlationId, chatJid, messageId });
  try {
    const jid = toWhatsappJid(chatJid);
    outboundLog.info(`Editing message ${messageId} in ${jid}`);
    logger.info({ chatJid: jid, messageId }, "editing message");
    await active.editMessage(chatJid, messageId, newText, options.fromMe, options.participant);
    outboundLog.info(`Edited message ${messageId}`);
    logger.info({ chatJid: jid, messageId }, "edited message");
  } catch (err) {
    logger.error({ err: String(err), chatJid, messageId }, "failed to edit message");
    throw err;
  }
}

export async function deleteMessageWhatsApp(
  chatJid: string,
  messageId: string,
  options: { verbose: boolean; fromMe?: boolean; participant?: string; accountId?: string },
): Promise<void> {
  const correlationId = randomUUID();
  const { listener: active } = requireActiveWebListener(options.accountId);
  const logger = getChildLogger({ module: "web-outbound", correlationId, chatJid, messageId });
  try {
    const jid = toWhatsappJid(chatJid);
    outboundLog.info(`Deleting message ${messageId} in ${jid}`);
    logger.info({ chatJid: jid, messageId }, "deleting message");
    await active.deleteMessage(chatJid, messageId, options.fromMe, options.participant);
    outboundLog.info(`Deleted message ${messageId}`);
    logger.info({ chatJid: jid, messageId }, "deleted message");
  } catch (err) {
    logger.error({ err: String(err), chatJid, messageId }, "failed to delete message");
    throw err;
  }
}

export async function replyMessageWhatsApp(
  to: string,
  text: string,
  quotedKey: MessageKey,
  options: { verbose: boolean; mediaUrl?: string; accountId?: string },
): Promise<{ messageId: string; toJid: string }> {
  const correlationId = randomUUID();
  const startedAt = Date.now();
  const { listener: active } = requireActiveWebListener(options.accountId);
  const logger = getChildLogger({ module: "web-outbound", correlationId, to });
  try {
    const jid = toWhatsappJid(to);
    let mediaBuffer: Buffer | undefined;
    let mediaType: string | undefined;
    if (options.mediaUrl) {
      const media = await loadWebMedia(options.mediaUrl);
      mediaBuffer = media.buffer;
      mediaType = media.contentType;
    }
    outboundLog.info(`Replying to message ${quotedKey.id} in ${jid}`);
    logger.info({ jid, quotedMessageId: quotedKey.id }, "replying to message");
    const result = await active.replyMessage(to, text, quotedKey, mediaBuffer, mediaType);
    const durationMs = Date.now() - startedAt;
    outboundLog.info(`Sent reply ${result.messageId} -> ${jid} (${durationMs}ms)`);
    logger.info({ jid, messageId: result.messageId }, "sent reply");
    return { messageId: result.messageId, toJid: jid };
  } catch (err) {
    logger.error({ err: String(err), to, quotedMessageId: quotedKey.id }, "failed to send reply");
    throw err;
  }
}

export async function sendStickerWhatsApp(
  to: string,
  stickerPath: string,
  options: { verbose: boolean; accountId?: string },
): Promise<{ messageId: string; toJid: string }> {
  const correlationId = randomUUID();
  const startedAt = Date.now();
  const { listener: active } = requireActiveWebListener(options.accountId);
  const logger = getChildLogger({ module: "web-outbound", correlationId, to });
  try {
    const jid = toWhatsappJid(to);
    const media = await loadWebMedia(stickerPath);
    outboundLog.info(`Sending sticker -> ${jid}`);
    logger.info({ jid }, "sending sticker");
    const result = await active.sendSticker(to, media.buffer);
    const durationMs = Date.now() - startedAt;
    outboundLog.info(`Sent sticker ${result.messageId} -> ${jid} (${durationMs}ms)`);
    logger.info({ jid, messageId: result.messageId }, "sent sticker");
    return { messageId: result.messageId, toJid: jid };
  } catch (err) {
    logger.error({ err: String(err), to }, "failed to send sticker");
    throw err;
  }
}

// ===== GROUP MANAGEMENT =====

export async function groupUpdateSubjectWhatsApp(
  groupJid: string,
  newSubject: string,
  options: { verbose: boolean; accountId?: string },
): Promise<void> {
  const correlationId = randomUUID();
  const { listener: active } = requireActiveWebListener(options.accountId);
  const logger = getChildLogger({ module: "web-outbound", correlationId, groupJid });
  try {
    const jid = toWhatsappJid(groupJid);
    outboundLog.info(`Updating group subject: ${jid} -> "${newSubject}"`);
    logger.info({ groupJid: jid, newSubject }, "updating group subject");
    await active.groupUpdateSubject(groupJid, newSubject);
    outboundLog.info(`Updated group subject: ${jid}`);
    logger.info({ groupJid: jid }, "updated group subject");
  } catch (err) {
    logger.error({ err: String(err), groupJid, newSubject }, "failed to update group subject");
    throw err;
  }
}

export async function groupUpdateDescriptionWhatsApp(
  groupJid: string,
  description: string,
  options: { verbose: boolean; accountId?: string },
): Promise<void> {
  const correlationId = randomUUID();
  const { listener: active } = requireActiveWebListener(options.accountId);
  const logger = getChildLogger({ module: "web-outbound", correlationId, groupJid });
  try {
    const jid = toWhatsappJid(groupJid);
    outboundLog.info(`Updating group description: ${jid}`);
    logger.info({ groupJid: jid }, "updating group description");
    await active.groupUpdateDescription(groupJid, description);
    outboundLog.info(`Updated group description: ${jid}`);
    logger.info({ groupJid: jid }, "updated group description");
  } catch (err) {
    logger.error({ err: String(err), groupJid }, "failed to update group description");
    throw err;
  }
}

export async function groupUpdateIconWhatsApp(
  groupJid: string,
  imagePath: string,
  options: { verbose: boolean; accountId?: string },
): Promise<void> {
  const correlationId = randomUUID();
  const { listener: active } = requireActiveWebListener(options.accountId);
  const logger = getChildLogger({ module: "web-outbound", correlationId, groupJid });
  try {
    const jid = toWhatsappJid(groupJid);
    const media = await loadWebMedia(imagePath);
    outboundLog.info(`Updating group icon: ${jid}`);
    logger.info({ groupJid: jid }, "updating group icon");
    await active.groupUpdateIcon(groupJid, media.buffer);
    outboundLog.info(`Updated group icon: ${jid}`);
    logger.info({ groupJid: jid }, "updated group icon");
  } catch (err) {
    logger.error({ err: String(err), groupJid }, "failed to update group icon");
    throw err;
  }
}

export async function groupAddParticipantsWhatsApp(
  groupJid: string,
  participants: string[],
  options: { verbose: boolean; accountId?: string },
): Promise<{ [jid: string]: string }> {
  const correlationId = randomUUID();
  const { listener: active } = requireActiveWebListener(options.accountId);
  const logger = getChildLogger({ module: "web-outbound", correlationId, groupJid });
  try {
    const jid = toWhatsappJid(groupJid);
    outboundLog.info(`Adding ${participants.length} participants to group ${jid}`);
    logger.info({ groupJid: jid, participantCount: participants.length }, "adding participants");
    const result = await active.groupAddParticipants(groupJid, participants);
    outboundLog.info(`Added participants to group ${jid}`);
    logger.info({ groupJid: jid, result }, "added participants");
    return result;
  } catch (err) {
    logger.error({ err: String(err), groupJid, participants }, "failed to add participants");
    throw err;
  }
}

export async function groupRemoveParticipantsWhatsApp(
  groupJid: string,
  participants: string[],
  options: { verbose: boolean; accountId?: string },
): Promise<{ [jid: string]: string }> {
  const correlationId = randomUUID();
  const { listener: active } = requireActiveWebListener(options.accountId);
  const logger = getChildLogger({ module: "web-outbound", correlationId, groupJid });
  try {
    const jid = toWhatsappJid(groupJid);
    outboundLog.info(`Removing ${participants.length} participants from group ${jid}`);
    logger.info({ groupJid: jid, participantCount: participants.length }, "removing participants");
    const result = await active.groupRemoveParticipants(groupJid, participants);
    outboundLog.info(`Removed participants from group ${jid}`);
    logger.info({ groupJid: jid, result }, "removed participants");
    return result;
  } catch (err) {
    logger.error({ err: String(err), groupJid, participants }, "failed to remove participants");
    throw err;
  }
}

export async function groupPromoteParticipantsWhatsApp(
  groupJid: string,
  participants: string[],
  options: { verbose: boolean; accountId?: string },
): Promise<{ [jid: string]: string }> {
  const correlationId = randomUUID();
  const { listener: active } = requireActiveWebListener(options.accountId);
  const logger = getChildLogger({ module: "web-outbound", correlationId, groupJid });
  try {
    const jid = toWhatsappJid(groupJid);
    outboundLog.info(`Promoting ${participants.length} participants in group ${jid}`);
    logger.info({ groupJid: jid, participantCount: participants.length }, "promoting participants");
    const result = await active.groupPromoteParticipants(groupJid, participants);
    outboundLog.info(`Promoted participants in group ${jid}`);
    logger.info({ groupJid: jid, result }, "promoted participants");
    return result;
  } catch (err) {
    logger.error({ err: String(err), groupJid, participants }, "failed to promote participants");
    throw err;
  }
}

export async function groupDemoteParticipantsWhatsApp(
  groupJid: string,
  participants: string[],
  options: { verbose: boolean; accountId?: string },
): Promise<{ [jid: string]: string }> {
  const correlationId = randomUUID();
  const { listener: active } = requireActiveWebListener(options.accountId);
  const logger = getChildLogger({ module: "web-outbound", correlationId, groupJid });
  try {
    const jid = toWhatsappJid(groupJid);
    outboundLog.info(`Demoting ${participants.length} participants in group ${jid}`);
    logger.info({ groupJid: jid, participantCount: participants.length }, "demoting participants");
    const result = await active.groupDemoteParticipants(groupJid, participants);
    outboundLog.info(`Demoted participants in group ${jid}`);
    logger.info({ groupJid: jid, result }, "demoted participants");
    return result;
  } catch (err) {
    logger.error({ err: String(err), groupJid, participants }, "failed to demote participants");
    throw err;
  }
}

export async function groupLeaveWhatsApp(
  groupJid: string,
  options: { verbose: boolean; accountId?: string },
): Promise<void> {
  const correlationId = randomUUID();
  const { listener: active } = requireActiveWebListener(options.accountId);
  const logger = getChildLogger({ module: "web-outbound", correlationId, groupJid });
  try {
    const jid = toWhatsappJid(groupJid);
    outboundLog.info(`Leaving group ${jid}`);
    logger.info({ groupJid: jid }, "leaving group");
    await active.groupLeave(groupJid);
    outboundLog.info(`Left group ${jid}`);
    logger.info({ groupJid: jid }, "left group");
  } catch (err) {
    logger.error({ err: String(err), groupJid }, "failed to leave group");
    throw err;
  }
}

export async function groupGetInviteCodeWhatsApp(
  groupJid: string,
  options: { verbose: boolean; accountId?: string },
): Promise<string> {
  const correlationId = randomUUID();
  const { listener: active } = requireActiveWebListener(options.accountId);
  const logger = getChildLogger({ module: "web-outbound", correlationId, groupJid });
  try {
    const jid = toWhatsappJid(groupJid);
    outboundLog.info(`Getting invite code for group ${jid}`);
    logger.info({ groupJid: jid }, "getting invite code");
    const code = await active.groupGetInviteCode(groupJid);
    outboundLog.info(`Got invite code for group ${jid}`);
    logger.info({ groupJid: jid }, "got invite code");
    return code;
  } catch (err) {
    logger.error({ err: String(err), groupJid }, "failed to get invite code");
    throw err;
  }
}

export async function groupRevokeInviteCodeWhatsApp(
  groupJid: string,
  options: { verbose: boolean; accountId?: string },
): Promise<string> {
  const correlationId = randomUUID();
  const { listener: active } = requireActiveWebListener(options.accountId);
  const logger = getChildLogger({ module: "web-outbound", correlationId, groupJid });
  try {
    const jid = toWhatsappJid(groupJid);
    outboundLog.info(`Revoking invite code for group ${jid}`);
    logger.info({ groupJid: jid }, "revoking invite code");
    const newCode = await active.groupRevokeInviteCode(groupJid);
    outboundLog.info(`Revoked invite code for group ${jid}`);
    logger.info({ groupJid: jid }, "revoked invite code");
    return newCode;
  } catch (err) {
    logger.error({ err: String(err), groupJid }, "failed to revoke invite code");
    throw err;
  }
}

export async function groupGetMetadataWhatsApp(
  groupJid: string,
  options: { verbose: boolean; accountId?: string },
): Promise<{
  id: string;
  subject: string;
  description?: string;
  participants: Array<{ id: string; admin?: string }>;
}> {
  const correlationId = randomUUID();
  const { listener: active } = requireActiveWebListener(options.accountId);
  const logger = getChildLogger({ module: "web-outbound", correlationId, groupJid });
  try {
    const jid = toWhatsappJid(groupJid);
    outboundLog.info(`Getting metadata for group ${jid}`);
    logger.info({ groupJid: jid }, "getting group metadata");
    const meta = await active.groupMetadata(groupJid);
    outboundLog.info(`Got metadata for group ${jid}`);
    logger.info(
      { groupJid: jid, participantCount: meta.participants.length },
      "got group metadata",
    );
    return meta;
  } catch (err) {
    logger.error({ err: String(err), groupJid }, "failed to get group metadata");
    throw err;
  }
}
