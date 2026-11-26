import type { SessionEntry } from "../config/sessions/types.js";

/**
 * Unread follows chat content: `lastActivityAt` advances when a run ends with a new visible reply
 * in its transcript, a channel message arrives, or a background result is delivered. Silent and
 * hidden turns advance only `lastInteractionAt` (the idle-reset clock).
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
