import type { SessionEntry } from "../config/sessions/types.js";

export function deriveSessionUnread(
  entry?: Pick<
    SessionEntry,
    "createdAt" | "lastReadAt" | "markedUnreadAt" | "lastInteractionAt" | "lastActivityAt"
  >,
): boolean {
  // Creation starts unread tracking for modern rows without lighting up legacy
  // rows that predate durable creation provenance.
  const unreadBaselineAt = entry?.lastReadAt ?? entry?.createdAt;
  return (
    entry?.markedUnreadAt !== undefined ||
    (unreadBaselineAt !== undefined &&
      Math.max(entry?.lastInteractionAt ?? 0, entry?.lastActivityAt ?? 0) > unreadBaselineAt)
  );
}
