import { randomUUID } from "node:crypto";
import { loadConfig } from "../config/config.js";
import { resolveMarkdownTableMode } from "../config/markdown-tables.js";
import { getChildLogger } from "../logging/logger.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { convertMarkdownTables } from "../markdown/tables.js";
import { markdownToWhatsApp } from "../markdown/whatsapp.js";
import { normalizePollInput, type PollInput } from "../polls.js";
import { toWhatsappJid } from "../utils.js";
import { type ActiveWebSendOptions, requireActiveWebListener } from "./active-listener.js";
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

// ─────────────────────────────────────────────────────────────────────────────
// Group Admin Functions
// ─────────────────────────────────────────────────────────────────────────────

export type GroupParticipantAction = "add" | "remove" | "promote" | "demote";
export type GroupSettingValue = "announcement" | "not_announcement" | "locked" | "unlocked";

export async function updateGroupSubjectWhatsApp(
  groupJid: string,
  subject: string,
  options: { accountId?: string },
): Promise<void> {
  const { listener: active } = requireActiveWebListener(options.accountId);
  const jid = toWhatsappJid(groupJid);
  outboundLog.info(`Updating group subject -> ${jid}: "${subject}"`);
  await active.updateGroupSubject(jid, subject);
  outboundLog.info(`Updated group subject -> ${jid}`);
}

export async function updateGroupDescriptionWhatsApp(
  groupJid: string,
  description: string | undefined,
  options: { accountId?: string },
): Promise<void> {
  const { listener: active } = requireActiveWebListener(options.accountId);
  const jid = toWhatsappJid(groupJid);
  outboundLog.info(`Updating group description -> ${jid}`);
  await active.updateGroupDescription(jid, description);
  outboundLog.info(`Updated group description -> ${jid}`);
}

export async function updateGroupPhotoWhatsApp(
  groupJid: string,
  image: Buffer,
  options: { accountId?: string },
): Promise<void> {
  const { listener: active } = requireActiveWebListener(options.accountId);
  const jid = toWhatsappJid(groupJid);
  outboundLog.info(`Updating group photo -> ${jid}`);
  await active.updateGroupPhoto(jid, image);
  outboundLog.info(`Updated group photo -> ${jid}`);
}

export async function updateGroupParticipantsWhatsApp(
  groupJid: string,
  participants: string[],
  action: GroupParticipantAction,
  options: { accountId?: string },
): Promise<{ status: string; jid: string }[]> {
  const { listener: active } = requireActiveWebListener(options.accountId);
  const jid = toWhatsappJid(groupJid);
  // Normalize participants to JIDs here (single normalization layer)
  const participantJids = participants.map((p) => toWhatsappJid(p));
  outboundLog.info(`Updating group participants -> ${jid}: ${action} ${participantJids.length} participants`);
  const result = await active.updateGroupParticipants(jid, participantJids, action);
  outboundLog.info(`Updated group participants -> ${jid}`);
  return result;
}

export async function updateGroupSettingsWhatsApp(
  groupJid: string,
  setting: GroupSettingValue,
  options: { accountId?: string },
): Promise<void> {
  const { listener: active } = requireActiveWebListener(options.accountId);
  const jid = toWhatsappJid(groupJid);
  outboundLog.info(`Updating group settings -> ${jid}: ${setting}`);
  await active.updateGroupSettings(jid, setting);
  outboundLog.info(`Updated group settings -> ${jid}`);
}
