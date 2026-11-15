import type { PresenceEntry } from "../../api/types.ts";

const PLACE_TOPOLOGY_EVENTS = new Set([
  "config.changed",
  "node.pair.requested",
  "node.pair.resolved",
  "node.runnerInventory.changed",
  "device.pair.requested",
  "device.pair.resolved",
]);

export function isPlaceTopologyEvent(event: string): boolean {
  return PLACE_TOPOLOGY_EVENTS.has(event);
}

export function nodePresenceStateSignature(entries: PresenceEntry[]): string {
  const states = new Map<string, "connected" | "offline">();
  for (const entry of entries) {
    const id = (entry.deviceId ?? entry.instanceId)?.trim().toLowerCase();
    if (!id || !entry.roles?.includes("node")) {
      continue;
    }
    states.set(id, entry.reason?.trim().toLowerCase() === "disconnect" ? "offline" : "connected");
  }
  return JSON.stringify([...states].toSorted(([left], [right]) => left.localeCompare(right)));
}
