import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { normalizeCronJobInput } from "../normalize.js";
import { getInvalidPersistedCronJobReason } from "../persisted-shape.js";
import type { CronStoredJob } from "../types.js";
import { hasCanonicalCronDeliveryMode } from "./delivery-codec.js";

/** Read a persisted job definition from the active store or its private run-history archive. */
export function normalizeStoredCronJob(job: Record<string, unknown>): CronStoredJob | null {
  const raw: Record<string, unknown> = structuredClone(job);
  raw.id = normalizeOptionalString(raw.id);
  delete raw.jobId;
  const normalized = normalizeCronJobInput(raw, { applyDefaults: true });
  if (!normalized || getInvalidPersistedCronJobReason(normalized)) {
    return null;
  }
  if (!hasCanonicalCronDeliveryMode(raw.delivery)) {
    normalized.delivery = raw.delivery;
  }
  const createdAtMs =
    typeof normalized.createdAtMs === "number" && Number.isFinite(normalized.createdAtMs)
      ? normalized.createdAtMs
      : Date.now();
  const updatedAtMs =
    typeof normalized.updatedAtMs === "number" && Number.isFinite(normalized.updatedAtMs)
      ? normalized.updatedAtMs
      : createdAtMs;
  const stored = {
    ...normalized,
    createdAtMs,
    updatedAtMs,
    state: isRecord(normalized.state) ? normalized.state : {},
  };
  // SAFETY: The persisted-shape check admits the normalized ID, schedule and payload. Job defaults, timestamps and a state record are supplied above.
  return stored as CronStoredJob;
}
