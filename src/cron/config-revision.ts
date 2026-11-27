/** Opaque revision token for cron configuration, excluding scheduler-maintained state. */
import { hashCronJobDefinition } from "./definition-hash.js";
import { projectCronJobThroughStorageCodec } from "./store/row-codec.js";
import type { CronStoredJob } from "./types.js";

export class CronJobConfigRevisionConflictError extends Error {
  constructor(
    readonly expectedConfigRevision: string,
    readonly actualConfigRevision: string,
  ) {
    super("cron job definition no longer matches the loaded version");
    this.name = "CronJobConfigRevisionConflictError";
  }
}

function configRevisionDefinition(projected: CronStoredJob) {
  const { updatedAtMs: _updatedAtMs, state: _state, ...definition } = projected;
  return definition;
}

/** Hashes the job definition while preserving meaningful own-undefined config fields. */
export function resolveCronJobConfigRevision(
  job: CronStoredJob,
  legacy?: { inferenceBinding: unknown },
): string {
  // The storage projector canonicalizes every persisted config seam. Feed it
  // neutral runtime fields so large or malformed trigger state cannot affect the token.
  const projected = projectCronJobThroughStorageCodec({ ...job, updatedAtMs: 0, state: {} });
  const definition = configRevisionDefinition(projected);
  // Doctor compares old revisions without admitting retired fields through the live codec.
  return hashCronJobDefinition(legacy ? { ...definition, ...legacy } : definition);
}

export type CronJobConfigRevisionResult = string | Error;

/** Preserve lazy comparison errors while the service normalizes/quarantines loaded rows. */
export function captureCronJobConfigRevision(job: CronStoredJob): CronJobConfigRevisionResult {
  try {
    return resolveCronJobConfigRevision(job);
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
}
