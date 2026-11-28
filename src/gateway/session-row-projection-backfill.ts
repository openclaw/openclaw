import { AsyncLocalStorage } from "node:async_hooks";
import { isDeepStrictEqual } from "node:util";
import {
  getGatewayRestartDrainSignal,
  getGatewayShutdownCleanupSignal,
} from "../process/gateway-work-admission.js";
import { deriveGoalSessionTitle } from "./derive-goal-session-title.js";
import { yieldSessionListBackgroundWork } from "./session-projection-work.js";
import { identity, type EntryRow, type Row } from "./session-row-projection-record.js";
import {
  backfillSessionRowTranscriptFields,
  presentSessionRowTranscriptFields,
} from "./session-row-transcript-backfill.js";
import { readSessionTitleFieldsFromTranscriptAsync } from "./session-transcript-title-reader.js";

function transcriptParams(row: Row, entry: EntryRow["entry"]) {
  return {
    ...row.storeTarget,
    agentId: row.agentId,
    storeAgentId: row.storeTarget.agentId,
    sessionKey: row.key,
    sessionId: entry.sessionId,
    sessionEntry: entry,
    model: row.materialized?.source.selectedModel && {
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
    fields: NonNullable<Awaited<ReturnType<typeof backfillSessionRowTranscriptFields>>> & {
      fallbackTitle?: string | null;
    },
  ) => void;
}) {
  const inOwnerContext = AsyncLocalStorage.snapshot();
  const signal = AbortSignal.any([
    getGatewayRestartDrainSignal(),
    getGatewayShutdownCleanupSignal(),
  ]);
  const queued = new Set<string>();
  const revisions = new Map<string, ReturnType<typeof revision>>();
  let pending: Promise<void> | undefined;
  let started = false;
  let disposed = false;
  const closed = () => disposed || signal.aborted;
  function revision(row: EntryRow, watermark: Row["retainedDatabaseFacts"]) {
    const { entry, materialized } = row;
    return {
      generation: row.generation,
      watermark: watermark?.activitySummaryWatermark,
      needsFallbackTitle: entry.titleFallbackReady && !entry.displayName && !entry.label,
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
      if (closed() || !queued.size) {
        return;
      }
      await yieldSessionListBackgroundWork();
      if (closed()) {
        return;
      }
      await params.ready();
      if (closed()) {
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
        const scope = transcriptParams(row, entry);
        const fields = await backfillSessionRowTranscriptFields(scope);
        // Only a settled failure needs the first message. Keep this display fact in
        // the resident row, never in the session title or the worktree name.
        const fallbackTitle =
          captured.needsFallbackTitle && !row.fallbackTitle
            ? (deriveGoalSessionTitle(
                (await readSessionTitleFieldsFromTranscriptAsync(scope)).firstUserMessage,
              ) ?? null)
            : row.fallbackTitle;
        const live = params.read(id);
        // A replacement/private-session revocation must not publish another session's text.
        if (!closed() && live?.entry && params.current(row)) {
          const facts = live.retainedDatabaseFacts;
          // Superseded reads must not restore previews cleared by broad invalidation.
          if (revisions.get(id) !== captured) {
            continue;
          }
          if (fields && facts?.transcriptAssistantMessage === "unknown") {
            facts.transcriptAssistantMessage = fields.lastAssistantMessage ?? null;
          }
          if (fields && facts && facts.transcriptHasMessages === undefined) {
            facts.transcriptHasMessages = fields.hasMessages;
          }
          const observed =
            facts?.transcriptPreview !== undefined &&
            facts.transcriptHasMessages !== undefined &&
            facts.transcriptAssistantMessage !== "unknown" &&
            facts.transcriptTerminalModel !== undefined
              ? presentSessionRowTranscriptFields(transcriptParams(live, live.entry), {
                  hasMessages: facts.transcriptHasMessages,
                  lastMessagePreview: facts.transcriptPreview,
                  lastAssistantMessage: facts.transcriptAssistantMessage,
                  terminalModel: facts.transcriptTerminalModel,
                })
              : (fields ?? {});
          params.publish(live, { ...observed, fallbackTitle });
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
    if (!closed() && !pending && queued.size) {
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
      if (closed()) {
        return;
      }
      const id = identity(row);
      const next = revision(row, facts);
      if (facts?.transcriptPreview !== undefined && facts.transcriptTerminalModel !== undefined) {
        params.publish(
          row,
          presentSessionRowTranscriptFields(transcriptParams(row, row.entry), {
            hasMessages: facts.transcriptHasMessages,
            lastMessagePreview: facts.transcriptPreview,
            lastAssistantMessage:
              facts.transcriptAssistantMessage === "unknown"
                ? (row.lastAssistantMessage ?? null)
                : facts.transcriptAssistantMessage,
            terminalModel: facts.transcriptTerminalModel,
          }),
        );
        if (
          facts.transcriptAssistantMessage !== "unknown" &&
          facts.transcriptHasMessages !== undefined &&
          (!next.needsFallbackTitle ||
            row.fallbackTitle ||
            (row.fallbackTitle === null && isDeepStrictEqual(revisions.get(id), next)))
        ) {
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
