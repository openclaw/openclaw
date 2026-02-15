import type { AnyMessageContent, WAPresence } from "@whiskeysockets/baileys";
import type { ActiveWebSendOptions } from "../active-listener.js";
import { recordChannelActivity } from "../../infra/channel-activity.js";
import { toWhatsappJid } from "../../utils.js";

/** Optional Baileys LID mapping store for resolving phone → LID */
export type LidResolver = {
  getLIDForPN?: (pn: string) => Promise<string | null>;
};

/**
 * Process @mentions in outbound text for WhatsApp.
 *
 * Parses @+14155551234 or @14155551234 patterns, resolves each phone number
 * to a LID JID via Baileys signalRepository.lidMapping, and builds the
 * mentions array that Baileys needs for clickable WhatsApp mentions.
 *
 * Without this, outbound mentions render as raw phone numbers or LIDs
 * instead of highlighted, tappable contact names.
 */
export async function processOutboundMentions(
  text: string,
  lidResolver?: LidResolver,
): Promise<{ text: string; mentions: string[] }> {
  const mentions: string[] = [];
  let result = text;

  const resolveLid = async (digits: string): Promise<string | undefined> => {
    if (lidResolver?.getLIDForPN) {
      try {
        const pnJid = `${digits}@s.whatsapp.net`;
        const lid = await lidResolver.getLIDForPN(pnJid);
        if (lid) {
          return lid.includes("@") ? lid : `${lid}@lid`;
        }
      } catch {
        // LID resolution unavailable — fall through
      }
    }
    return undefined;
  };

  const addMention = async (digits: string) => {
    const lidJid = await resolveLid(digits);
    const jid = lidJid ?? `${digits}@s.whatsapp.net`;
    if (!mentions.includes(jid)) {
      mentions.push(jid);
    }
  };

  // Match @+14155551234 or @14155551234 patterns
  const phonePattern = /@(\+?\d{10,15})\b/g;
  const phoneMatches: Array<{ full: string; digits: string }> = [];
  let match: RegExpExecArray | null;
  while ((match = phonePattern.exec(text)) !== null) {
    const raw = match[1];
    const digits = raw.replace(/^\+/, "");
    phoneMatches.push({ full: match[0], digits });
    await addMention(digits);
  }
  for (const m of phoneMatches) {
    // WhatsApp requires @LID_NUMBER in text for clickable mention rendering
    const lidJid = await resolveLid(m.digits);
    if (lidJid) {
      const lidNum = lidJid.replace(/@.*/, "");
      result = result.replace(m.full, `@${lidNum}`);
    }
  }

  return { text: result, mentions };
}

export function createWebSendApi(params: {
  sock: {
    sendMessage: (jid: string, content: AnyMessageContent) => Promise<unknown>;
    sendPresenceUpdate: (presence: WAPresence, jid?: string) => Promise<unknown>;
  };
  defaultAccountId: string;
  lidResolver?: LidResolver;
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
        const processed = await processOutboundMentions(text, params.lidResolver);
        payload =
          processed.mentions.length > 0
            ? { text: processed.text, mentions: processed.mentions }
            : { text };
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
  } as const;
}
