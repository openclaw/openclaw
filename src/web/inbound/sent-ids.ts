/**
 * Tracks message IDs sent by the bot to prevent echo re-ingestion.
 * Used by send-api.ts (write) and monitor.ts (read).
 */

const MAX_TRACKED = 500;
const sentIds = new Set<string>();

export function trackSentMessageId(id: string): void {
  sentIds.add(id);
  // Trim oldest entries
  if (sentIds.size > MAX_TRACKED) {
    const first = sentIds.values().next().value;
    if (first) sentIds.delete(first);
  }
}

export function wasSentByBot(id: string): boolean {
  return sentIds.has(id);
}

export function forgetSentMessageId(id: string): void {
  sentIds.delete(id);
}
