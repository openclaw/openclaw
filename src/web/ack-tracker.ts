/**
 * In-memory tracker for outbound WhatsApp message ACK status.
 *
 * Baileys emits `messages.update` events with a numeric status field:
 *   0 = ERROR, 1 = PENDING, 2 = SERVER_ACK (sent),
 *   3 = DELIVERY_ACK (delivered), 4 = READ, 5 = PLAYED
 *
 * We keep the latest status per message ID and evict old entries
 * to avoid unbounded growth.
 */

export type MessageAckLevel = "error" | "pending" | "sent" | "delivered" | "read" | "played";

export type MessageAckEntry = {
  messageId: string;
  remoteJid: string;
  ackLevel: MessageAckLevel;
  /** Raw numeric status from Baileys. */
  rawStatus: number;
  updatedAt: number;
};

const MAX_ENTRIES = 2000;
const EVICT_AGE_MS = 30 * 60 * 1000; // 30 minutes

function statusToAckLevel(status: number): MessageAckLevel {
  switch (status) {
    case 0:
      return "error";
    case 1:
      return "pending";
    case 2:
      return "sent";
    case 3:
      return "delivered";
    case 4:
      return "read";
    case 5:
      return "played";
    default:
      return "pending";
  }
}

export function createAckTracker() {
  const entries = new Map<string, MessageAckEntry>();

  function evict() {
    if (entries.size <= MAX_ENTRIES) {
      return;
    }
    const cutoff = Date.now() - EVICT_AGE_MS;
    for (const [key, entry] of entries) {
      if (entry.updatedAt < cutoff) {
        entries.delete(key);
      }
    }
    // If still over limit, remove oldest entries
    if (entries.size > MAX_ENTRIES) {
      const sorted = [...entries.entries()].toSorted((a, b) => a[1].updatedAt - b[1].updatedAt);
      const toRemove = sorted.slice(0, entries.size - MAX_ENTRIES);
      for (const [key] of toRemove) {
        entries.delete(key);
      }
    }
  }

  return {
    /** Record an outbound message so we can track its status. */
    trackOutbound(messageId: string, remoteJid: string) {
      entries.set(messageId, {
        messageId,
        remoteJid,
        ackLevel: "pending",
        rawStatus: 1,
        updatedAt: Date.now(),
      });
      evict();
    },

    /** Update status from a Baileys messages.update event. */
    updateStatus(messageId: string, remoteJid: string, rawStatus: number) {
      const existing = entries.get(messageId);
      const entry: MessageAckEntry = {
        messageId,
        remoteJid: existing?.remoteJid ?? remoteJid,
        ackLevel: statusToAckLevel(rawStatus),
        rawStatus,
        updatedAt: Date.now(),
      };
      entries.set(messageId, entry);
      evict();
    },

    /** Get the current ACK status for a message. */
    getStatus(messageId: string): MessageAckEntry | null {
      return entries.get(messageId) ?? null;
    },
  };
}

export type AckTracker = ReturnType<typeof createAckTracker>;
