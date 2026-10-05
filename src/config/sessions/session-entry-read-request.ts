import type { SessionEntryWorkerRead } from "./session-entry-read-runtime.types.js";
import type { SessionExactEntriesWorkerSelection } from "./session-entry-read.types.js";

/** Ordinary and ordered readers capture the same selection and ancillary facts. */
export function captureSessionEntryWorkerRequest(input: SessionEntryWorkerRead) {
  const selection: SessionExactEntriesWorkerSelection = input.selection
    ? { selection: input.selection, projection: input.projection }
    : { sessionKeys: [...new Set(input.sessionKeys)], projection: input.projection };
  return {
    ...selection,
    snapshotFields: input.snapshotFields,
    lifecycleSessionKey: input.lifecycleSessionKey,
    includeMembers: input.includeMembers,
    includeParticipantRecords: input.includeParticipantRecords,
    includeAuthorization: input.includeAuthorization,
  };
}
