import { projectSessionEntryRecord } from "../../../packages/memory-host-sdk/src/host/session-entry-projection.js";
import {
  buildSessionEntryInProcess,
  readSessionEntryResetRecallCutoff,
} from "../../../packages/memory-host-sdk/src/host/session-files.js";
import { runSqliteDeferredTransactionSync } from "../../infra/sqlite-transaction.js";
import { withOpenClawAgentDatabaseReadOnly } from "../../state/openclaw-agent-db-readonly.js";
import {
  readTranscriptExportSnapshotFromDatabase,
  readTranscriptExportSnapshotReadOnlySync,
  type TranscriptExportBatchHead,
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

type Snapshot = Exclude<
  ReturnType<typeof readTranscriptExportSnapshotFromDatabase>,
  { sliced: TranscriptExportBatchHead }
>;
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
): Promise<SessionTranscriptWorkerValues["session-entries"]["entries"]> {
  const prepared: (Snapshot | TranscriptExportBatchHead | null | "cold")[] = entries.map(
    () => null,
  );
  const groups = new Map<
    string,
    { index: number; resolved: ReturnType<typeof resolveSqliteTranscriptReadScope> }[]
  >();
  for (const [index, { options }] of entries.entries()) {
    const resolved = resolveSqliteTranscriptReadScope(options);
    const key = JSON.stringify([resolved.databaseAgentId ?? resolved.agentId, resolved.path]);
    const group = groups.get(key) ?? [];
    group.push({ index, resolved });
    groups.set(key, group);
  }
  for (const group of groups.values()) {
    withOpenClawAgentDatabaseReadOnly(
      (database) =>
        runSqliteDeferredTransactionSync(
          database.db,
          () => {
            // Transcripts the retained-snapshot cache admits (at most MAX_SNAPSHOT_BYTES) are read
            // inside the batch transaction; larger ones, which the cache never retains, are read
            // in slices after it.
            for (const { index, resolved } of group) {
              const request = entries[index]!;
              try {
                const snapshot = runWithSessionTranscriptReadFence(request.admission, () =>
                  readTranscriptExportSnapshotFromDatabase(
                    database,
                    resolved,
                    request.options,
                    exportOptions(request),
                    { sliceAboveBytes: MAX_SNAPSHOT_BYTES },
                  ),
                );
                prepared[index] = "sliced" in snapshot ? snapshot.sliced : snapshot;
              } catch (error) {
                if (!(error instanceof SessionTranscriptColdError)) {
                  throw error;
                }
                prepared[index] = "cold";
              }
            }
          },
          { operationLabel: "session transcript export batch" },
        ),
      toDatabaseOptions(group[0]!.resolved),
    );
  }
  // Transcripts above the retention limit read in short slices after the batch transaction.
  for (const [index, request] of entries.entries()) {
    const batchHead = prepared[index];
    if (!batchHead || batchHead === "cold" || !("head" in batchHead)) {
      continue;
    }
    try {
      // An unchanged transcript keeps the batch statistics instead of reading them again.
      prepared[index] = runWithSessionTranscriptReadFence(
        request.admission,
        () =>
          readTranscriptExportSnapshotReadOnlySync(
            request.options,
            exportOptions(request),
            batchHead,
          ) ?? null,
      );
    } catch (error) {
      if (!(error instanceof SessionTranscriptColdError)) {
        throw error;
      }
      prepared[index] = "cold";
    }
  }
  return Promise.all(
    entries.map(async (request, index) => {
      const snapshot = prepared[index]!;
      if (snapshot === "cold" || (snapshot && "head" in snapshot)) {
        return { cold: true as const };
      }
      retainSnapshot(snapshotKey(request), snapshot);
      const entry = snapshot
        ? await buildSessionEntryInProcess(request.absPath, request.options, snapshot)
        : null;
      return {
        entry,
        resetRecallCutoff: entry
          ? readSessionEntryResetRecallCutoff(entry)
          : { state: "absent" as const },
      };
    }),
  );
}

function exportOptions(request: SessionEntriesWorkerInput["entries"][number]) {
  const previous = snapshots.get(snapshotKey(request));
  return {
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
