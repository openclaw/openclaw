// ─────────────────────────────────────────────
//  OpenClaw Shield — Geo-Distance Utility
//  Haversine formula + impossible travel detection
//  Adapted from Kairos Shield Protocol (Layer 2)
//  By Kairos Lab
// ─────────────────────────────────────────────

// ─── Constants ───────────────────────────────

export const EARTH_RADIUS_KM = 6371;
export const IMPOSSIBLE_SPEED_KMH = 900;

// ─── Types ───────────────────────────────────

export interface GeoLocation {
  lat: number;
  lon: number;
  timestamp: number;
}

export interface TravelAnalysis {
  distanceKm: number;
  timeDeltaSeconds: number;
  speedKmh: number;
  isImpossible: boolean;
}

// ─── Haversine Formula ───────────────────────

function toRadians(degrees: number): number {
  return degrees * (Math.PI / 180);
}

export function haversineDistance(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const dLat = toRadians(lat2 - lat1);
  const dLon = toRadians(lon2 - lon1);

  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRadians(lat1)) * Math.cos(toRadians(lat2)) * Math.sin(dLon / 2) * Math.sin(dLon / 2);

  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

  return EARTH_RADIUS_KM * c;
}

// ─── Speed Estimation ────────────────────────

export function estimateSpeed(distanceKm: number, timeDeltaSeconds: number): number {
  if (timeDeltaSeconds <= 0) {
    return Infinity;
  }
  return (distanceKm / timeDeltaSeconds) * 3600;
}

// ─── Impossible Travel Detection ─────────────

export function isImpossibleTravel(loc1: GeoLocation, loc2: GeoLocation): boolean {
  const distance = haversineDistance(loc1.lat, loc1.lon, loc2.lat, loc2.lon);
  const timeDelta = Math.abs(loc2.timestamp - loc1.timestamp);
  const speed = estimateSpeed(distance, timeDelta);
  return speed > IMPOSSIBLE_SPEED_KMH;
}

export function analyzeTravelBetween(loc1: GeoLocation, loc2: GeoLocation): TravelAnalysis {
  const distanceKm = haversineDistance(loc1.lat, loc1.lon, loc2.lat, loc2.lon);
  const timeDeltaSeconds = Math.abs(loc2.timestamp - loc1.timestamp);
  const speedKmh = estimateSpeed(distanceKm, timeDeltaSeconds);

  return {
    distanceKm,
    timeDeltaSeconds,
    speedKmh,
    isImpossible: speedKmh > IMPOSSIBLE_SPEED_KMH,
  };
}
