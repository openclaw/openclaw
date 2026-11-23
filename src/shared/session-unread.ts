import type { SessionEntry } from "../config/sessions/types.js";

/**
 * Unread follows chat content: `lastActivityAt` advances only when a message the chat shows is
 * appended to the transcript. Silent replies and hidden turns move only `lastInteractionAt`.
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
