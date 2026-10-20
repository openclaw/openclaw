import { projectSessionEntryRecord } from "../../../packages/memory-host-sdk/src/host/session-entry-projection.js";
import {
  buildSessionEntryInProcess,
  readSessionEntryResetRecallCutoff,
} from "../../../packages/memory-host-sdk/src/host/session-files.js";
import { LruCache } from "../../infra/lru-cache.js";
import { runSqliteReadSnapshotSync } from "../../infra/sqlite-transaction.js";
import { prepareAssistantTranscriptText } from "../../shared/chat-message-content.js";
import { withOpenClawAgentDatabaseReadOnly } from "../../state/openclaw-agent-db-readonly.js";
import {
  readTranscriptExportSnapshotReadOnlySync,
  readTranscriptExportSnapshotsFromDatabase,
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
  ReturnType<typeof readTranscriptExportSnapshotsFromDatabase>[number],
  "cold"
>;
type ExportRequest = Parameters<typeof readTranscriptExportSnapshotsFromDatabase>[1][number];
const snapshots = new LruCache<Snapshot>(16, {
  maxBytes: 8 * 1024 * 1024,
  sizeOf: (snapshot) => snapshot.stats.sizeBytes,
});
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
  const prepared: (Snapshot | null | "cold")[] = entries.map(() => null);
  const sliced = new Map<number, { options: ExportRequest["options"]; batchHead: Snapshot }>();
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
        runSqliteReadSnapshotSync(
          database.db,
          () => {
            const requests = group.map(({ index, resolved }): ExportRequest => {
              const request = entries[index]!;
              const previous = snapshots.peek(snapshotKey(request));
              return {
                resolved,
                scope: request.options,
                admission: request.admission,
                options: {
                  projectEvent: (event: unknown) =>
                    projectSessionEntryRecord(event, prepareAssistantTranscriptText),
                  previous:
                    previous?.generation != null && previous.throughSeq !== undefined
                      ? {
                          events: previous.events,
                          generation: previous.generation,
                          throughSeq: previous.throughSeq,
                        }
                      : null,
                },
              };
            });
            // Transcripts the retained-snapshot cache admits (at most MAX_SNAPSHOT_BYTES) are read
            // inside the batch transaction; on SQLite, larger ones, which the cache never retains,
            // are read in slices after it.
            const exported = readTranscriptExportSnapshotsFromDatabase(database, requests, {
              deferAboveBytes: MAX_SNAPSHOT_BYTES,
            });
            for (const [offset, { index }] of group.entries()) {
              const snapshot = exported[offset]!;
              if (snapshot !== "cold" && snapshot.deferred) {
                sliced.set(index, { options: requests[offset]!.options, batchHead: snapshot });
              } else {
                prepared[index] = snapshot;
              }
            }
          },
          { operationLabel: "session transcript export batch" },
        ),
      toDatabaseOptions(group[0]!.resolved),
    );
  }
  // Transcripts above the retention limit read in short slices after the batch transaction.
  for (const [index, { options, batchHead }] of sliced) {
    const request = entries[index]!;
    try {
      // An unchanged transcript keeps the batch statistics instead of reading them again.
      prepared[index] = runWithSessionTranscriptReadFence(
        request.admission,
        () => readTranscriptExportSnapshotReadOnlySync(request.options, options, batchHead) ?? null,
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
      if (snapshot === "cold") {
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

function snapshotKey({ options }: SessionEntriesWorkerInput["entries"][number]) {
  return JSON.stringify([options.storePath, options.agentId, options.sessionId]);
}

function retainSnapshot(key: string, snapshot: Snapshot | null) {
  snapshots.delete(key);
  if (snapshot && snapshot.stats.sizeBytes <= MAX_SNAPSHOT_BYTES) {
    snapshots.set(key, snapshot);
  }
}
