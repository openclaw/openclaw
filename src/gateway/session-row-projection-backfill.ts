import { AsyncLocalStorage } from "node:async_hooks";
import { isDeepStrictEqual } from "node:util";
import { yieldSessionListBackgroundWork } from "./session-projection-work.js";
import { identity, type EntryRow, type Row } from "./session-row-projection-record.js";
import {
  backfillSessionRowTranscriptFields,
  presentSessionRowTranscriptFields,
} from "./session-row-transcript-backfill.js";

function transcriptParams(row: Row, entry: EntryRow["entry"]) {
  return {
    ...row.storeTarget,
    agentId: row.agentId,
    storeAgentId: row.storeTarget.agentId,
    sessionKey: row.key,
    sessionId: entry.sessionId,
    sessionEntry: entry,
    model: row.materialized && {
      selectedProvider: row.materialized.source.selectedModel.provider,
      selectedModel: row.materialized.source.selectedModel.model,
      config: row.materialized.source.cfg,
    },
  };
}

/** Optional transcript work never participates in row readiness or a foreground response. */
export function createSessionRowProjectionBackfill(params: {
  ready: () => Promise<void>;
  read: (id: string) => Row | undefined;
  current: (row: Row) => boolean;
  publish: (
    row: Row,
    fields: NonNullable<Awaited<ReturnType<typeof backfillSessionRowTranscriptFields>>>,
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
      try {
        const fields = await backfillSessionRowTranscriptFields(transcriptParams(row, entry));
        const live = params.read(id);
        // A replacement/private-session revocation must not publish another session's text.
        if (!disposed && live?.entry && params.current(row)) {
          const facts = live.retainedDatabaseFacts;
          // A newer unknown assistant fact needs its queued read, not this older snapshot.
          if (revisions.get(id) !== captured && facts?.transcriptAssistantMessage === "unknown") {
            continue;
          }
          if (fields && facts?.transcriptAssistantMessage === "unknown") {
            facts.transcriptAssistantMessage = fields.lastAssistantMessage ?? null;
          }
          params.publish(
            live,
            facts?.transcriptPreview !== undefined &&
              facts.transcriptAssistantMessage !== "unknown" &&
              facts.transcriptTerminalModel !== undefined
              ? presentSessionRowTranscriptFields(transcriptParams(live, live.entry), {
                  lastMessagePreview: facts.transcriptPreview,
                  lastAssistantMessage: facts.transcriptAssistantMessage,
                  terminalModel: facts.transcriptTerminalModel,
                })
              : (fields ?? {}),
          );
        }
      } catch {
        // A later owner publication retries optional fields; do not spin on a cold/error row.
        if (revisions.get(id) === captured) {
          revisions.delete(id);
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
      if (facts?.transcriptPreview !== undefined && facts.transcriptTerminalModel !== undefined) {
        params.publish(
          row,
          presentSessionRowTranscriptFields(transcriptParams(row, row.entry), {
            lastMessagePreview: facts.transcriptPreview,
            lastAssistantMessage:
              facts.transcriptAssistantMessage === "unknown"
                ? (row.lastAssistantMessage ?? null)
                : facts.transcriptAssistantMessage,
            terminalModel: facts.transcriptTerminalModel,
          }),
        );
        if (facts.transcriptAssistantMessage !== "unknown") {
          revisions.set(id, next);
          queued.delete(id);
          return;
        }
      }
      if (!isDeepStrictEqual(revisions.get(id), next)) {
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
