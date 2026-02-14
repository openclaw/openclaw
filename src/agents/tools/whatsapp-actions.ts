import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import type { OpenClawConfig } from "../../config/config.js";
import {
  createGroupWhatsApp,
  sendReactionWhatsApp,
  editMessageWhatsApp,
  deleteMessageWhatsApp,
  replyMessageWhatsApp,
  sendStickerWhatsApp,
  groupUpdateSubjectWhatsApp,
  groupUpdateDescriptionWhatsApp,
  groupUpdateIconWhatsApp,
  groupAddParticipantsWhatsApp,
  groupRemoveParticipantsWhatsApp,
  groupPromoteParticipantsWhatsApp,
  groupDemoteParticipantsWhatsApp,
  groupLeaveWhatsApp,
  groupGetInviteCodeWhatsApp,
  groupRevokeInviteCodeWhatsApp,
  groupGetMetadataWhatsApp,
} from "../../web/outbound.js";
import { createActionGate, jsonResult, readReactionParams, readStringParam } from "./common.js";

export async function handleWhatsAppAction(
  params: Record<string, unknown>,
  cfg: OpenClawConfig,
): Promise<AgentToolResult<unknown>> {
  const action = readStringParam(params, "action", { required: true });
  const isActionEnabled = createActionGate(cfg.channels?.whatsapp?.actions);
  const accountId = readStringParam(params, "accountId");

  // ===== REACTIONS =====
  if (action === "react") {
    if (!isActionEnabled("reactions")) {
      throw new Error("WhatsApp reactions are disabled.");
    }
    const chatJid = readStringParam(params, "chatJid", { required: true });
    const messageId = readStringParam(params, "messageId", { required: true });
    const { emoji, remove, isEmpty } = readReactionParams(params, {
      removeErrorMessage: "Emoji is required to remove a WhatsApp reaction.",
    });
    const participant = readStringParam(params, "participant");
    const fromMeRaw = params.fromMe;
    const fromMe = typeof fromMeRaw === "boolean" ? fromMeRaw : undefined;
    const resolvedEmoji = remove ? "" : emoji;
    await sendReactionWhatsApp(chatJid, messageId, resolvedEmoji, {
      verbose: false,
      fromMe,
      participant: participant ?? undefined,
      accountId: accountId ?? undefined,
    });
    if (!remove && !isEmpty) {
      return jsonResult({ ok: true, added: emoji });
    }
    return jsonResult({ ok: true, removed: true });
  }

  // ===== GROUP CREATE =====
  if (action === "group-create") {
    if (!isActionEnabled("groupCreate")) {
      throw new Error("WhatsApp group creation is disabled.");
    }
    const name = readStringParam(params, "name", { required: true });
    const participantsRaw = params.participants;
    // Also accept singular "participant" from the message tool schema
    const singleParticipant =
      typeof params.participant === "string" ? params.participant.trim() : "";
    const participants = Array.isArray(participantsRaw)
      ? participantsRaw.map((p) => String(p).trim()).filter(Boolean)
      : singleParticipant
        ? [singleParticipant]
        : [];

    if (participants.length === 0) {
      throw new Error("participants array is required (phone numbers in E.164 format)");
    }

    const result = await createGroupWhatsApp(name, participants, {
      verbose: false,
      accountId: accountId ?? undefined,
    });

    return jsonResult({
      ok: true,
      groupId: result.groupId,
      subject: result.subject,
      message: `Created WhatsApp group "${result.subject}"`,
    });
  }

  // ===== EDIT MESSAGE =====
  if (action === "edit") {
    if (!isActionEnabled("edit")) {
      throw new Error("WhatsApp message editing is disabled.");
    }
    const chatJid = readStringParam(params, "chatJid", { required: true });
    const messageId = readStringParam(params, "messageId", { required: true });
    const newText = readStringParam(params, "newText", { required: true });
    const fromMe = typeof params.fromMe === "boolean" ? params.fromMe : true;
    const participant = readStringParam(params, "participant");

    await editMessageWhatsApp(chatJid, messageId, newText, {
      verbose: false,
      fromMe,
      participant: participant ?? undefined,
      accountId: accountId ?? undefined,
    });

    return jsonResult({ ok: true, edited: true, messageId });
  }

  // ===== DELETE/UNSEND MESSAGE =====
  if (action === "unsend" || action === "delete") {
    if (!isActionEnabled("unsend")) {
      throw new Error("WhatsApp message deletion is disabled.");
    }
    const chatJid = readStringParam(params, "chatJid", { required: true });
    const messageId = readStringParam(params, "messageId", { required: true });
    const fromMe = typeof params.fromMe === "boolean" ? params.fromMe : true;
    const participant = readStringParam(params, "participant");

    await deleteMessageWhatsApp(chatJid, messageId, {
      verbose: false,
      fromMe,
      participant: participant ?? undefined,
      accountId: accountId ?? undefined,
    });

    return jsonResult({ ok: true, deleted: true, messageId });
  }

  // ===== REPLY (QUOTE) =====
  if (action === "reply") {
    if (!isActionEnabled("reply")) {
      throw new Error("WhatsApp reply/quote is disabled.");
    }
    const to = readStringParam(params, "to", { required: true });
    const text = readStringParam(params, "text", { required: true });
    const quotedKey = params.quotedKey as {
      remoteJid: string;
      id: string;
      fromMe: boolean;
      participant?: string;
    };
    if (!quotedKey || !quotedKey.id) {
      throw new Error("quotedKey with id is required for reply action");
    }
    const mediaUrl = readStringParam(params, "mediaUrl");

    const result = await replyMessageWhatsApp(to, text, quotedKey, {
      verbose: false,
      mediaUrl: mediaUrl ?? undefined,
      accountId: accountId ?? undefined,
    });

    return jsonResult({
      ok: true,
      messageId: result.messageId,
      toJid: result.toJid,
      quotedMessageId: quotedKey.id,
    });
  }

  // ===== SEND STICKER =====
  if (action === "sticker") {
    if (!isActionEnabled("sticker")) {
      throw new Error("WhatsApp stickers are disabled.");
    }
    const to = readStringParam(params, "to", { required: true });
    const stickerPath = readStringParam(params, "stickerPath", { required: true });

    const result = await sendStickerWhatsApp(to, stickerPath, {
      verbose: false,
      accountId: accountId ?? undefined,
    });

    return jsonResult({ ok: true, messageId: result.messageId, toJid: result.toJid });
  }

  // ===== GROUP RENAME =====
  if (action === "renameGroup") {
    if (!isActionEnabled("renameGroup")) {
      throw new Error("WhatsApp group renaming is disabled.");
    }
    const groupJid = readStringParam(params, "groupJid", { required: true });
    const newName = readStringParam(params, "newName", { required: true });

    await groupUpdateSubjectWhatsApp(groupJid, newName, {
      verbose: false,
      accountId: accountId ?? undefined,
    });

    return jsonResult({ ok: true, renamed: true, groupJid, newName });
  }

  // ===== GROUP DESCRIPTION =====
  if (action === "setGroupDescription") {
    if (!isActionEnabled("setGroupDescription")) {
      throw new Error("WhatsApp group description editing is disabled.");
    }
    const groupJid = readStringParam(params, "groupJid", { required: true });
    const description = readStringParam(params, "description", { required: true });

    await groupUpdateDescriptionWhatsApp(groupJid, description, {
      verbose: false,
      accountId: accountId ?? undefined,
    });

    return jsonResult({ ok: true, updated: true, groupJid });
  }

  // ===== GROUP ICON =====
  if (action === "setGroupIcon") {
    if (!isActionEnabled("setGroupIcon")) {
      throw new Error("WhatsApp group icon editing is disabled.");
    }
    const groupJid = readStringParam(params, "groupJid", { required: true });
    const imagePath = readStringParam(params, "imagePath", { required: true });

    await groupUpdateIconWhatsApp(groupJid, imagePath, {
      verbose: false,
      accountId: accountId ?? undefined,
    });

    return jsonResult({ ok: true, iconUpdated: true, groupJid });
  }

  // ===== ADD PARTICIPANTS =====
  if (action === "addParticipant") {
    if (!isActionEnabled("addParticipant")) {
      throw new Error("WhatsApp adding participants is disabled.");
    }
    const groupJid = readStringParam(params, "groupJid", { required: true });
    const participantsRaw = params.participants;
    const participants = Array.isArray(participantsRaw)
      ? participantsRaw.map((p) => String(p).trim()).filter(Boolean)
      : [];

    if (participants.length === 0) {
      throw new Error("participants array is required");
    }

    const result = await groupAddParticipantsWhatsApp(groupJid, participants, {
      verbose: false,
      accountId: accountId ?? undefined,
    });

    return jsonResult({ ok: true, added: result, groupJid });
  }

  // ===== REMOVE PARTICIPANTS =====
  if (action === "removeParticipant") {
    if (!isActionEnabled("removeParticipant")) {
      throw new Error("WhatsApp removing participants is disabled.");
    }
    const groupJid = readStringParam(params, "groupJid", { required: true });
    const participantsRaw = params.participants;
    const participants = Array.isArray(participantsRaw)
      ? participantsRaw.map((p) => String(p).trim()).filter(Boolean)
      : [];

    if (participants.length === 0) {
      throw new Error("participants array is required");
    }

    const result = await groupRemoveParticipantsWhatsApp(groupJid, participants, {
      verbose: false,
      accountId: accountId ?? undefined,
    });

    return jsonResult({ ok: true, removed: result, groupJid });
  }

  // ===== PROMOTE PARTICIPANTS =====
  if (action === "promoteParticipant") {
    if (!isActionEnabled("promoteParticipant")) {
      throw new Error("WhatsApp promoting participants is disabled.");
    }
    const groupJid = readStringParam(params, "groupJid", { required: true });
    const participantsRaw = params.participants;
    const participants = Array.isArray(participantsRaw)
      ? participantsRaw.map((p) => String(p).trim()).filter(Boolean)
      : [];

    if (participants.length === 0) {
      throw new Error("participants array is required");
    }

    const result = await groupPromoteParticipantsWhatsApp(groupJid, participants, {
      verbose: false,
      accountId: accountId ?? undefined,
    });

    return jsonResult({ ok: true, promoted: result, groupJid });
  }

  // ===== DEMOTE PARTICIPANTS =====
  if (action === "demoteParticipant") {
    if (!isActionEnabled("demoteParticipant")) {
      throw new Error("WhatsApp demoting participants is disabled.");
    }
    const groupJid = readStringParam(params, "groupJid", { required: true });
    const participantsRaw = params.participants;
    const participants = Array.isArray(participantsRaw)
      ? participantsRaw.map((p) => String(p).trim()).filter(Boolean)
      : [];

    if (participants.length === 0) {
      throw new Error("participants array is required");
    }

    const result = await groupDemoteParticipantsWhatsApp(groupJid, participants, {
      verbose: false,
      accountId: accountId ?? undefined,
    });

    return jsonResult({ ok: true, demoted: result, groupJid });
  }

  // ===== LEAVE GROUP =====
  if (action === "leaveGroup") {
    if (!isActionEnabled("leaveGroup")) {
      throw new Error("WhatsApp leaving groups is disabled.");
    }
    const groupJid = readStringParam(params, "groupJid", { required: true });

    await groupLeaveWhatsApp(groupJid, {
      verbose: false,
      accountId: accountId ?? undefined,
    });

    return jsonResult({ ok: true, left: true, groupJid });
  }

  // ===== GET INVITE CODE =====
  if (action === "getInviteCode") {
    if (!isActionEnabled("getInviteCode")) {
      throw new Error("WhatsApp getting invite codes is disabled.");
    }
    const groupJid = readStringParam(params, "groupJid", { required: true });

    const code = await groupGetInviteCodeWhatsApp(groupJid, {
      verbose: false,
      accountId: accountId ?? undefined,
    });

    return jsonResult({
      ok: true,
      inviteCode: code,
      inviteLink: `https://chat.whatsapp.com/${code}`,
      groupJid,
    });
  }

  // ===== REVOKE INVITE CODE =====
  if (action === "revokeInviteCode") {
    if (!isActionEnabled("revokeInviteCode")) {
      throw new Error("WhatsApp revoking invite codes is disabled.");
    }
    const groupJid = readStringParam(params, "groupJid", { required: true });

    const newCode = await groupRevokeInviteCodeWhatsApp(groupJid, {
      verbose: false,
      accountId: accountId ?? undefined,
    });

    return jsonResult({
      ok: true,
      newInviteCode: newCode,
      newInviteLink: `https://chat.whatsapp.com/${newCode}`,
      groupJid,
    });
  }

  // ===== GET GROUP METADATA =====
  if (action === "getGroupInfo" || action === "groupMetadata") {
    if (!isActionEnabled("groupMetadata")) {
      throw new Error("WhatsApp group metadata fetching is disabled.");
    }
    const groupJid = readStringParam(params, "groupJid", { required: true });

    const meta = await groupGetMetadataWhatsApp(groupJid, {
      verbose: false,
      accountId: accountId ?? undefined,
    });

    return jsonResult({
      ok: true,
      ...meta,
    });
  }

  if (action === "fetchHistory") {
    const chatJid = readStringParam(params, "chatJid") || readStringParam(params, "target");
    if (!chatJid) {
      throw new Error("chatJid or target is required for fetchHistory action");
    }
    const count = typeof params.count === "number" ? params.count : 50;
    const oldestMsgId = readStringParam(params, "oldestMsgId");
    const oldestMsgFromMe = params.oldestMsgFromMe === true;
    const oldestMsgTimestamp =
      typeof params.oldestMsgTimestamp === "number" ? params.oldestMsgTimestamp : undefined;

    const { requireActiveWebListener } = await import("../../web/active-listener.js");
    const { listener } = requireActiveWebListener(accountId);
    if (!listener.fetchMessageHistory) {
      throw new Error("fetchMessageHistory not available on current listener");
    }
    const result = await listener.fetchMessageHistory(
      chatJid,
      count,
      oldestMsgId,
      oldestMsgFromMe,
      oldestMsgTimestamp,
    );
    return jsonResult(result);
  }

  throw new Error(`Unsupported WhatsApp action: ${action}`);
}
