import { projectSessionEntryRecord } from "../../../packages/memory-host-sdk/src/host/session-entry-projection.js";
import {
  buildSessionEntryInProcess,
  readSessionEntryResetRecallCutoff,
} from "../../../packages/memory-host-sdk/src/host/session-files.js";
import { LruCache } from "../../infra/lru-cache.js";
import { runSqliteDeferredTransactionSync } from "../../infra/sqlite-transaction.js";
import { prepareAssistantTranscriptText } from "../../shared/chat-message-content.js";
import { withOpenClawAgentDatabaseReadOnly } from "../../state/openclaw-agent-db-readonly.js";
import { readTranscriptExportSnapshotsFromDatabase } from "./session-accessor.sqlite-read.js";
import {
  resolveSqliteTranscriptReadScope,
  toDatabaseOptions,
} from "./session-accessor.sqlite-scope.js";
import { SessionTranscriptColdError } from "./session-cold-storage-state.js";
import type {
  SessionEntryWorkerInput,
  SessionEntriesWorkerInput,
} from "./session-transcript-worker-read.types.js";
import type { SessionTranscriptWorkerValues } from "./session-transcript-worker.types.js";

type Snapshot = Exclude<
  ReturnType<typeof readTranscriptExportSnapshotsFromDatabase>[number],
  "cold"
>;
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
            const exported = readTranscriptExportSnapshotsFromDatabase(
              database,
              group.map(({ index, resolved }) => {
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
              }),
            );
            for (const [offset, { index }] of group.entries()) {
              prepared[index] = exported[offset]!;
            }
          },
          { operationLabel: "session transcript export batch" },
        ),
      toDatabaseOptions(group[0]!.resolved),
    );
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
