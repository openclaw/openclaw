import { channel as diagnosticsChannel } from "node:diagnostics_channel";
import type { WorkerTaskControl } from "@openclaw/worker-runtime/worker";
import { projectSessionEntryRecord } from "../../../packages/memory-host-sdk/src/host/session-entry-projection.js";
import {
  renderSessionEntrySnapshot,
  readSessionEntryResetRecallCutoff,
} from "../../../packages/memory-host-sdk/src/host/session-entry-render.js";
import { LruCache } from "../../infra/lru-cache.js";
import { isPostgresSqlConnection } from "../../infra/sql-connection.js";
import { runSqliteReadSnapshotSync } from "../../infra/sqlite-transaction.js";
import type { WorkerTaskChannel } from "../../infra/worker-task-server.js";
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
import { readTranscriptStatsBatchFromDatabase } from "./session-accessor.sqlite-transcript-stats.js";
import { SessionTranscriptColdError } from "./session-transcript-cold-error.js";
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
type PreparedEntries = SessionTranscriptWorkerValues["session-entries"]["entries"];
const snapshots = new LruCache<Snapshot>(16, {
  maxBytes: 8 * 1024 * 1024,
  sizeOf: (snapshot) => snapshot.stats.sizeBytes,
});
diagnosticsChannel("openclaw.memory.critical").subscribe(() => snapshots.clear());
const MAX_SNAPSHOT_BYTES = 4 * 1024 * 1024;

/** The export worker retains projected rows; transcript rewrite identity replaces the prefix. */
export async function prepareSessionMemoryEntry(request: SessionEntryWorkerInput) {
  const [result] = await prepareSessionMemoryEntries([request]);
  if ("cold" in result!) {
    throw new SessionTranscriptColdError(request.options.sessionId);
  }
  return result!;
}

async function prepareSessionMemoryEntries(
  entries: SessionEntriesWorkerInput["entries"],
  publish?: (index: number, value: PreparedEntries[number]) => Promise<void>,
): Promise<PreparedEntries> {
  const results: PreparedEntries = [];
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
    // Metadata estimates choose a working group, not an authority or freshness fence.
    // Each export below still captures its own current, admitted read snapshot.
    const sizing =
      group.length > 1
        ? withOpenClawAgentDatabaseReadOnly(
            (database) => ({
              sizes: readTranscriptStatsBatchFromDatabase(
                database,
                group.map(({ resolved }) => resolved.sessionId),
              ),
              // SQLite reads larger transcripts after the batch transaction, one at a time.
              deferAboveBytes: isPostgresSqlConnection(database.db)
                ? Number.POSITIVE_INFINITY
                : MAX_SNAPSHOT_BYTES,
            }),
            toDatabaseOptions(group[0]!.resolved),
          )
        : undefined;
    const batchBytes = (offset: number) => {
      if (!sizing?.found) {
        return 0;
      }
      const size = sizing.value.sizes[offset]!.sizeBytes;
      return size > sizing.value.deferAboveBytes ? 0 : size;
    };
    for (let start = 0; start < group.length;) {
      let end = start;
      let bytes = 0;
      while (
        end < group.length &&
        end - start < 32 &&
        (end === start || bytes + batchBytes(end) <= MAX_SNAPSHOT_BYTES)
      ) {
        bytes += batchBytes(end);
        end++;
      }
      const batch = group.slice(start, end);
      const requests = batch.map(({ index, resolved }): ExportRequest => {
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
      const exported = withOpenClawAgentDatabaseReadOnly(
        (database) =>
          runSqliteReadSnapshotSync(
            database.db,
            () =>
              readTranscriptExportSnapshotsFromDatabase(database, requests, {
                deferAboveBytes: MAX_SNAPSHOT_BYTES,
              }),
            { operationLabel: "session transcript export batch" },
          ),
        toDatabaseOptions(group[0]!.resolved),
      );
      // Render and deliver serially. Count-only groups previously retained every
      // projected snapshot and every expanded entry in this 512 MiB isolate.
      for (const [offset, { index }] of batch.entries()) {
        const request = entries[index]!;
        let snapshot = exported.found ? exported.value.shift()! : null;
        if (snapshot && snapshot !== "cold" && snapshot.deferred) {
          snapshot = readDeferredSnapshot(request, requests[offset]!.options, snapshot);
        }
        let value: PreparedEntries[number];
        if (snapshot === "cold") {
          value = { cold: true };
        } else {
          retainSnapshot(snapshotKey(request), snapshot);
          const entry = snapshot
            ? await renderSessionEntrySnapshot(request.absPath, request.options, snapshot)
            : null;
          value = {
            entry,
            resetRecallCutoff: entry
              ? readSessionEntryResetRecallCutoff(entry)
              : { state: "absent" },
          };
        }
        if (publish) {
          await publish(index, value);
        } else {
          results[index] = value;
        }
      }
      start = end;
    }
  }
  return results;
}

/** Hands each prepared entry to the host and waits for it to accept that entry before the next. */
export async function deliverSessionMemoryEntries(
  entries: SessionEntriesWorkerInput["entries"],
  channel: WorkerTaskChannel | undefined,
  control: WorkerTaskControl,
): Promise<SessionTranscriptWorkerValues["session-entries"]> {
  if (!channel) {
    throw new Error("Session exports require their host delivery channel");
  }
  channel.consumeInput();
  await prepareSessionMemoryEntries(entries, async (index, value) => {
    control.throwIfCancelled();
    const response = await channel.request({ kind: "session-entries", index, value });
    response.consumed();
    control.throwIfCancelled();
  });
  return { entries: [] };
}

/** Reads a transcript above the retention limit in short slices after its batch transaction. */
function readDeferredSnapshot(
  request: SessionEntriesWorkerInput["entries"][number],
  options: ExportRequest["options"],
  batchHead: Snapshot,
): Snapshot | null | "cold" {
  try {
    // An unchanged transcript keeps the batch statistics instead of reading them again.
    return runWithSessionTranscriptReadFence(
      request.admission,
      () => readTranscriptExportSnapshotReadOnlySync(request.options, options, batchHead) ?? null,
    );
  } catch (error) {
    if (!(error instanceof SessionTranscriptColdError)) {
      throw error;
    }
    return "cold";
  }
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
