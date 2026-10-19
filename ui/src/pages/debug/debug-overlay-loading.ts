export const DEBUG_OVERLAY_SECTION_HEADERS = {
  lanes: { id: "lanes", titleKey: "debug.overlay.lanes" },
  status: { id: "status", titleKey: "debug.overlay.status" },
  "active-runs": { id: "active-runs", titleKey: "debug.overlay.activeRuns" },
  events: { id: "events", titleKey: "debug.overlay.events" },
} as const;

export type DebugOverlaySectionId = keyof typeof DEBUG_OVERLAY_SECTION_HEADERS;
