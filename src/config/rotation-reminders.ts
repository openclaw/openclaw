/**
 * Rotation reminder tracking for secrets that can't be auto-rotated.
 *
 * Stores rotation metadata as GCP Secret labels:
 *   rotation-type, rotation-interval-days, last-rotated, expires-at, snoozed-until
 *
 * GCP labels only allow lowercase letters, digits, and hyphens.
 * ISO timestamps are encoded: colons → hyphens, dots → hyphens, uppercase → lowercase.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type RotationType = "auto" | "manual" | "dynamic";

export interface RotationMetadata {
  rotationType: RotationType;
  rotationIntervalDays: number;
  lastRotated?: Date;
  expiresAt?: Date;
  snoozedUntil?: Date;
}

export type RotationState = "ok" | "review-due" | "expiring-soon" | "expired" | "snoozed";

export interface RotationStatus {
  state: RotationState;
  daysOverdue?: number;
  daysUntilExpiry?: number;
  nextReviewDate?: Date;
}

export interface SecretWithLabels {
  name: string;
  labels: Record<string, string>;
}

export interface SecretRotationResult {
  name: string;
  metadata: RotationMetadata;
  status: RotationStatus;
}

// ---------------------------------------------------------------------------
// Label encoding helpers (GCP labels: lowercase, digits, hyphens only)
// ---------------------------------------------------------------------------

function encodeTimestamp(d: Date): string {
  // 2026-01-01T00:00:00.000Z → 2026-01-01t00-00-00-000z
  return d.toISOString().toLowerCase().replace(/[:.]/g, "-");
}

function decodeTimestamp(s: string): Date | undefined {
  if (!s) return undefined;
  // 2026-01-01t00-00-00-000z → 2026-01-01T00:00:00.000Z
  // Pattern: YYYY-MM-DDtHH-MM-SS-mmmZ or YYYY-MM-DDtHH-MM-SSZ
  const restored = s
    .replace(/^(\d{4}-\d{2}-\d{2})t(\d{2})-(\d{2})-(\d{2})-(\d{3})z$/i, "$1T$2:$3:$4.$5Z")
    .replace(/^(\d{4}-\d{2}-\d{2})t(\d{2})-(\d{2})-(\d{2})z$/i, "$1T$2:$3:$4Z");
  const d = new Date(restored);
  return isNaN(d.getTime()) ? undefined : d;
}

const VALID_ROTATION_TYPES = new Set<RotationType>(["auto", "manual", "dynamic"]);

// ---------------------------------------------------------------------------
// Parse / Build labels
// ---------------------------------------------------------------------------

export function parseRotationLabels(labels: Record<string, string>): RotationMetadata {
  const rawType = labels["rotation-type"] as RotationType | undefined;
  const rotationType: RotationType = rawType && VALID_ROTATION_TYPES.has(rawType) ? rawType : "manual";

  const rawInterval = parseInt(labels["rotation-interval-days"] ?? "", 10);
  const rotationIntervalDays = isNaN(rawInterval) || rawInterval <= 0 ? 90 : rawInterval;

  return {
    rotationType,
    rotationIntervalDays,
    lastRotated: labels["last-rotated"] ? decodeTimestamp(labels["last-rotated"]) : undefined,
    expiresAt: labels["expires-at"] ? decodeTimestamp(labels["expires-at"]) : undefined,
    snoozedUntil: labels["snoozed-until"] ? decodeTimestamp(labels["snoozed-until"]) : undefined,
  };
}

export function buildRotationLabels(meta: RotationMetadata): Record<string, string> {
  const labels: Record<string, string> = {
    "rotation-type": meta.rotationType,
    "rotation-interval-days": String(meta.rotationIntervalDays),
  };
  if (meta.lastRotated) labels["last-rotated"] = encodeTimestamp(meta.lastRotated);
  if (meta.expiresAt) labels["expires-at"] = encodeTimestamp(meta.expiresAt);
  if (meta.snoozedUntil) labels["snoozed-until"] = encodeTimestamp(meta.snoozedUntil);
  return labels;
}

// ---------------------------------------------------------------------------
// Status Check
// ---------------------------------------------------------------------------

const MS_PER_DAY = 86_400_000;

export function checkRotationStatus(
  meta: RotationMetadata,
  now: Date = new Date(),
  expiryThresholdDays = 14,
): RotationStatus {
  // Auto-rotated secrets don't need manual reminders
  if (meta.rotationType === "auto") {
    return { state: "ok" };
  }

  // Check hard expiry first
  if (meta.expiresAt) {
    const daysUntilExpiry = (meta.expiresAt.getTime() - now.getTime()) / MS_PER_DAY;
    if (daysUntilExpiry <= 0) {
      return { state: "expired", daysUntilExpiry: Math.floor(daysUntilExpiry) };
    }
    if (daysUntilExpiry <= expiryThresholdDays) {
      return { state: "expiring-soon", daysUntilExpiry: Math.floor(daysUntilExpiry) };
    }
  }

  // Check snooze
  if (meta.snoozedUntil && meta.snoozedUntil.getTime() > now.getTime()) {
    return { state: "snoozed" };
  }

  // Check rotation interval
  if (!meta.lastRotated) {
    return { state: "review-due", daysOverdue: meta.rotationIntervalDays };
  }

  const daysSinceRotation = (now.getTime() - meta.lastRotated.getTime()) / MS_PER_DAY;
  if (daysSinceRotation > meta.rotationIntervalDays) {
    const daysOverdue = Math.floor(daysSinceRotation - meta.rotationIntervalDays);
    const nextReviewDate = new Date(meta.lastRotated.getTime() + meta.rotationIntervalDays * MS_PER_DAY);
    return { state: "review-due", daysOverdue, nextReviewDate };
  }

  const nextReviewDate = new Date(meta.lastRotated.getTime() + meta.rotationIntervalDays * MS_PER_DAY);
  return { state: "ok", nextReviewDate };
}

// ---------------------------------------------------------------------------
// Batch check
// ---------------------------------------------------------------------------

export function checkAllSecrets(
  secrets: SecretWithLabels[],
  now: Date = new Date(),
  expiryThresholdDays = 14,
): SecretRotationResult[] {
  return secrets.map((s) => {
    const metadata = parseRotationLabels(s.labels);
    const status = checkRotationStatus(metadata, now, expiryThresholdDays);
    return { name: s.name, metadata, status };
  });
}

// ---------------------------------------------------------------------------
// Event emission
// ---------------------------------------------------------------------------

export type RotationEventListener = (event: string, secretName: string, detail?: unknown) => void;

export function emitRotationEvents(
  results: SecretRotationResult[],
  listener: RotationEventListener,
): void {
  for (const r of results) {
    switch (r.status.state) {
      case "review-due":
        listener("secret:review-due", r.name, { daysOverdue: r.status.daysOverdue });
        break;
      case "expiring-soon":
        listener("secret:expiring-soon", r.name, { daysUntilExpiry: r.status.daysUntilExpiry });
        break;
      case "expired":
        listener("secret:expiring-soon", r.name, { daysUntilExpiry: r.status.daysUntilExpiry, expired: true });
        break;
    }
  }
}

/** Emit auth failure event (called externally when 401/403 detected) */
export function emitAuthFailure(
  secretName: string,
  listener: RotationEventListener,
  detail?: { statusCode?: number; message?: string },
): void {
  listener("secret:auth-failed", secretName, detail);
}

// ---------------------------------------------------------------------------
// Mutations (return new metadata, caller persists)
// ---------------------------------------------------------------------------

export function snoozeReminder(
  meta: RotationMetadata,
  days: number,
  now: Date = new Date(),
): RotationMetadata {
  return {
    ...meta,
    snoozedUntil: new Date(now.getTime() + days * MS_PER_DAY),
  };
}

export function acknowledgeRotation(
  meta: RotationMetadata,
  now: Date = new Date(),
): RotationMetadata {
  return {
    ...meta,
    lastRotated: now,
    snoozedUntil: undefined,
  };
}

export function setRotationInterval(
  meta: RotationMetadata,
  intervalDays: number,
): RotationMetadata {
  return {
    ...meta,
    rotationIntervalDays: intervalDays,
  };
}
