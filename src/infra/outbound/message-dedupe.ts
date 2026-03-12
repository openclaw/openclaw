import { createHash } from "crypto";

/**
 * Message deduplication for outbound delivery.
 * Tracks fingerprints to prevent duplicate messages within a time window.
 */

interface DedupeEntry {
  fingerprint: string;
  timestamp: number;
}

const DEDUP_WINDOW_MS = 5 * 60 * 1000; // 5 minutes
const CLEANUP_INTERVAL_MS = 60 * 1000; // 1 minute
const MAX_ENTRIES_PER_CHAT = 1000;

/**
 * In-memory store: Map<chatId, Set<fingerprint>>
 * chatId = channel + ":" + to (e.g., "telegram:123456")
 */
const deduplicationStore = new Map<string, Set<DedupeEntry>>();

let cleanupTimer: NodeJS.Timeout | null = null;
let initialized = false;

/**
 * Initialize the deduplication system (auto-starts cleanup timer)
 */
function ensureInitialized(): void {
  if (initialized) return;
  initialized = true;
  startDedupeCleanup();
}

/**
 * Generate a SHA256 fingerprint for a message.
 */
function generateFingerprint(params: {
  channel: string;
  to: string;
  text: string;
  mediaUrl?: string;
}): string {
  const { channel, to, text, mediaUrl } = params;
  const data = `${channel}:${to}:${text}:${mediaUrl ?? ""}`;
  return createHash("sha256").update(data).digest("hex");
}

/**
 * Get or create the dedupe set for a chatId.
 */
function getOrCreateChatSet(chatId: string): Set<DedupeEntry> {
  let set = deduplicationStore.get(chatId);
  if (!set) {
    set = new Set();
    deduplicationStore.set(chatId, set);
  }
  return set;
}

/**
 * Check if a message is a duplicate.
 * Returns true if duplicate found within the window.
 */
export function isDuplicate(params: {
  channel: string;
  to: string;
  text: string;
  mediaUrl?: string;
}): boolean {
  ensureInitialized();
  const fingerprint = generateFingerprint(params);
  const chatId = `${params.channel}:${params.to}`;
  const chatSet = getOrCreateChatSet(chatId);
  const now = Date.now();

  // Check if fingerprint exists within window
  for (const entry of chatSet) {
    if (entry.fingerprint === fingerprint && now - entry.timestamp < DEDUP_WINDOW_MS) {
      return true;
    }
  }

  return false;
}

/**
 * Record a message fingerprint.
 * Should be called after successful delivery.
 */
export function recordMessage(params: {
  channel: string;
  to: string;
  text: string;
  mediaUrl?: string;
}): void {
  ensureInitialized();
  const fingerprint = generateFingerprint(params);
  const chatId = `${params.channel}:${params.to}`;
  const chatSet = getOrCreateChatSet(chatId);
  const now = Date.now();

  // Add new entry
  chatSet.add({ fingerprint, timestamp: now });

  // Limit size to prevent memory bloat
  if (chatSet.size > MAX_ENTRIES_PER_CHAT) {
    // Remove oldest entries
    const entries = Array.from(chatSet).sort((a, b) => a.timestamp - b.timestamp);
    const toRemove = entries.slice(0, entries.length - MAX_ENTRIES_PER_CHAT);
    for (const entry of toRemove) {
      chatSet.delete(entry);
    }
  }
}

/**
 * Clean up expired entries from all chat sets.
 * Called periodically to prevent memory leaks.
 */
function cleanupExpiredEntries(): void {
  const now = Date.now();
  for (const [chatId, chatSet] of deduplicationStore) {
    for (const entry of chatSet) {
      if (now - entry.timestamp >= DEDUP_WINDOW_MS) {
        chatSet.delete(entry);
      }
    }
    // Remove empty sets
    if (chatSet.size === 0) {
      deduplicationStore.delete(chatId);
    }
  }
}

/**
 * Start the periodic cleanup timer.
 * Call once at startup.
 */
export function startDedupeCleanup(): void {
  if (cleanupTimer) {
    return;
  }
  cleanupTimer = setInterval(cleanupExpiredEntries, CLEANUP_INTERVAL_MS);
  // Prevent timer from keeping process alive
  cleanupTimer.unref();
}

/**
 * Stop the cleanup timer.
 * Call on shutdown if needed.
 */
export function stopDedupeCleanup(): void {
  if (cleanupTimer) {
    clearInterval(cleanupTimer);
    cleanupTimer = null;
  }
}

/**
 * Get deduplication stats (for debugging/monitoring).
 */
export function getDedupeStats(): {
  chatCount: number;
  totalEntries: number;
} {
  let totalEntries = 0;
  for (const chatSet of deduplicationStore.values()) {
    totalEntries += chatSet.size;
  }
  return {
    chatCount: deduplicationStore.size,
    totalEntries,
  };
}
