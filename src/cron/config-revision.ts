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
