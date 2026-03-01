/**
 * In-memory cache for group membership verification.
 * Used by groupPolicy "members" to ensure all group participants are trusted.
 */

import { createHash } from "node:crypto";
import type { Api } from "grammy";
import { logVerbose, warn } from "../globals.js";
import type { NormalizedAllowFrom } from "./bot-access.js";

const TTL_MS = 5 * 60 * 1000; // 5 minutes

type MembershipResult = {
  trusted: boolean;
  reason?: string;
};

type CacheEntry = {
  result: MembershipResult;
  timestamp: number;
};

const cache = new Map<string, CacheEntry>();

function startEvictionTimer(): ReturnType<typeof setInterval> {
  // Periodic eviction sweep: remove stale entries so the cache stays bounded
  // on long-lived gateways. unref() ensures this timer doesn't keep the process alive.
  return setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of cache.entries()) {
      if (now - entry.timestamp >= TTL_MS) {
        cache.delete(key);
      }
    }
  }, TTL_MS).unref();
}

let evictionTimer = startEvictionTimer();

/**
 * Build a cache key that includes the chat ID, bot ID, and a hash of the
 * allowFrom entries. This avoids collisions when two Telegram bots share a
 * gateway and monitor the same group with identical allowlists — without botId
 * in the key, a trusted result cached for bot A could be replayed for bot B
 * up to TTL.
 */
function getChatKey(
  chatId: number | string,
  botId: number,
  allowFrom: NormalizedAllowFrom,
): string {
  const sorted = allowFrom.entries.toSorted();
  // Include botId in the payload so two bots in the same chat with identical
  // allowlists produce separate cache entries. Without this, a trusted result
  // cached for bot A can be replayed for bot B up to TTL.
  const payload = `${botId}:${allowFrom.hasWildcard ? "1" : "0"}:${sorted.join(",")}`;
  const hash = createHash("sha256").update(payload).digest("hex").slice(0, 12);
  return `${chatId}:${hash}`;
}

/**
 * Extract numeric user IDs from a NormalizedAllowFrom.
 * Entries that look like integers are treated as user IDs;
 * usernames (starting with @) and other strings are skipped.
 */
function extractNumericIds(allow: NormalizedAllowFrom): number[] {
  return allow.entries.filter((e) => /^\d+$/.test(e)).map(Number);
}

export async function verifyGroupMembership(params: {
  chatId: number | string;
  api: Api;
  botId: number;
  allowFrom: NormalizedAllowFrom;
}): Promise<MembershipResult> {
  const { chatId, api, botId, allowFrom } = params;
  const key = getChatKey(chatId, botId, allowFrom);

  // Check cache
  const cached = cache.get(key);
  if (cached && Date.now() - cached.timestamp < TTL_MS) {
    return cached.result;
  }

  // Wildcard: everyone is trusted
  if (allowFrom.hasWildcard) {
    const result: MembershipResult = { trusted: true };
    cache.set(key, { result, timestamp: Date.now() });
    return result;
  }

  const numericIds = extractNumericIds(allowFrom);
  if (numericIds.length === 0) {
    logVerbose(
      warn(
        `[members] No numeric IDs in allowFrom for chat ${chatId}; cannot verify membership. Use numeric Telegram user IDs.`,
      ),
    );
    const result: MembershipResult = { trusted: false, reason: "no-numeric-ids" };
    cache.set(key, { result, timestamp: Date.now() });
    return result;
  }

  // Build the full set of trusted IDs: allowFrom entries + this bot
  const trustedIds = new Set(numericIds);
  trustedIds.add(botId);

  try {
    const totalCount = await api.getChatMemberCount(Number(chatId));

    // Quick reject: if total members > trusted IDs, there must be untrusted members
    if (totalCount > trustedIds.size) {
      const result: MembershipResult = {
        trusted: false,
        reason: `member-count-mismatch: ${totalCount} members but only ${trustedIds.size} trusted IDs`,
      };
      cache.set(key, { result, timestamp: Date.now() });
      return result;
    }

    // Verify each trusted ID is actually a member
    let presentCount = 0;
    for (const userId of trustedIds) {
      try {
        const member = await api.getChatMember(Number(chatId), userId);
        const status = member.status;
        if (status !== "left" && status !== "kicked") {
          presentCount++;
        }
      } catch {
        // User not in group or API error for this specific user — skip
      }
    }

    // Trusted if all members are accounted for by the trusted set
    const trusted = presentCount === totalCount;
    const result: MembershipResult = trusted
      ? { trusted: true }
      : {
          trusted: false,
          reason: `untrusted-members: ${totalCount} total, ${presentCount} trusted`,
        };
    cache.set(key, { result, timestamp: Date.now() });
    return result;
  } catch {
    const result: MembershipResult = { trusted: false, reason: "api-error" };
    cache.set(key, { result, timestamp: Date.now() });
    return result;
  }
}

/**
 * Invalidate cached membership for a specific chat (e.g. on member join/leave).
 * Removes all entries for this chatId regardless of allowFrom hash.
 */
export function invalidateGroupMembership(chatId: number | string): void {
  const prefix = `${chatId}:`;
  for (const key of cache.keys()) {
    if (key.startsWith(prefix)) {
      cache.delete(key);
    }
  }
}

/**
 * Clear all cached entries and restart the eviction timer.
 *
 * Intended for tests (call in afterEach). Stops the current sweep interval,
 * clears all entries, then immediately starts a fresh interval so subsequent
 * tests that use fake timers get a predictable timer state.
 *
 * @internal
 */
export function clearGroupMembershipCache(): void {
  clearInterval(evictionTimer);
  cache.clear();
  // Restart the sweep so the module is in a clean, ready state for the next use.
  evictionTimer = startEvictionTimer();
}

/**
 * Return the current number of entries in the cache.
 * Exposed for testing only — do not rely on this in production code.
 *
 * @internal
 */
export function getMembershipCacheSize(): number {
  return cache.size;
}
