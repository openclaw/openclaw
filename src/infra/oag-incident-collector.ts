import type { OagIncident } from "./oag-memory.js";

const activeIncidents = new Map<string, OagIncident>();

const MAX_ACTIVE_INCIDENTS = 100;

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
  if (activeIncidents.size > MAX_ACTIVE_INCIDENTS) {
    // Evict the oldest incident by firstAt
    let oldestKey: string | null = null;
    let oldestTime = Infinity;
    for (const [k, inc] of activeIncidents) {
      const t = Date.parse(inc.firstAt);
      if (t < oldestTime) {
        oldestTime = t;
        oldestKey = k;
      }
    }
    if (oldestKey) {
      activeIncidents.delete(oldestKey);
    }
  }
}

export function collectActiveIncidents(): OagIncident[] {
  return Array.from(activeIncidents.values());
}

export function clearActiveIncidents(): void {
  activeIncidents.clear();
}
