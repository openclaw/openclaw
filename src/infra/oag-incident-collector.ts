import type { OagIncident } from "./oag-memory.js";

const activeIncidents = new Map<string, OagIncident>();

export function recordOagIncident(
  incident: Omit<OagIncident, "firstAt" | "lastAt" | "count">,
): void {
  const key = `${incident.type}:${incident.channel ?? "all"}`;
  const existing = activeIncidents.get(key);
  const now = new Date().toISOString();
  if (existing) {
    existing.count += 1;
    existing.lastAt = now;
    existing.detail = incident.detail;
  } else {
    activeIncidents.set(key, {
      ...incident,
      count: 1,
      firstAt: now,
      lastAt: now,
    });
  }
}

export function collectActiveIncidents(): OagIncident[] {
  return Array.from(activeIncidents.values());
}

export function clearActiveIncidents(): void {
  activeIncidents.clear();
}
