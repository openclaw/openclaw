import type { SessionEntry } from "./types.js";

/** A logical conversation keeps its organization and display choices across reset. */
export function preserveResetSessionPresentation(entry: SessionEntry | undefined) {
  return {
    label: entry?.label,
    autoLabel: entry?.autoLabel,
    icon: entry?.icon,
    category: entry?.category,
    boardFace: entry?.boardFace,
    boardPresentation: entry?.boardPresentation,
    visibility: entry?.visibility,
    displayName: entry?.displayName,
    pinnedAt: entry?.pinnedAt,
    sidebarRoot: entry?.sidebarRoot,
  };
}
