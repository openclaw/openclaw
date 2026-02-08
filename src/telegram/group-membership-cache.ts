/**
 * In-memory cache for group membership verification.
 * Used by groupPolicy "members" to ensure all group participants are trusted.
 */

import type { Api } from "grammy";
import type { NormalizedAllowFrom } from "./bot-access.js";
import { logVerbose, warn } from "../globals.js";

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

function getChatKey(chatId: number | string): string {
  return String(chatId);
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
  const { chatId, api, botId: _botId, allowFrom } = params;
  const key = getChatKey(chatId);

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

  try {
    const totalCount = await api.getChatMemberCount(Number(chatId));

    // Quick reject: if total members > allowed IDs + 1 (bot), there must be untrusted members
    if (totalCount > numericIds.length + 1) {
      const result: MembershipResult = {
        trusted: false,
        reason: `member-count-mismatch: ${totalCount} members but only ${numericIds.length} trusted IDs + bot`,
      };
      cache.set(key, { result, timestamp: Date.now() });
      return result;
    }

    // Verify each trusted ID is actually a member
    let presentCount = 0;
    for (const userId of numericIds) {
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

    // Trusted if: present allowed members + 1 bot == total count
    const trusted = presentCount + 1 === totalCount;
    const result: MembershipResult = trusted
      ? { trusted: true }
      : {
          trusted: false,
          reason: `untrusted-members: ${totalCount} total, ${presentCount} trusted + 1 bot = ${presentCount + 1}`,
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
 */
export function invalidateGroupMembership(chatId: number | string): void {
  cache.delete(getChatKey(chatId));
}

/**
 * Clear all cached entries (for testing).
 */
export function clearGroupMembershipCache(): void {
  cache.clear();
}
