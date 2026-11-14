import type { InternalSessionEntry as SessionEntry } from "./types.js";

/** A logical conversation keeps its organization and display choices across reset. */
export function preserveResetSessionPresentation(entry: SessionEntry | undefined) {
  const name = entry?.label?.trim() || entry?.displayName?.trim() || entry?.topicName?.trim();
  return {
    conversationLabelRefinement:
      name && entry
        ? {
            sessionId: entry.sessionId,
            ...(entry.lifecycleRevision ? { lifecycleRevision: entry.lifecycleRevision } : {}),
            remainingMessages: 0,
          }
        : undefined,
    label: entry?.label,
    autoLabel: entry?.autoLabel,
    icon: entry?.icon,
    color: entry?.color,
    category: entry?.category,
    boardFace: entry?.boardFace,
    boardPresentation: entry?.boardPresentation,
    visibility: entry?.visibility,
    displayName: entry?.displayName,
    topicName: entry?.topicName,
    pinnedAt: entry?.pinnedAt,
    sidebarRoot: entry?.sidebarRoot,
  };
}
