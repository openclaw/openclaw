/** Opaque revision token for cron configuration, excluding scheduler-maintained state. */
import { hashCronJobDefinition } from "./definition-hash.js";
import { projectCronJobThroughStorageCodec } from "./store/row-codec.js";
import type { CronJob } from "./types.js";

function configRevisionDefinition(projected: CronJob) {
  const { updatedAtMs: _updatedAtMs, state: _state, ...definition } = projected;
  return definition;
}

/** Hashes the job definition while preserving meaningful own-undefined config fields. */
export function resolveCronJobConfigRevision(job: CronJob): string {
  // The storage projector canonicalizes every persisted config seam. Feed it
  // neutral runtime fields so large or malformed trigger state cannot affect the token.
  const projected = projectCronJobThroughStorageCodec({ ...job, updatedAtMs: 0, state: {} });
  return hashCronJobDefinition(configRevisionDefinition(projected));
}

/**
 * Receipt execution fence: full job definition except fields that legitimately
 * mutate mid-run without superseding the admitted payload snapshot.
 *
 * Excludes:
 * - `enabled` (operator disable during run / catch-up)
 * - `delivery` (target writeback during announce)
 * - scheduler-maintained `state` / `updatedAtMs` (already stripped by config revision)
 *
 * Includes payload, precheck, session binding, schedule, agent identity, etc.
 */
export function resolveCronJobExecutionRevision(job: CronJob): string {
  // Neutralize mid-run-mutable fields, then reuse the full config fingerprint path.
  const { delivery: _delivery, ...withoutDelivery } = job;
  const projected = projectCronJobThroughStorageCodec({
    ...withoutDelivery,
    enabled: true,
    updatedAtMs: 0,
    state: {},
  });
  const fingerprint = stableStringify(configRevisionDefinition(projected));
  return `exec-sha256:${sha256Base64Url(fingerprint)}`;
}
