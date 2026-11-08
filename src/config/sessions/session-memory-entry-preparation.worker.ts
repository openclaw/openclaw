import { projectSessionEntryRecord } from "../../../packages/memory-host-sdk/src/host/session-entry-projection.js";
import {
  renderSessionEntrySnapshot,
  readSessionEntryResetRecallCutoff,
} from "../../../packages/memory-host-sdk/src/host/session-entry-render.js";
import { runSqliteReadSnapshotSync } from "../../infra/sqlite-transaction.js";
import { withOpenClawAgentDatabaseReadOnly } from "../../state/openclaw-agent-db-readonly.js";
import {
  readTranscriptExportSnapshotFromDatabase,
  readTranscriptExportSnapshotReadOnlySync,
} from "./session-accessor.sqlite-read.js";
import {
  resolveSqliteTranscriptReadScope,
  toDatabaseOptions,
} from "./session-accessor.sqlite-scope.js";
import { SessionTranscriptColdError } from "./session-cold-storage-state.js";
import { runWithSessionTranscriptReadFence } from "./session-transcript-read-fence.js";
import type {
  SessionEntryWorkerInput,
  SessionEntriesWorkerInput,
} from "./session-transcript-worker-read.types.js";
import type { SessionTranscriptWorkerValues } from "./session-transcript-worker.types.js";

type Snapshot = ReturnType<typeof readTranscriptExportSnapshotFromDatabase>;
const snapshots = new Map<string, Snapshot>();
const MAX_SNAPSHOTS = 16;
const MAX_SNAPSHOT_BYTES = 4 * 1024 * 1024;

/** The export worker retains projected rows; transcript rewrite identity replaces the prefix. */
export async function prepareSessionMemoryEntry(request: SessionEntryWorkerInput) {
  const [result] = await prepareSessionMemoryEntries([request]);
  if ("cold" in result!) {
    throw new SessionTranscriptColdError(request.options.sessionId);
  }
  return result!;
}

export async function prepareSessionMemoryEntries(
  entries: SessionEntriesWorkerInput["entries"],
  publish?: (
    index: number,
    value: SessionTranscriptWorkerValues["session-entries"]["entries"][number],
  ) => Promise<void>,
): Promise<SessionTranscriptWorkerValues["session-entries"]["entries"]> {
  const results: SessionTranscriptWorkerValues["session-entries"]["entries"] = [];
  // Export one admitted snapshot at a time. The host acknowledges its rendered value
  // before another transcript enters this worker's bounded heap.
  for (const [index, request] of entries.entries()) {
    const resolved = resolveSqliteTranscriptReadScope(request.options);
    const previous = snapshots.get(snapshotKey(request));
    const options = {
      projectEvent: projectSessionEntryRecord,
      previous:
        previous?.generation != null && previous.throughSeq !== undefined
          ? {
              events: previous.events,
              generation: previous.generation,
              throughSeq: previous.throughSeq,
            }
          : null,
    };
    let snapshot: Snapshot | null | "cold";
    try {
      const read = withOpenClawAgentDatabaseReadOnly(
        (database) =>
          runSqliteReadSnapshotSync(
            database.db,
            () =>
              runWithSessionTranscriptReadFence(request.admission, () =>
                readTranscriptExportSnapshotFromDatabase(
                  database,
                  resolved,
                  request.options,
                  options,
                  { deferAboveBytes: MAX_SNAPSHOT_BYTES },
                ),
              ),
            { operationLabel: "session transcript export" },
          ),
        toDatabaseOptions(resolved),
      );
      snapshot = read.found ? read.value : null;
      if (snapshot?.deferred) {
        const batchHead = snapshot;
        snapshot = runWithSessionTranscriptReadFence(
          request.admission,
          () =>
            readTranscriptExportSnapshotReadOnlySync(request.options, options, batchHead) ?? null,
        );
      }
    } catch (error) {
      if (!(error instanceof SessionTranscriptColdError)) {
        throw error;
      }
      snapshot = "cold";
    }
    let value: SessionTranscriptWorkerValues["session-entries"]["entries"][number];
    if (snapshot === "cold") {
      value = { cold: true };
    } else {
      retainSnapshot(snapshotKey(request), snapshot);
      const entry = snapshot
        ? await renderSessionEntrySnapshot(request.absPath, request.options, snapshot)
        : null;
      value = {
        entry,
        resetRecallCutoff: entry ? readSessionEntryResetRecallCutoff(entry) : { state: "absent" },
      };
    }
    if (publish) {
      await publish(index, value);
    } else {
      results[index] = value;
    }
  }
  return results;
}

function snapshotKey({ options }: SessionEntriesWorkerInput["entries"][number]) {
  return JSON.stringify([options.storePath, options.agentId, options.sessionId]);
}

function retainSnapshot(key: string, snapshot: Snapshot | null) {
  snapshots.delete(key);
  if (snapshot && snapshot.stats.sizeBytes <= MAX_SNAPSHOT_BYTES) {
    snapshots.set(key, snapshot);
    if (snapshots.size > MAX_SNAPSHOTS) {
      snapshots.delete(snapshots.keys().next().value!);
    }
  }
}
