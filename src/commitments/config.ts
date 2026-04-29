import { resolveUserTimezone } from "../agents/date-time.js";
import type { OpenClawConfig } from "../config/config.js";
import type { CommitmentsConfig } from "../config/types.commitments.js";

export const DEFAULT_COMMITMENT_EXTRACTION_DEBOUNCE_MS = 15_000;
export const DEFAULT_COMMITMENT_BATCH_MAX_ITEMS = 8;
export const DEFAULT_COMMITMENT_CONFIDENCE_THRESHOLD = 0.72;
export const DEFAULT_COMMITMENT_CARE_CONFIDENCE_THRESHOLD = 0.86;
export const DEFAULT_COMMITMENT_EXTRACTION_TIMEOUT_SECONDS = 45;
export const DEFAULT_COMMITMENT_MAX_PER_HEARTBEAT = 3;
export const DEFAULT_COMMITMENT_EXPIRE_AFTER_HOURS = 72;

export type ResolvedCommitmentsConfig = {
  enabled: boolean;
  store?: string;
  categories: {
    eventCheckIns: boolean;
    deadlineCheckIns: boolean;
    openLoops: boolean;
    careCheckIns: false | "gentle" | true;
  };
  extraction: {
    enabled: boolean;
    model?: string;
    debounceMs: number;
    batchMaxItems: number;
    confidenceThreshold: number;
    careConfidenceThreshold: number;
    timeoutSeconds: number;
  };
  delivery: {
    maxPerHeartbeat: number;
    expireAfterHours: number;
  };
};

function positiveInt(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : fallback;
}

function nonnegativeNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback;
}

function resolveCareCheckIns(
  value: CommitmentsConfig["categories"] | undefined,
): false | "gentle" | true {
  const raw = value?.careCheckIns;
  if (raw === false) {
    return false;
  }
  if (raw === true) {
    return true;
  }
  return "gentle";
}

export function resolveCommitmentsConfig(cfg?: OpenClawConfig): ResolvedCommitmentsConfig {
  const raw = cfg?.commitments;
  const extraction = raw?.extraction;
  const delivery = raw?.delivery;
  return {
    enabled: raw?.enabled !== false,
    store: raw?.store,
    categories: {
      eventCheckIns: raw?.categories?.eventCheckIns !== false,
      deadlineCheckIns: raw?.categories?.deadlineCheckIns !== false,
      openLoops: raw?.categories?.openLoops !== false,
      careCheckIns: resolveCareCheckIns(raw?.categories),
    },
    extraction: {
      enabled: extraction?.enabled !== false,
      model: extraction?.model?.trim() || undefined,
      debounceMs: nonnegativeNumber(
        extraction?.debounceMs,
        DEFAULT_COMMITMENT_EXTRACTION_DEBOUNCE_MS,
      ),
      batchMaxItems: positiveInt(extraction?.batchMaxItems, DEFAULT_COMMITMENT_BATCH_MAX_ITEMS),
      confidenceThreshold: nonnegativeNumber(
        extraction?.confidenceThreshold,
        DEFAULT_COMMITMENT_CONFIDENCE_THRESHOLD,
      ),
      careConfidenceThreshold: nonnegativeNumber(
        extraction?.careConfidenceThreshold,
        DEFAULT_COMMITMENT_CARE_CONFIDENCE_THRESHOLD,
      ),
      timeoutSeconds: positiveInt(
        extraction?.timeoutSeconds,
        DEFAULT_COMMITMENT_EXTRACTION_TIMEOUT_SECONDS,
      ),
    },
    delivery: {
      maxPerHeartbeat: positiveInt(delivery?.maxPerHeartbeat, DEFAULT_COMMITMENT_MAX_PER_HEARTBEAT),
      expireAfterHours: positiveInt(
        delivery?.expireAfterHours,
        DEFAULT_COMMITMENT_EXPIRE_AFTER_HOURS,
      ),
    },
  };
}

export function resolveCommitmentTimezone(cfg?: OpenClawConfig): string {
  return resolveUserTimezone(cfg?.agents?.defaults?.userTimezone);
}
