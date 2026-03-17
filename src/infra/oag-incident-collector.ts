import { emitOagEvent } from "./oag-event-bus.js";
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
    if (incident.lastError !== undefined) {
      existing.lastError = incident.lastError;
    }
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
  emitOagEvent("incident_recorded", {
    type: incident.type,
    channel: incident.channel,
    detail: incident.detail,
  });
}

export function collectActiveIncidents(): OagIncident[] {
  return Array.from(activeIncidents.values());
}

export function clearActiveIncidents(): void {
  activeIncidents.clear();
}

export function resolveIncidentOutcome(key: string, recoveryMs: number): void {
  const existing = activeIncidents.get(key);
  if (existing) {
    existing.resolvedAt = Date.now();
    existing.recoveryMs = recoveryMs;
  }
}
