/**
 * In-memory cache of Slack threads the bot has participated in.
 * Used to auto-respond in threads without requiring @mention after the first reply.
 * Mirrors the pattern used by MS Teams and Telegram sent-message caches.
 */

const TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const MAX_ENTRIES = 5000;

const threadParticipation = new Map<string, number>();

function makeKey(channelId: string, threadTs: string): string {
  return `${channelId}:${threadTs}`;
}

function evictExpired(): void {
  const now = Date.now();
  for (const [key, timestamp] of threadParticipation) {
    if (now - timestamp > TTL_MS) {
      threadParticipation.delete(key);
    }
  }
}

export function recordSlackThreadParticipation(channelId: string, threadTs: string): void {
  if (!channelId || !threadTs) {
    return;
  }
  if (threadParticipation.size >= MAX_ENTRIES) {
    evictExpired();
  }
  threadParticipation.set(makeKey(channelId, threadTs), Date.now());
}

export function hasSlackThreadParticipation(channelId: string, threadTs: string): boolean {
  if (!channelId || !threadTs) {
    return false;
  }
  const key = makeKey(channelId, threadTs);
  const timestamp = threadParticipation.get(key);
  if (timestamp == null) {
    return false;
  }
  if (Date.now() - timestamp > TTL_MS) {
    threadParticipation.delete(key);
    return false;
  }
  return true;
}

export function clearSlackThreadParticipationCache(): void {
  threadParticipation.clear();
}
