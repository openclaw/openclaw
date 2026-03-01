/**
 * In-memory cache of Slack threads the bot has participated in.
 * Used to auto-respond in threads without requiring @mention after the first reply.
 * Follows a similar TTL pattern to the MS Teams and Telegram sent-message caches.
 */

const TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const MAX_ENTRIES = 5000;

const threadParticipation = new Map<string, number>();

function makeKey(accountId: string, channelId: string, threadTs: string): string {
  return `${accountId}:${channelId}:${threadTs}`;
}

function evictExpired(): void {
  const now = Date.now();
  for (const [key, timestamp] of threadParticipation) {
    if (now - timestamp > TTL_MS) {
      threadParticipation.delete(key);
    }
  }
}

export function recordSlackThreadParticipation(
  accountId: string,
  channelId: string,
  threadTs: string,
): void {
  if (!accountId || !channelId || !threadTs) {
    return;
  }
  if (threadParticipation.size >= MAX_ENTRIES) {
    evictExpired();
  }
  threadParticipation.set(makeKey(accountId, channelId, threadTs), Date.now());
}

export function hasSlackThreadParticipation(
  accountId: string,
  channelId: string,
  threadTs: string,
): boolean {
  if (!accountId || !channelId || !threadTs) {
    return false;
  }
  const key = makeKey(accountId, channelId, threadTs);
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
