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

function isWhatsAppUserJid(jid: string): boolean {
  return /^\d+@s\.whatsapp\.net$/i.test(jid);
}

function buildWhatsAppLookupCandidates(jid: string): string[] {
  if (!isWhatsAppUserJid(jid)) {
    return [jid];
  }
  const matchWithNine = /^55(\d{2})(9\d{8})@s\.whatsapp\.net$/i.exec(jid);
  if (matchWithNine) {
    const ddd = Number(matchWithNine[1]);
    if (ddd < 11 || ddd > 28) {
      return [jid, `55${matchWithNine[1]}${matchWithNine[2].slice(1)}@s.whatsapp.net`];
    }
  }
  const matchWithoutNine = /^55(\d{2})(\d{8})@s\.whatsapp\.net$/i.exec(jid);
  if (matchWithoutNine) {
    const ddd = Number(matchWithoutNine[1]);
    if (ddd < 11 || ddd > 28) {
      return [jid, `55${matchWithoutNine[1]}9${matchWithoutNine[2]}@s.whatsapp.net`];
    }
  }
  return [jid];
}

function pickExistingWhatsAppJid(result: unknown): string | null {
  if (!Array.isArray(result)) {
    return null;
  }
  for (const entry of result) {
    if (typeof entry !== "object" || entry === null) {
      continue;
    }
    const candidate = entry as { jid?: unknown; exists?: unknown };
    if (candidate.exists === false) {
      continue;
    }
    if (typeof candidate.jid === "string" && candidate.jid.trim()) {
      return candidate.jid.trim();
    }
  }
  return null;
}

async function resolveOutboundJid(params: {
  to: string;
  onWhatsApp?: (jid: string) => Promise<unknown>;
}): Promise<string> {
  const initial = toWhatsappJid(params.to);
  if (!params.onWhatsApp || !isWhatsAppUserJid(initial)) {
    return initial;
  }
  const candidates = buildWhatsAppLookupCandidates(initial);
  try {
    for (const candidate of candidates) {
      const lookup = await params.onWhatsApp(candidate);
      const resolved = pickExistingWhatsAppJid(lookup);
      if (resolved) {
        return resolved;
      }
    }
    return initial;
  } catch {
    return initial;
  }
}

export function createWebSendApi(params: {
  sock: {
    sendMessage: (jid: string, content: AnyMessageContent) => Promise<unknown>;
    sendPresenceUpdate: (presence: WAPresence, jid?: string) => Promise<unknown>;
    onWhatsApp?: (jid: string) => Promise<unknown>;
  };
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
      const jid = await resolveOutboundJid({ to, onWhatsApp: params.sock.onWhatsApp });
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
      const jid = await resolveOutboundJid({ to, onWhatsApp: params.sock.onWhatsApp });
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
