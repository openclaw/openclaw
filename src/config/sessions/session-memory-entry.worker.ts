import { projectSessionEntryRecord } from "../../../packages/memory-host-sdk/src/host/session-entry-projection.js";
import {
  buildSessionEntryInProcess,
  readSessionEntryResetRecallCutoff,
} from "../../../packages/memory-host-sdk/src/host/session-files.js";
import { readTranscriptExportSnapshotReadOnlySync } from "./session-accessor.sqlite-read.js";
import type { SessionEntryWorkerInput } from "./session-transcript-worker-read.types.js";

type Snapshot = NonNullable<ReturnType<typeof readTranscriptExportSnapshotReadOnlySync>>;
const snapshots = new Map<string, Snapshot>();
const MAX_SNAPSHOTS = 16;
const MAX_SNAPSHOT_BYTES = 4 * 1024 * 1024;

/** The export worker retains projected rows; transcript rewrite identity replaces the prefix. */
export async function prepareSessionMemoryEntry(request: SessionEntryWorkerInput) {
  const { options } = request;
  const key = JSON.stringify([options.storePath, options.agentId, options.sessionId]);
  const previous = snapshots.get(key);
  const snapshot = readTranscriptExportSnapshotReadOnlySync(options, {
    projectEvent: projectSessionEntryRecord,
    previous:
      previous?.generation != null && previous.throughSeq !== undefined
        ? {
            events: previous.events,
            generation: previous.generation,
            throughSeq: previous.throughSeq,
          }
        : null,
  });
  snapshots.delete(key);
  if (snapshot && snapshot.stats.sizeBytes <= MAX_SNAPSHOT_BYTES) {
    snapshots.set(key, snapshot);
    if (snapshots.size > MAX_SNAPSHOTS) {
      snapshots.delete(snapshots.keys().next().value!);
    }
  }
  const entry = snapshot
    ? await buildSessionEntryInProcess(request.absPath, options, snapshot)
    : null;
  return {
    entry,
    resetRecallCutoff: entry
      ? readSessionEntryResetRecallCutoff(entry)
      : { state: "absent" as const },
  };
}
