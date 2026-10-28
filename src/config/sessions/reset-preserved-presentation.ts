import { resetTitleRefinementState } from "../../sessions/session-title-refinement-state.js";
import type { InternalSessionEntry } from "./types.js";

/** A logical conversation keeps its organization and display choices across reset. */
export function preserveResetSessionPresentation(
  entry: InternalSessionEntry | undefined,
  mode: "reset" | "new" = "reset",
  sessionId = entry?.sessionId ?? "",
) {
  return {
    label: entry?.label,
    autoLabel: entry?.autoLabel,
    icon: entry?.icon,
    category: entry?.category,
    boardFace: entry?.boardFace,
    boardPresentation: entry?.boardPresentation,
    visibility: entry?.visibility,
    displayName: entry?.displayName,
    titleRefinement: resetTitleRefinementState(entry?.titleRefinement, sessionId, mode),
    pinnedAt: entry?.pinnedAt,
    sidebarRoot: entry?.sidebarRoot,
  };
}
