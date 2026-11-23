import type { SessionEntry } from "../config/sessions/types.js";

/**
 * Unread follows visible activity: `lastActivityAt` advances only when a visible run completes or
 * a channel message arrives. Hidden turns advance `lastInteractionAt` (the idle-reset clock) only.
 */
export function deriveSessionUnread(
  entry?: Pick<SessionEntry, "createdAt" | "lastReadAt" | "markedUnreadAt" | "lastActivityAt">,
): boolean {
  // Creation starts unread tracking for modern rows without lighting up legacy
  // rows that predate durable creation provenance.
  const unreadBaselineAt = entry?.lastReadAt ?? entry?.createdAt;
  return (
    entry?.markedUnreadAt !== undefined ||
    (unreadBaselineAt !== undefined && (entry?.lastActivityAt ?? 0) > unreadBaselineAt)
  );
}
