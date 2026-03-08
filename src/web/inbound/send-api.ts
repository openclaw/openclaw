import type { AnyMessageContent, WAPresence } from "@whiskeysockets/baileys";
import { recordChannelActivity } from "../../infra/channel-activity.js";
import { toWhatsappJid } from "../../utils.js";
import type { ActiveWebSendOptions } from "../active-listener.js";

function recordWhatsAppOutbound(accountId: string) {
  recordChannelActivity({
    channel: "whatsapp",
    accountId,
    direction: "outbound",
  });
}

function resolveOutboundMessageId(result: unknown): string {
  return typeof result === "object" && result && "key" in result
    ? String((result as { key?: { id?: string } }).key?.id ?? "unknown")
    : "unknown";
}

export function createWebSendApi(params: {
  sock: {
    sendMessage: (jid: string, content: AnyMessageContent) => Promise<unknown>;
    sendPresenceUpdate: (presence: WAPresence, jid?: string) => Promise<unknown>;
  };
  defaultAccountId: string;
  /** Resolve a phone-based JID (e.g. 12069106512@s.whatsapp.net) to its LID. */
  getLIDForPN?: (pn: string) => Promise<string | null>;
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
      const result = await params.sock.sendMessage(jid, payload);
      const accountId = sendOptions?.accountId ?? params.defaultAccountId;
      recordWhatsAppOutbound(accountId);
      const messageId = resolveOutboundMessageId(result);
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
      recordWhatsAppOutbound(params.defaultAccountId);
      const messageId = resolveOutboundMessageId(result);
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
      // For group messages, the reaction key must include the original sender's
      // participant JID. WhatsApp migrated group keys to LID-based JIDs, but
      // callers typically supply a phone number. Resolve it to the LID via
      // Baileys' signal key store so the reaction key matches the message key.
      let resolvedParticipant = participant;
      if (jid.endsWith("@g.us") && participant && params.getLIDForPN) {
        const participantJid = toWhatsappJid(participant);
        if (participantJid.endsWith("@s.whatsapp.net")) {
          try {
            const lid = await params.getLIDForPN(participantJid);
            if (lid) {
              resolvedParticipant = lid;
            }
          } catch {
            // Fall through to phone-based JID.
          }
        }
      }
      await params.sock.sendMessage(jid, {
        react: {
          text: emoji,
          key: {
            remoteJid: jid,
            id: messageId,
            fromMe,
            participant: resolvedParticipant ? toWhatsappJid(resolvedParticipant) : undefined,
          },
        },
      } as AnyMessageContent);
    },
    sendComposingTo: async (to: string): Promise<void> => {
      const jid = toWhatsappJid(to);
      await params.sock.sendPresenceUpdate("composing", jid);
    },
  } as const;
}
