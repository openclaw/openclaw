/**
 * Heimdall Security Layer — SenderTier Resolution
 *
 * Resolves a sender's tier by checking (in order):
 *   0. isTrustedInternal flag       -> SYSTEM (trusted runtime calls)
 *   1. heimdall.senderTiers.owners  -> OWNER
 *   2. heimdall.senderTiers.members -> MEMBER
 *   3. allowFrom (channel interop)  -> MEMBER
 *   4. fallback                     -> GUEST
 */

import type { HeimdallConfig, SenderTier } from "./types.js";
import { SenderTier as SenderTierEnum } from "./types.js";

/**
 * Check whether `needle` matches any entry in `list` by:
 *   - Exact string/number identity (with string<->number coercion)
 *   - Case-insensitive username comparison
 */
function matchesList(
  senderId: string | number,
  senderUsername: string | undefined,
  list: ReadonlyArray<string | number>,
): boolean {
  const idStr = String(senderId);

  for (const entry of list) {
    const entryStr = String(entry);

    // Exact ID match (coerce both sides to string for comparison)
    if (entryStr === idStr) {
      return true;
    }

    // Case-insensitive username match (only if senderUsername is provided
    // and the entry looks like a username, not a pure number)
    if (senderUsername !== undefined && entryStr.toLowerCase() === senderUsername.toLowerCase()) {
      return true;
    }
  }

  return false;
}

export function resolveSenderTier(
  senderId: string | number,
  senderUsername: string | undefined,
  config: Pick<HeimdallConfig, "senderTiers">,
  allowFrom?: Array<string | number>,
  isTrustedInternal?: boolean,
): SenderTier {
  // 0. Check isTrustedInternal FIRST (before all other checks)
  if (isTrustedInternal === true) {
    return SenderTierEnum.SYSTEM;
  }

  const tiers = config.senderTiers;

  // 1. Check owners
  if (tiers?.owners && matchesList(senderId, senderUsername, tiers.owners)) {
    return SenderTierEnum.OWNER;
  }

  // 2. Check members
  if (tiers?.members && matchesList(senderId, senderUsername, tiers.members)) {
    return SenderTierEnum.MEMBER;
  }

  // 3. Check allowFrom (channel interop)
  if (allowFrom && allowFrom.length > 0) {
    // Wildcard grants MEMBER (not OWNER)
    if (allowFrom.includes("*")) {
      return SenderTierEnum.MEMBER;
    }

    if (matchesList(senderId, senderUsername, allowFrom)) {
      return SenderTierEnum.MEMBER;
    }
  }

  // 4. Fallback
  return SenderTierEnum.GUEST;
}
