import type { CronJobState } from "../types.js";

export function serializeCronJobState(state: CronJobState): string {
  return JSON.stringify({
    ...state,
    ...(state.lastRunStatus === undefined && state.lastStatus !== undefined
      ? { lastRunStatus: state.lastStatus }
      : {}),
  });
}

/** Round-trips already-typed runtime state without normalizing definition or private authority. */
export function projectCronJobStateThroughStorageCodec(state: CronJobState): CronJobState {
  // SAFETY: This decodes the typed state’s own storage encoding, which preserves its JSON-safe fields.
  return JSON.parse(serializeCronJobState(state)) as CronJobState;
}
