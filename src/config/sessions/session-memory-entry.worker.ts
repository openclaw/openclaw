import { channel as diagnosticsChannel } from "node:diagnostics_channel";
import type { WorkerTaskControl } from "@openclaw/worker-runtime/worker";
import { projectSessionEntryRecord } from "../../../packages/memory-host-sdk/src/host/session-entry-projection.js";
import {
  renderSessionEntrySnapshot,
  readSessionEntryResetRecallCutoff,
  type SessionEntryRenderSink,
} from "../../../packages/memory-host-sdk/src/host/session-entry-render.js";
import { LruCache } from "../../infra/lru-cache.js";
import { isPostgresSqlConnection } from "../../infra/sql-connection.js";
import { runSqliteReadSnapshotSync } from "../../infra/sqlite-transaction.js";
import type { WorkerTaskChannel } from "../../infra/worker-task-server.js";
import { prepareAssistantTranscriptText } from "../../shared/chat-message-content.js";
import { withOpenClawAgentDatabaseReadOnly } from "../../state/openclaw-agent-db-readonly.js";
import {
  openTranscriptExportReadOnly,
  readTranscriptExportSnapshotsFromDatabase,
} from "./session-accessor.sqlite-export-read.js";
import { SessionTranscriptExportChangedError } from "./session-accessor.sqlite-export-slices.js";
import {
  resolveSqliteTranscriptReadScope,
  toDatabaseOptions,
} from "./session-accessor.sqlite-scope.js";
import { readTranscriptStatsBatchFromDatabase } from "./session-accessor.sqlite-transcript-stats.js";
import { SessionTranscriptColdError } from "./session-transcript-cold-error.js";
import { runWithSessionTranscriptReadFence } from "./session-transcript-read-fence.js";
import type {
  SessionEntriesWorkerInput,
  SessionEntriesWorkerUpdate,
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
diagnosticsChannel("openclaw.memory.critical").subscribe(() => snapshots.clear());
const MAX_SNAPSHOT_BYTES = 4 * 1024 * 1024;

type StreamRequest = SessionEntriesWorkerInput["entries"][number];
type Delivery = { index: number } & SessionEntriesWorkerUpdate;
// An active transcript may change between slices; each attempt restarts from a fresh head.
const MAX_EXPORT_ATTEMPTS = 3;

/**
 * Hands each export to the host in acknowledged pages, then its summary. Rendered text never
 * accumulates here: transcripts above the retention limit are read, projected and rendered one
 * bounded slice at a time.
 */
export async function deliverSessionMemoryEntries(
  entries: SessionEntriesWorkerInput["entries"],
  channel: WorkerTaskChannel | undefined,
  control: WorkerTaskControl,
): Promise<SessionTranscriptWorkerValues["session-entries"]> {
  if (!channel) {
    throw new Error("Session exports require their host delivery channel");
  }
  channel.consumeInput();
  await streamSessionMemoryEntries(entries, async (delivery) => {
    control.throwIfCancelled();
    const response = await channel.request({ kind: "session-entries", ...delivery });
    response.consumed();
    control.throwIfCancelled();
  });
  return { entries: [] };
}

async function streamSessionMemoryEntries(
  entries: SessionEntriesWorkerInput["entries"],
  send: (delivery: Delivery) => Promise<void>,
): Promise<void> {
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
        // Observers need original messages; projected rows are never mixed into their cache.
        const previous = request.messages ? undefined : snapshots.peek(snapshotKey(request));
        return {
          resolved,
          scope: request.options,
          admission: request.admission,
          options: {
            projectEvent: request.messages ? undefined : projectEvent,
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
      // are streamed in slices after it.
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
      // Render and deliver serially; only the current export's bounded state is live.
      for (const [offset, { index }] of batch.entries()) {
        const request = entries[index]!;
        const snapshot = exported.found ? exported.value.shift()! : null;
        if (snapshot !== "cold" && !request.messages) {
          retainSnapshot(snapshotKey(request), snapshot);
        }
        await send({
          index,
          value: await streamSessionMemoryEntry(
            index,
            request,
            requests[offset]!.options,
            snapshot,
            send,
          ),
        });
      }
      start = end;
    }
  }
}

function projectEvent(event: unknown) {
  return projectSessionEntryRecord(event, prepareAssistantTranscriptText);
}

async function streamSessionMemoryEntry(
  index: number,
  request: StreamRequest,
  exportOptions: ExportRequest["options"],
  batchSnapshot: Snapshot | null | "cold",
  send: (delivery: Delivery) => Promise<void>,
): Promise<Extract<SessionEntriesWorkerUpdate, { value: unknown }>["value"]> {
  let delivered = false;
  const sink: SessionEntryRenderSink = {
    prefixLineCount: request.prefixLineCount,
    pageMessages: request.messages,
    page:
      request.pages || request.messages
        ? async (page) => {
            const lines = request.pages && page.lines.length > 0;
            delivered ||= lines;
            await send({
              index,
              page: lines
                ? page
                : {
                    startLine: page.startLine,
                    lines: [],
                    lineMap: [],
                    messageTimestampsMs: [],
                    lineProvenance: [],
                    ...(page.messages ? { messages: page.messages } : {}),
                  },
            });
          }
        : undefined,
    reset: async () => {
      if (delivered) {
        delivered = false;
        await send({ index, reset: true });
      }
    },
  };
  if (batchSnapshot === "cold") {
    return { cold: true };
  }
  for (let attempt = 1; ; attempt++) {
    try {
      const opened =
        attempt === 1 && !batchSnapshot?.deferred
          ? batchSnapshot && { snapshot: batchSnapshot, events: batchSnapshot.events }
          : openDeferredExport(
              request,
              exportOptions,
              attempt === 1 ? (batchSnapshot ?? undefined) : undefined,
            );
      const summary = opened
        ? await renderSessionEntrySnapshot(
            request.absPath,
            request.options,
            { ...opened.snapshot, events: opened.events },
            sink,
          )
        : null;
      return {
        summary,
        resetRecallCutoff: summary
          ? readSessionEntryResetRecallCutoff(summary)
          : { state: "absent" },
      };
    } catch (error) {
      if (error instanceof SessionTranscriptColdError) {
        await sink.reset?.();
        return { cold: true };
      }
      if (
        !(error instanceof SessionTranscriptExportChangedError) ||
        attempt >= MAX_EXPORT_ATTEMPTS
      ) {
        throw error;
      }
      await sink.reset?.();
    }
  }
}

/** Opens a transcript above the retention limit for slice-by-slice rendering. */
function openDeferredExport(
  request: StreamRequest,
  options: ExportRequest["options"],
  batchHead: Snapshot | undefined,
) {
  // A fresh head still reuses a retained prefix while its generation matches.
  const opened = runWithSessionTranscriptReadFence(request.admission, () =>
    openTranscriptExportReadOnly(request.options, options, batchHead),
  );
  if (!opened || !request.admission) {
    return opened;
  }
  // Admitted reads project each slice under the same fence as their head.
  const events = opened.events;
  const admission = request.admission;
  return {
    snapshot: opened.snapshot,
    events: {
      [Symbol.iterator]: () => ({
        next: () => runWithSessionTranscriptReadFence(admission, () => events.next()),
      }),
    },
  };
}

function snapshotKey({ options }: StreamRequest) {
  return JSON.stringify([options.storePath, options.agentId, options.sessionId]);
}

function retainSnapshot(key: string, snapshot: Snapshot | null) {
  snapshots.delete(key);
  if (snapshot && snapshot.stats.sizeBytes <= MAX_SNAPSHOT_BYTES) {
    snapshots.set(key, snapshot);
  }
}
