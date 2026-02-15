import type {
  AnyMessageContent,
  GroupMetadata,
  WAPresence,
  WASocket,
} from "@whiskeysockets/baileys";
import type { ActiveWebSendOptions, MessageKey } from "../active-listener.js";
import { recordChannelActivity } from "../../infra/channel-activity.js";
import { toWhatsappJid } from "../../utils.js";
import { trackSentMessageId } from "./sent-ids.js";

type BaileysSock = {
  sendMessage: (jid: string, content: AnyMessageContent, options?: unknown) => Promise<unknown>;
  sendPresenceUpdate: (presence: WAPresence, jid?: string) => Promise<unknown>;
  presenceSubscribe: (jid: string, tcToken?: Buffer) => Promise<void>;
  groupCreate: (subject: string, participants: string[]) => Promise<GroupMetadata>;
  groupUpdateSubject: (jid: string, subject: string) => Promise<void>;
  groupUpdateDescription: (jid: string, description: string) => Promise<void>;
  updateProfilePicture: (jid: string, img: Buffer) => Promise<void>;
  groupParticipantsUpdate: (
    jid: string,
    participants: string[],
    action: "add" | "remove" | "promote" | "demote",
  ) => Promise<{ status: string; jid: string | undefined; content?: unknown }[]>;
  groupLeave: (jid: string) => Promise<void>;
  groupInviteCode: (jid: string) => Promise<string | undefined>;
  groupRevokeInvite: (jid: string) => Promise<string | undefined>;
  groupMetadata: (jid: string) => Promise<GroupMetadata>;
  fetchMessageHistory?: (
    count: number,
    oldestMsgKey: unknown,
    oldestMsgTimestamp: number,
  ) => Promise<string>;
  requestPlaceholderResend?: (messageKey: unknown) => Promise<string | undefined>;
};

export function createWebSendApi(params: { sock: BaileysSock; defaultAccountId: string }) {
  // Wrap sendMessage to track sent IDs for echo prevention
  const originalSendMessage = params.sock.sendMessage.bind(params.sock);
  const trackedSendMessage: BaileysSock["sendMessage"] = async (jid, content, options) => {
    const result = await originalSendMessage(jid, content, options);
    const msgId = (result as { key?: { id?: string } } | undefined)?.key?.id;
    if (msgId) {trackSentMessageId(msgId);}
    return result;
  };
  const sock = { ...params.sock, sendMessage: trackedSendMessage };

  return {
    sendMessage: async (
      to: string,
      text: string,
      mediaBuffer?: Buffer,
      mediaType?: string,
      sendOptions?: ActiveWebSendOptions,
    ): Promise<{ messageId: string }> => {
      const jid = toWhatsappJid(to);
      let payload: AnyMessageContent;
      if (mediaBuffer && mediaType) {
        if (mediaType.startsWith("image/")) {
          payload = {
            image: mediaBuffer,
            caption: text || undefined,
            mimetype: mediaType,
          };
        } else if (mediaType.startsWith("audio/")) {
          payload = { audio: mediaBuffer, ptt: true, mimetype: mediaType };
        } else if (mediaType.startsWith("video/")) {
          const gifPlayback = sendOptions?.gifPlayback;
          payload = {
            video: mediaBuffer,
            caption: text || undefined,
            mimetype: mediaType,
            ...(gifPlayback ? { gifPlayback: true } : {}),
          };
        } else {
          const fileName = sendOptions?.fileName?.trim() || "file";
          payload = {
            document: mediaBuffer,
            fileName,
            caption: text || undefined,
            mimetype: mediaType,
          };
        }
      } else {
        payload = { text };
      }
      const result = await sock.sendMessage(jid, payload);
      const accountId = sendOptions?.accountId ?? params.defaultAccountId;
      recordChannelActivity({
        channel: "whatsapp",
        accountId,
        direction: "outbound",
      });
      const messageId =
        typeof result === "object" && result && "key" in result
          ? String((result as { key?: { id?: string } }).key?.id ?? "unknown")
          : "unknown";
      return { messageId };
    },
    sendPoll: async (
      to: string,
      poll: { question: string; options: string[]; maxSelections?: number },
    ): Promise<{ messageId: string }> => {
      const jid = toWhatsappJid(to);
      const result = await sock.sendMessage(jid, {
        poll: {
          name: poll.question,
          values: poll.options,
          selectableCount: poll.maxSelections ?? 1,
        },
      } as AnyMessageContent);
      recordChannelActivity({
        channel: "whatsapp",
        accountId: params.defaultAccountId,
        direction: "outbound",
      });
      const messageId =
        typeof result === "object" && result && "key" in result
          ? String((result as { key?: { id?: string } }).key?.id ?? "unknown")
          : "unknown";
      return { messageId };
    },
    sendReaction: async (
      chatJid: string,
      messageId: string,
      emoji: string,
      fromMe: boolean,
      participant?: string,
    ): Promise<void> => {
      const jid = toWhatsappJid(chatJid);
      await sock.sendMessage(jid, {
        react: {
          text: emoji,
          key: {
            remoteJid: jid,
            id: messageId,
            fromMe,
            participant: participant ? toWhatsappJid(participant) : undefined,
          },
        },
      } as AnyMessageContent);
    },
    sendComposingTo: async (to: string): Promise<void> => {
      const jid = toWhatsappJid(to);
      // WhatsApp requires presence subscription before composing works in groups
      if (jid.endsWith("@g.us")) {
        try {
          await params.sock.presenceSubscribe(jid);
        } catch {
          // Best-effort; some groups may reject subscription
        }
      }
      await params.sock.sendPresenceUpdate("composing", jid);
    },
    createGroup: async (
      subject: string,
      participants: string[],
    ): Promise<{ groupId: string; subject: string }> => {
      const participantJids = participants.map((p) => toWhatsappJid(p));
      const result = await params.sock.groupCreate(subject, participantJids);
      recordChannelActivity({
        channel: "whatsapp",
        accountId: params.defaultAccountId,
        direction: "outbound",
      });
      return {
        groupId: result.id,
        subject: result.subject,
      };
    },

    // Edit an existing message
    editMessage: async (
      chatJid: string,
      messageId: string,
      newText: string,
      fromMe = true,
      participant?: string,
    ): Promise<void> => {
      const jid = toWhatsappJid(chatJid);
      await sock.sendMessage(jid, {
        text: newText,
        edit: {
          remoteJid: jid,
          id: messageId,
          fromMe,
          participant: participant ? toWhatsappJid(participant) : undefined,
        },
      } as AnyMessageContent);
    },

    // Delete/unsend a message
    deleteMessage: async (
      chatJid: string,
      messageId: string,
      fromMe = true,
      participant?: string,
    ): Promise<void> => {
      const jid = toWhatsappJid(chatJid);
      await sock.sendMessage(jid, {
        delete: {
          remoteJid: jid,
          id: messageId,
          fromMe,
          participant: participant ? toWhatsappJid(participant) : undefined,
        },
      } as AnyMessageContent);
    },

    // Reply to a message (quote)
    replyMessage: async (
      to: string,
      text: string,
      quotedKey: MessageKey,
      mediaBuffer?: Buffer,
      mediaType?: string,
    ): Promise<{ messageId: string }> => {
      const jid = toWhatsappJid(to);
      let payload: AnyMessageContent;
      if (mediaBuffer && mediaType) {
        if (mediaType.startsWith("image/")) {
          payload = { image: mediaBuffer, caption: text || undefined, mimetype: mediaType };
        } else if (mediaType.startsWith("audio/")) {
          payload = { audio: mediaBuffer, ptt: true, mimetype: mediaType };
        } else if (mediaType.startsWith("video/")) {
          payload = { video: mediaBuffer, caption: text || undefined, mimetype: mediaType };
        } else {
          payload = {
            document: mediaBuffer,
            fileName: "file",
            caption: text || undefined,
            mimetype: mediaType,
          };
        }
      } else {
        payload = { text };
      }
      const quoted = {
        key: {
          remoteJid: toWhatsappJid(quotedKey.remoteJid),
          id: quotedKey.id,
          fromMe: quotedKey.fromMe,
          participant: quotedKey.participant ? toWhatsappJid(quotedKey.participant) : undefined,
        },
        // Baileys requires a message property for quote context generation.
        // Since we don't have the original message content, provide a minimal placeholder.
        message: { conversation: "" },
      };
      const result = await sock.sendMessage(jid, payload, { quoted });
      recordChannelActivity({
        channel: "whatsapp",
        accountId: params.defaultAccountId,
        direction: "outbound",
      });
      const messageIdResult =
        typeof result === "object" && result && "key" in result
          ? String((result as { key?: { id?: string } }).key?.id ?? "unknown")
          : "unknown";
      return { messageId: messageIdResult };
    },

    // Send a sticker
    sendSticker: async (to: string, stickerBuffer: Buffer): Promise<{ messageId: string }> => {
      const jid = toWhatsappJid(to);
      const result = await sock.sendMessage(jid, {
        sticker: stickerBuffer,
      } as AnyMessageContent);
      recordChannelActivity({
        channel: "whatsapp",
        accountId: params.defaultAccountId,
        direction: "outbound",
      });
      const messageId =
        typeof result === "object" && result && "key" in result
          ? String((result as { key?: { id?: string } }).key?.id ?? "unknown")
          : "unknown";
      return { messageId };
    },

    // Group management
    groupUpdateSubject: async (groupJid: string, newSubject: string): Promise<void> => {
      const jid = toWhatsappJid(groupJid);
      await params.sock.groupUpdateSubject(jid, newSubject);
    },

    groupUpdateDescription: async (groupJid: string, description: string): Promise<void> => {
      const jid = toWhatsappJid(groupJid);
      await params.sock.groupUpdateDescription(jid, description);
    },

    groupUpdateIcon: async (groupJid: string, imageBuffer: Buffer): Promise<void> => {
      const jid = toWhatsappJid(groupJid);
      await params.sock.updateProfilePicture(jid, imageBuffer);
    },

    groupAddParticipants: async (
      groupJid: string,
      participants: string[],
    ): Promise<{ [jid: string]: string }> => {
      const jid = toWhatsappJid(groupJid);
      const participantJids = participants.map((p) => toWhatsappJid(p));
      const result = await params.sock.groupParticipantsUpdate(jid, participantJids, "add");
      const statusMap: { [jid: string]: string } = {};
      for (const r of result) {
        if (r.jid) {
          statusMap[r.jid] = r.status;
        }
      }
      return statusMap;
    },

    groupRemoveParticipants: async (
      groupJid: string,
      participants: string[],
    ): Promise<{ [jid: string]: string }> => {
      const jid = toWhatsappJid(groupJid);
      const participantJids = participants.map((p) => toWhatsappJid(p));
      const result = await params.sock.groupParticipantsUpdate(jid, participantJids, "remove");
      const statusMap: { [jid: string]: string } = {};
      for (const r of result) {
        if (r.jid) {
          statusMap[r.jid] = r.status;
        }
      }
      return statusMap;
    },

    groupPromoteParticipants: async (
      groupJid: string,
      participants: string[],
    ): Promise<{ [jid: string]: string }> => {
      const jid = toWhatsappJid(groupJid);
      const participantJids = participants.map((p) => toWhatsappJid(p));
      const result = await params.sock.groupParticipantsUpdate(jid, participantJids, "promote");
      const statusMap: { [jid: string]: string } = {};
      for (const r of result) {
        if (r.jid) {
          statusMap[r.jid] = r.status;
        }
      }
      return statusMap;
    },

    groupDemoteParticipants: async (
      groupJid: string,
      participants: string[],
    ): Promise<{ [jid: string]: string }> => {
      const jid = toWhatsappJid(groupJid);
      const participantJids = participants.map((p) => toWhatsappJid(p));
      const result = await params.sock.groupParticipantsUpdate(jid, participantJids, "demote");
      const statusMap: { [jid: string]: string } = {};
      for (const r of result) {
        if (r.jid) {
          statusMap[r.jid] = r.status;
        }
      }
      return statusMap;
    },

    groupLeave: async (groupJid: string): Promise<void> => {
      const jid = toWhatsappJid(groupJid);
      await params.sock.groupLeave(jid);
    },

    groupGetInviteCode: async (groupJid: string): Promise<string> => {
      const jid = toWhatsappJid(groupJid);
      const code = await params.sock.groupInviteCode(jid);
      return code ?? "";
    },

    groupRevokeInviteCode: async (groupJid: string): Promise<string> => {
      const jid = toWhatsappJid(groupJid);
      const code = await params.sock.groupRevokeInvite(jid);
      return code ?? "";
    },

    groupMetadata: async (
      groupJid: string,
    ): Promise<{
      id: string;
      subject: string;
      description?: string;
      participants: Array<{ id: string; admin?: string }>;
    }> => {
      const jid = toWhatsappJid(groupJid);
      const meta = await params.sock.groupMetadata(jid);
      return {
        id: meta.id,
        subject: meta.subject,
        description: meta.desc,
        participants: meta.participants.map((p) => ({
          id: p.id,
          admin: p.admin ?? undefined,
        })),
      };
    },

    fetchMessageHistory: async (
      chatJid: string,
      count: number,
      oldestMsgId?: string,
      oldestMsgFromMe?: boolean,
      oldestMsgTimestamp?: number,
    ): Promise<{ ok: boolean; requestId?: string; error?: string }> => {
      if (!params.sock.fetchMessageHistory) {
        return { ok: false, error: "fetchMessageHistory not available on socket" };
      }
      const jid = toWhatsappJid(chatJid);
      const msgKey = {
        remoteJid: jid,
        fromMe: oldestMsgFromMe ?? false,
        id: oldestMsgId ?? "",
      };
      const ts = oldestMsgTimestamp ?? Math.floor(Date.now() / 1000);
      try {
        const requestId = await params.sock.fetchMessageHistory(count, msgKey, ts);
        return { ok: true, requestId };
      } catch (err) {
        return { ok: false, error: String(err) };
      }
    },

    requestPlaceholderResend: async (
      chatJid: string,
      msgId: string,
      fromMe?: boolean,
    ): Promise<{ ok: boolean; requestId?: string; error?: string }> => {
      if (!params.sock.requestPlaceholderResend) {
        return { ok: false, error: "requestPlaceholderResend not available on socket" };
      }
      const jid = toWhatsappJid(chatJid);
      const msgKey = { remoteJid: jid, fromMe: fromMe ?? false, id: msgId };
      try {
        const requestId = await params.sock.requestPlaceholderResend(msgKey);
        return { ok: true, requestId: requestId ?? undefined };
      } catch (err) {
        return { ok: false, error: String(err) };
      }
    },
  } as const;
}
