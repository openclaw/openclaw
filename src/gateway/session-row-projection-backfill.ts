import { AsyncLocalStorage } from "node:async_hooks";
import { isDeepStrictEqual } from "node:util";
import {
  canRunSessionListBackgroundWork,
  yieldSessionListBackgroundWork,
} from "./session-projection-work.js";
import { identity, type EntryRow, type Row } from "./session-row-projection-record.js";
import { backfillSessionRowTranscriptFields } from "./session-row-transcript-backfill.js";

/** Optional transcript work never participates in row readiness or a foreground response. */
export function createSessionRowProjectionBackfill(params: {
  ready: () => Promise<void>;
  read: (id: string) => Row | undefined;
  current: (row: Row) => boolean;
  publish: (
    row: Row,
    fields: Awaited<ReturnType<typeof backfillSessionRowTranscriptFields>>,
  ) => void;
}) {
  const inOwnerContext = AsyncLocalStorage.snapshot();
  const queued = new Set<string>();
  const revisions = new Map<string, ReturnType<typeof revision>>();
  let pending: Promise<void> | undefined;
  let started = false;
  let disposed = false;
  function revision(row: EntryRow, watermark: Row["retainedDatabaseFacts"]) {
    const { entry, materialized } = row;
    return {
      generation: row.generation,
      watermark: watermark?.activitySummaryWatermark,
      fallback: entry.fallbackNotice && {
        status: entry.status,
        lastRunId: entry.lastRunId,
        modelProvider: entry.modelProvider,
        model: entry.model,
        notice: entry.fallbackNotice,
        selectedModel: materialized?.source.selectedModel,
      },
    };
  }
  async function drain() {
    for (;;) {
      if (disposed || !queued.size) {
        return;
      }
      await yieldSessionListBackgroundWork();
      await params.ready();
      if (disposed) {
        return;
      }
      if (!canRunSessionListBackgroundWork()) {
        continue;
      }
      const id = queued.values().next().value;
      if (id === undefined) {
        continue;
      }
      queued.delete(id);
      const row = params.read(id);
      const entry = row?.entry;
      const captured = revisions.get(id);
      if (!row || !entry || !captured) {
        continue;
      }
      const current = () => {
        const live = params.read(id);
        return !disposed && revisions.get(id) === captured && live?.generation === row.generation;
      };
      let interrupted = false;
      const shouldCommit = () => {
        if (!canRunSessionListBackgroundWork()) {
          interrupted = true;
          return false;
        }
        return current();
      };
      try {
        const fields = await backfillSessionRowTranscriptFields({
          ...row.storeTarget,
          agentId: row.agentId,
          storeAgentId: row.storeTarget.agentId,
          sessionKey: row.key,
          sessionId: entry.sessionId,
          sessionEntry: entry,
          shouldCommit,
          model: row.materialized && {
            selectedProvider: row.materialized.source.selectedModel.provider,
            selectedModel: row.materialized.source.selectedModel.model,
            config: row.materialized.source.cfg,
          },
        });
        // Metadata can rematerialize the row without changing its transcript revision.
        for (;;) {
          if (interrupted) {
            break;
          }
          await params.ready();
          if (!shouldCommit()) {
            break;
          }
          const live = params.read(id);
          if (live && params.current(live)) {
            params.publish(row, fields);
            break;
          }
        }
      } catch {
        // A later owner publication retries optional fields; do not spin on a cold/error row.
        if (current()) {
          revisions.delete(id);
        }
      } finally {
        if (interrupted && current()) {
          queued.add(id);
        }
      }
    }
  }
  function start() {
    started = true;
    if (!disposed && !pending && queued.size) {
      pending = inOwnerContext(drain).then(
        () => {
          pending = undefined;
          start();
        },
        (error: unknown) => {
          pending = undefined;
          throw error;
        },
      );
      void pending.catch(() => {});
    }
  }
  return {
    start,
    prepare(row: EntryRow, facts: Row["retainedDatabaseFacts"]) {
      const id = identity(row);
      const next = revision(row, facts);
      const previous = revisions.get(id);
      if (!isDeepStrictEqual(previous, next)) {
        revisions.set(id, next);
        queued.add(id);
      }
      if (started) {
        start();
      }
    },
    remove(this: void, id: string) {
      revisions.delete(id);
      queued.delete(id);
    },
    dispose() {
      disposed = true;
      queued.clear();
      revisions.clear();
    },
  };
}
