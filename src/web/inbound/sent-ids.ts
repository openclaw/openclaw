/**
 * Track message IDs sent by the bot to prevent re-ingestion.
 * WhatsApp sometimes delivers our own sent messages back to us
 * (especially voice notes and media), causing echo loops.
 */

const SENT_IDS = new Set<string>();
const MAX_SENT_IDS = 500;
const CLEANUP_THRESHOLD = 600;

export function trackSentMessageId(id: string): void {
  SENT_IDS.add(id);
  // Prevent unbounded growth — trim oldest when threshold exceeded.
  // Sets iterate in insertion order, so deleting first entries is FIFO.
  if (SENT_IDS.size > CLEANUP_THRESHOLD) {
    const iter = SENT_IDS.values();
    const excess = SENT_IDS.size - MAX_SENT_IDS;
    for (let i = 0; i < excess; i++) {
      SENT_IDS.delete(iter.next().value!);
    }
  }
}

export function isSentByUs(id: string): boolean {
  return SENT_IDS.has(id);
}
