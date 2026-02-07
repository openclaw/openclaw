import type { AnyMessageContent, WAPresence, ParticipantAction, GroupSettingUpdate } from "@whiskeysockets/baileys";
import type { ActiveWebSendOptions } from "../active-listener.js";
import { recordChannelActivity } from "../../infra/channel-activity.js";
import { toWhatsappJid } from "../../utils.js";

export type GroupAdminMethods = {
  groupUpdateSubject: (jid: string, subject: string) => Promise<void>;
  groupUpdateDescription: (jid: string, description?: string) => Promise<void>;
  updateProfilePicture: (jid: string, content: Buffer) => Promise<void>;
  groupParticipantsUpdate: (jid: string, participants: string[], action: ParticipantAction) => Promise<unknown>;
  groupSettingUpdate: (jid: string, setting: GroupSettingUpdate) => Promise<void>;
};

export function createWebSendApi(params: {
  sock: {
    sendMessage: (jid: string, content: AnyMessageContent) => Promise<unknown>;
    sendPresenceUpdate: (presence: WAPresence, jid?: string) => Promise<unknown>;
  } & Partial<GroupAdminMethods>;
  defaultAccountId: string;
}) {
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
      const result = await params.sock.sendMessage(jid, payload);
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
      const result = await params.sock.sendMessage(jid, {
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
      await params.sock.sendMessage(jid, {
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
      await params.sock.sendPresenceUpdate("composing", jid);
    },

    // Group admin methods
    updateGroupSubject: async (groupJid: string, subject: string): Promise<void> => {
      if (!params.sock.groupUpdateSubject) {
        throw new Error("Group admin methods not available");
      }
      const jid = toWhatsappJid(groupJid);
      await params.sock.groupUpdateSubject(jid, subject);
    },

    updateGroupDescription: async (groupJid: string, description?: string): Promise<void> => {
      if (!params.sock.groupUpdateDescription) {
        throw new Error("Group admin methods not available");
      }
      const jid = toWhatsappJid(groupJid);
      await params.sock.groupUpdateDescription(jid, description);
    },

    updateGroupPhoto: async (groupJid: string, image: Buffer): Promise<void> => {
      if (!params.sock.updateProfilePicture) {
        throw new Error("Group admin methods not available");
      }
      const jid = toWhatsappJid(groupJid);
      await params.sock.updateProfilePicture(jid, image);
    },

    updateGroupParticipants: async (
      groupJid: string,
      participants: string[],
      action: ParticipantAction,
    ): Promise<{ status: string; jid: string }[]> => {
      if (!params.sock.groupParticipantsUpdate) {
        throw new Error("Group admin methods not available");
      }
      const jid = toWhatsappJid(groupJid);
      // Pass participants through as-is; normalization is handled by the outbound.ts caller
      const result = await params.sock.groupParticipantsUpdate(jid, participants, action);
      return result as { status: string; jid: string }[];
    },

    updateGroupSettings: async (groupJid: string, setting: GroupSettingUpdate): Promise<void> => {
      if (!params.sock.groupSettingUpdate) {
        throw new Error("Group admin methods not available");
      }
      const jid = toWhatsappJid(groupJid);
      await params.sock.groupSettingUpdate(jid, setting);
    },
  } as const;
}
