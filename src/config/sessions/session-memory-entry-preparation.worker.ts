import { projectSessionEntryRecord } from "../../../packages/memory-host-sdk/src/host/session-entry-projection.js";
import {
  renderSessionEntrySnapshot,
  readSessionEntryResetRecallCutoff,
  type SessionEntryRenderSink,
} from "../../../packages/memory-host-sdk/src/host/session-entry-render.js";
import { runSqliteReadSnapshotSync } from "../../infra/sqlite-transaction.js";
import { withOpenClawAgentDatabaseReadOnly } from "../../state/openclaw-agent-db-readonly.js";
import {
  openTranscriptExportInSlices,
  SessionTranscriptExportChangedError,
} from "./session-accessor.sqlite-export-slices.js";
import { readTranscriptExportSnapshotFromDatabase } from "./session-accessor.sqlite-read.js";
import { resolveSqliteTranscriptReadScope, toDatabaseOptions } from "./session-accessor.sqlite-scope.js";
import { SessionTranscriptColdError } from "./session-cold-storage-state.js";
import { runWithSessionTranscriptReadFence } from "./session-transcript-read-fence.js";
import type {
  SessionEntriesWorkerInput,
  SessionEntriesWorkerUpdate,
} from "./session-transcript-worker-read.types.js";

type Snapshot = ReturnType<typeof readTranscriptExportSnapshotFromDatabase>;
type Request = SessionEntriesWorkerInput["entries"][number];
type Delivery = { index: number } & SessionEntriesWorkerUpdate;
const snapshots = new Map<string, Snapshot>();
const MAX_SNAPSHOTS = 16;
const MAX_SNAPSHOT_BYTES = 4 * 1024 * 1024;
const MAX_EXPORT_ATTEMPTS = 3;

/** Each page is consumed before the next slice enters the export worker's heap. */
export async function prepareSessionMemoryEntries(
  entries: SessionEntriesWorkerInput["entries"],
  publish: (delivery: Delivery) => Promise<void>,
): Promise<void> {
  for (const [index, request] of entries.entries()) {
    const resolved = resolveSqliteTranscriptReadScope(request.options);
    // Observers see original messages; projected rows never enter their cache.
    const previous = request.messages ? undefined : snapshots.get(snapshotKey(request));
    const options = {
      projectEvent: request.messages ? undefined : projectSessionEntryRecord,
      previous:
        previous?.generation != null && previous.throughSeq !== undefined
          ? {
              events: previous.events,
              generation: previous.generation,
              throughSeq: previous.throughSeq,
            }
          : null,
    };
    let delivered = false;
    const reset = async () => {
      if (delivered) {
        delivered = false;
        await publish({ index, reset: true, resetMessages: true });
      }
    };
    const sink: SessionEntryRenderSink = {
      prefixLineCount: request.prefixLineCount,
      pageMessages: request.messages,
      page:
        request.pages || request.messages
          ? async (page) => {
              const lines = request.pages && page.lines.length > 0;
              // Message-only pages must also be discarded when this snapshot changes.
              delivered = true;
              await publish({
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
          // Late classification discards rendered text, not the original observations.
          await publish({ index, reset: true });
        }
      },
    };
    let value: Extract<SessionEntriesWorkerUpdate, { value: unknown }>["value"];
    for (let attempt = 1; ; attempt++) {
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
        const snapshot = read.found ? read.value : null;
        if (!request.messages) {
          retainSnapshot(snapshotKey(request), snapshot);
        }
        const opened = snapshot?.deferred
          ? runWithSessionTranscriptReadFence(request.admission, () =>
              openTranscriptExportInSlices({
                ...options,
                sessionId: resolved.sessionId,
                batchHead: snapshot,
                transaction: (read) =>
                  withOpenClawAgentDatabaseReadOnly(
                    (database) =>
                      runSqliteReadSnapshotSync(database.db, () => read(database), {
                        operationLabel: "session transcript export slice",
                      }),
                    toDatabaseOptions(resolved),
                  ),
                readHead: (database, slicing) =>
                  readTranscriptExportSnapshotFromDatabase(
                    database,
                    resolved,
                    request.options,
                    options,
                    slicing,
                  ),
              }),
            )
          : snapshot && { snapshot, events: snapshot.events };
        // Lazy advancement reads its next slice under the same admitted user-turn fence.
        const events = opened && {
          [Symbol.iterator]: () => {
            const iterator = opened.events[Symbol.iterator]();
            return {
              next: () =>
                runWithSessionTranscriptReadFence(request.admission, () => iterator.next()),
            };
          },
        };
        const summary =
          opened && events
            ? await renderSessionEntrySnapshot(
                request.absPath,
                request.options,
                { ...opened.snapshot, events },
                sink,
              )
            : null;
        value = {
          summary,
          resetRecallCutoff: summary ? readSessionEntryResetRecallCutoff(summary) : { state: "absent" },
        };
        break;
      } catch (error) {
        if (error instanceof SessionTranscriptColdError) {
          await reset();
          value = { cold: true };
          break;
        }
        if (!(error instanceof SessionTranscriptExportChangedError) || attempt >= MAX_EXPORT_ATTEMPTS) {
          throw error;
        }
        await reset();
      }
    }
    await publish({ index, value });
  }
}

function snapshotKey({ options }: Request) {
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
