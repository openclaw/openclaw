// Carries session visibility and interaction facts through an inbound entry rebuild.
import type { SessionEntry } from "../../config/sessions/types.js";

export function projectSessionEntryLifecycleCarry({
  entry,
  baseEntry,
  isSystemEvent,
  now,
}: {
  entry: SessionEntry | undefined;
  baseEntry: SessionEntry | undefined;
  isSystemEvent: boolean;
  now: number;
}): Pick<
  SessionEntry,
  "lastInteractionAt" | "agentStatus" | "pinnedAt" | "snoozedUntil" | "snoozedAt"
> {
  return {
    lastInteractionAt: isSystemEvent ? baseEntry?.lastInteractionAt : now,
    agentStatus: isSystemEvent ? baseEntry?.agentStatus : undefined,
    pinnedAt: entry?.pinnedAt,
    snoozedUntil: isSystemEvent ? entry?.snoozedUntil : undefined,
    snoozedAt: isSystemEvent ? entry?.snoozedAt : undefined,
  };
}
