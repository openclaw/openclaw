// ─────────────────────────────────────────────
//  OpenClaw Shield — Session Monitor
//  6 deterministic anomaly detection rules for
//  gateway authentication protection.
//  Adapted from Kairos Shield Protocol (Layer 2)
//  By Kairos Lab
// ─────────────────────────────────────────────

import { haversineDistance, estimateSpeed, IMPOSSIBLE_SPEED_KMH } from "./geo-distance.js";

// ─── Types ───────────────────────────────────

export interface SessionEvent {
  user_id: string;
  event_type: string;
  ip_address: string | null;
  geo_lat: number | null;
  geo_lon: number | null;
  geo_country: string | null;
  device_fingerprint: string | null;
  success: boolean;
  created_at: string; // ISO 8601
}

export interface AnomalyResult {
  triggered: boolean;
  rule: string;
  severity: number; // 1-5
  reason: string;
  recommendedAction: "warn" | "restrict" | "suspend";
  details?: Record<string, unknown>;
}

// ─── Thresholds ──────────────────────────────

export const THRESHOLDS = {
  AUTH_FLOOD_COUNT: 20,
  AUTH_FLOOD_WINDOW_MIN: 5,
  BRUTE_FORCE_COUNT: 5,
  BRUTE_FORCE_WINDOW_MIN: 10,
  DEVICE_SPRAY_COUNT: 5,
  DEVICE_SPRAY_WINDOW_MIN: 60,
  GLOBAL_FLOOD_COUNT: 1000,
  GLOBAL_FLOOD_WINDOW_MIN: 5,
  GLOBAL_FAILURE_RATE: 0.3,
  GLOBAL_FAILURE_MIN_EVENTS: 50,
};

// ─── Helper ──────────────────────────────────

export function filterByWindow(
  events: SessionEvent[],
  windowMinutes: number,
  referenceTime?: Date,
): SessionEvent[] {
  const ref = referenceTime ?? new Date();
  const cutoff = new Date(ref.getTime() - windowMinutes * 60 * 1000);
  return events.filter((e) => new Date(e.created_at) >= cutoff);
}

export function filterByUser(events: SessionEvent[], userId: string): SessionEvent[] {
  return events.filter((e) => e.user_id === userId);
}

// ─── Rule 1: Auth Flood ──────────────────────

export function detectAuthFlood(
  events: SessionEvent[],
  windowMinutes: number = THRESHOLDS.AUTH_FLOOD_WINDOW_MIN,
  referenceTime?: Date,
): AnomalyResult {
  const windowed = filterByWindow(events, windowMinutes, referenceTime);

  return {
    triggered: windowed.length > THRESHOLDS.AUTH_FLOOD_COUNT,
    rule: "AUTH_FLOOD",
    severity: 3,
    reason: `${windowed.length} auth events in ${windowMinutes}min (threshold: ${THRESHOLDS.AUTH_FLOOD_COUNT})`,
    recommendedAction: "restrict",
    details: { count: windowed.length, threshold: THRESHOLDS.AUTH_FLOOD_COUNT, windowMinutes },
  };
}

// ─── Rule 2: Brute Force ─────────────────────

export function detectBruteForce(
  events: SessionEvent[],
  windowMinutes: number = THRESHOLDS.BRUTE_FORCE_WINDOW_MIN,
  referenceTime?: Date,
): AnomalyResult {
  const windowed = filterByWindow(events, windowMinutes, referenceTime);
  const failures = windowed.filter((e) => !e.success);

  return {
    triggered: failures.length > THRESHOLDS.BRUTE_FORCE_COUNT,
    rule: "BRUTE_FORCE",
    severity: 4,
    reason: `${failures.length} failed auths in ${windowMinutes}min (threshold: ${THRESHOLDS.BRUTE_FORCE_COUNT})`,
    recommendedAction: "restrict",
    details: {
      failedCount: failures.length,
      totalCount: windowed.length,
      threshold: THRESHOLDS.BRUTE_FORCE_COUNT,
      windowMinutes,
    },
  };
}

// ─── Rule 3: Impossible Travel ───────────────

export function detectImpossibleTravel(events: SessionEvent[]): AnomalyResult {
  const geoEvents = events
    .filter((e) => e.geo_lat !== null && e.geo_lon !== null)
    .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());

  for (let i = 1; i < geoEvents.length; i++) {
    const prev = geoEvents[i - 1];
    const curr = geoEvents[i];

    const distance = haversineDistance(prev.geo_lat!, prev.geo_lon!, curr.geo_lat!, curr.geo_lon!);
    const timeDelta =
      (new Date(curr.created_at).getTime() - new Date(prev.created_at).getTime()) / 1000;
    const speed = estimateSpeed(distance, timeDelta);

    if (speed > IMPOSSIBLE_SPEED_KMH) {
      return {
        triggered: true,
        rule: "IMPOSSIBLE_TRAVEL",
        severity: 4,
        reason: `Travel speed ${Math.round(speed)} km/h between events (threshold: ${IMPOSSIBLE_SPEED_KMH} km/h)`,
        recommendedAction: "warn",
        details: {
          distanceKm: Math.round(distance),
          timeDeltaSeconds: Math.round(timeDelta),
          speedKmh: Math.round(speed),
          threshold: IMPOSSIBLE_SPEED_KMH,
          from: { lat: prev.geo_lat, lon: prev.geo_lon },
          to: { lat: curr.geo_lat, lon: curr.geo_lon },
        },
      };
    }
  }

  return {
    triggered: false,
    rule: "IMPOSSIBLE_TRAVEL",
    severity: 0,
    reason: "No impossible travel detected",
    recommendedAction: "warn",
  };
}

// ─── Rule 4: Device Spray ────────────────────

export function detectDeviceSpray(
  events: SessionEvent[],
  windowMinutes: number = THRESHOLDS.DEVICE_SPRAY_WINDOW_MIN,
  referenceTime?: Date,
): AnomalyResult {
  const windowed = filterByWindow(events, windowMinutes, referenceTime);
  const uniqueDevices = new Set(
    windowed.map((e) => e.device_fingerprint).filter((fp): fp is string => fp !== null),
  );

  return {
    triggered: uniqueDevices.size > THRESHOLDS.DEVICE_SPRAY_COUNT,
    rule: "DEVICE_SPRAY",
    severity: 3,
    reason: `${uniqueDevices.size} distinct devices in ${windowMinutes}min (threshold: ${THRESHOLDS.DEVICE_SPRAY_COUNT})`,
    recommendedAction: "restrict",
    details: {
      deviceCount: uniqueDevices.size,
      threshold: THRESHOLDS.DEVICE_SPRAY_COUNT,
      windowMinutes,
    },
  };
}

// ─── Rule 5: Global Auth Flood ───────────────

export function detectGlobalFlood(
  events: SessionEvent[],
  windowMinutes: number = THRESHOLDS.GLOBAL_FLOOD_WINDOW_MIN,
  referenceTime?: Date,
): AnomalyResult {
  const windowed = filterByWindow(events, windowMinutes, referenceTime);

  return {
    triggered: windowed.length > THRESHOLDS.GLOBAL_FLOOD_COUNT,
    rule: "GLOBAL_AUTH_FLOOD",
    severity: 5,
    reason: `${windowed.length} platform-wide auths in ${windowMinutes}min (threshold: ${THRESHOLDS.GLOBAL_FLOOD_COUNT})`,
    recommendedAction: "warn",
    details: { count: windowed.length, threshold: THRESHOLDS.GLOBAL_FLOOD_COUNT, windowMinutes },
  };
}

// ─── Rule 6: Global Failure Spike ────────────

export function detectGlobalFailureSpike(
  events: SessionEvent[],
  windowMinutes: number = THRESHOLDS.GLOBAL_FLOOD_WINDOW_MIN,
  referenceTime?: Date,
): AnomalyResult {
  const windowed = filterByWindow(events, windowMinutes, referenceTime);

  if (windowed.length < THRESHOLDS.GLOBAL_FAILURE_MIN_EVENTS) {
    return {
      triggered: false,
      rule: "GLOBAL_FAILURE_SPIKE",
      severity: 0,
      reason: `Insufficient events: ${windowed.length} (min: ${THRESHOLDS.GLOBAL_FAILURE_MIN_EVENTS})`,
      recommendedAction: "warn",
      details: { totalEvents: windowed.length, minRequired: THRESHOLDS.GLOBAL_FAILURE_MIN_EVENTS },
    };
  }

  const failures = windowed.filter((e) => !e.success);
  const failureRate = failures.length / windowed.length;

  return {
    triggered: failureRate > THRESHOLDS.GLOBAL_FAILURE_RATE,
    rule: "GLOBAL_FAILURE_SPIKE",
    severity: failureRate > THRESHOLDS.GLOBAL_FAILURE_RATE ? 5 : 0,
    reason: `${(failureRate * 100).toFixed(1)}% failure rate across ${windowed.length} events (threshold: ${THRESHOLDS.GLOBAL_FAILURE_RATE * 100}%)`,
    recommendedAction: "warn",
    details: {
      failureRate: Math.round(failureRate * 1000) / 1000,
      failedCount: failures.length,
      totalCount: windowed.length,
      threshold: THRESHOLDS.GLOBAL_FAILURE_RATE,
    },
  };
}

// ─── Orchestrator ────────────────────────────

export function evaluateSession(
  userEvents: SessionEvent[],
  allEvents?: SessionEvent[],
  referenceTime?: Date,
): AnomalyResult[] {
  const results: AnomalyResult[] = [];

  const r1 = detectAuthFlood(userEvents, undefined, referenceTime);
  if (r1.triggered) {
    results.push(r1);
  }

  const r2 = detectBruteForce(userEvents, undefined, referenceTime);
  if (r2.triggered) {
    results.push(r2);
  }

  const r3 = detectImpossibleTravel(userEvents);
  if (r3.triggered) {
    results.push(r3);
  }

  const r4 = detectDeviceSpray(userEvents, undefined, referenceTime);
  if (r4.triggered) {
    results.push(r4);
  }

  if (allEvents) {
    const r5 = detectGlobalFlood(allEvents, undefined, referenceTime);
    if (r5.triggered) {
      results.push(r5);
    }

    const r6 = detectGlobalFailureSpike(allEvents, undefined, referenceTime);
    if (r6.triggered) {
      results.push(r6);
    }
  }

  return results;
}
