/**
 * High-level inbound event class used to separate actionable user requests from room activity.
 */
export type InboundEventKind = "user_request" | "room_event";

/**
 * True when an inbound turn was driven by a system/background event (room activity)
 * rather than a direct user request. Such turns may legitimately end silent.
 */
export function isSystemEventInbound(kind: InboundEventKind | undefined): boolean {
  return kind === "room_event";
}
