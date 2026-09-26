import { AsyncLocalStorage } from "node:async_hooks";
import type { SessionRowChange } from "../sessions/session-row-changes.js";
import {
  canRunSessionListBackgroundWork,
  yieldSessionListBackgroundWork,
} from "./session-projection-work.js";
import type { Row } from "./session-row-projection-record.js";
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
  let pending: Promise<void> | undefined;
  let activeId: string | undefined;
  let started = false;
  let disposed = false;
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
      if (!row || !entry) {
        continue;
      }
      activeId = id;
      // Same-lifecycle publications retain the generation but supersede these transcript facts.
      const current = () => !disposed && !queued.has(id) && params.current(row);
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
        if (shouldCommit()) {
          params.publish(row, fields);
        }
      } catch {
        // A later owner publication retries optional fields; do not spin on a cold/error row.
      } finally {
        activeId = undefined;
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
    enqueue(id: string, change?: SessionRowChange) {
      if (
        change &&
        "all" in change &&
        typeof change.scope === "string" &&
        !(
          ((change.scope === "config" || change.scope === "stores") && id === activeId) ||
          ((change.scope === "config" || change.scope === "catalog") &&
            params.read(id)?.entry?.fallbackNotice)
        )
      ) {
        return;
      }
      queued.add(id);
      if (started) {
        start();
      }
    },
    remove: (id: string) => queued.delete(id),
    dispose() {
      disposed = true;
      queued.clear();
    },
  };
}
