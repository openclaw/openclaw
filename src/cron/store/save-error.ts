import { restoreCronLoadError, serializeCronLoadError } from "./load-error.js";

export class CronJobsStoreChangedError extends Error {
  constructor(storePath: string) {
    super(`Cron store at ${storePath} changed after it was read; reload it before writing`);
    this.name = "CronJobsStoreChangedError";
  }
}

export type CronSaveError =
  | { kind: "store-changed"; storePath: string }
  | { kind: "other"; error: ReturnType<typeof serializeCronLoadError> };

export function serializeCronSaveError(error: unknown, storePath: string): CronSaveError {
  return error instanceof CronJobsStoreChangedError
    ? { kind: "store-changed", storePath }
    : { kind: "other", error: serializeCronLoadError(error) };
}

export function restoreCronSaveError(error: CronSaveError): Error {
  return error.kind === "store-changed"
    ? new CronJobsStoreChangedError(error.storePath)
    : restoreCronLoadError(error.error);
}
