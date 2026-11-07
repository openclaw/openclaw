import { runtimeProcessEntrypoints } from "../../infra/runtime-process-entrypoints.js";
import { resolveRuntimeWorkerUrl } from "../../infra/runtime-worker-url.js";
import type { OpenClawAgentDatabaseOptions } from "../../state/openclaw-agent-db-contract.js";
import { openOpenClawAgentSqliteWorkerStoreV2 } from "../../state/openclaw-agent-worker-store.js";
import type {
  TranscriptActiveFactsBackfillOperations,
  TranscriptActiveFactsBackfillSession,
} from "./session-transcript-active-facts-backfill.worker.js";

/** The existing post-ready scheduler owns cadence, foreground yielding, and cancellation. */
export function createSessionTranscriptFactsBackfill(params: {
  database: OpenClawAgentDatabaseOptions;
  assertCurrent: () => void;
  log: { info: (message: string) => void };
}): (signal: AbortSignal) => Promise<boolean> {
  let sessions: TranscriptActiveFactsBackfillSession[] | undefined;
  let sessionIndex = 0;
  let afterPosition = -1;
  let rowsFilled = 0;
  let rowsSkipped = 0;
  let bytesRead = 0;
  let batchMs = 0;
  let pauses = 0;
  let lastReport = 0;
  return async (signal) => {
    const assertCurrent = () => {
      signal.throwIfAborted();
      params.assertCurrent();
    };
    assertCurrent();
    const client =
      await openOpenClawAgentSqliteWorkerStoreV2<TranscriptActiveFactsBackfillOperations>(
        params.database,
        { version: 2, assertCurrent },
        {
          moduleUrl: resolveRuntimeWorkerUrl(
            runtimeProcessEntrypoints.sessionTranscriptActiveFactsBackfill,
          ),
          input: undefined,
          priority: "background",
        },
      );
    try {
      if (!sessions) {
        const discovery = await client.execute(
          { type: "discover", input: undefined },
          assertCurrent,
          { signal },
        );
        if (!discovery.supported) {
          params.log.info(
            "session: transcript facts backfill skipped: background backfill supports SQLite only",
          );
          return true;
        }
        sessions = discovery.sessions;
        params.log.info(
          `session: transcript facts backfill discovered ${sessions.length} active session(s)`,
        );
        return sessions.length === 0;
      }
      const session = sessions[sessionIndex];
      if (!session) {
        return true;
      }
      const batch = await client.execute(
        { type: "batch", input: { sessionId: session.sessionId, afterPosition } },
        assertCurrent,
        { signal },
      );
      afterPosition = batch.afterPosition;
      rowsFilled += batch.rowsFilled;
      rowsSkipped += batch.rowsSkipped;
      bytesRead += batch.bytesRead;
      batchMs = Math.max(batchMs, batch.elapsedMs);
      pauses += Number(batch.busy);
      if (batch.done || batch.unavailable) {
        sessionIndex++;
        afterPosition = -1;
      }
      const complete = sessionIndex === sessions.length;
      const now = Date.now();
      if (complete || now - lastReport >= 60_000) {
        params.log.info(
          `session: transcript facts backfill ${complete ? "pass complete" : "progress"}: ` +
            `${rowsFilled} rows filled, ${rowsSkipped} rows skipped, ` +
            `${sessionIndex}/${sessions.length} sessions visited, ${bytesRead} payload bytes, ` +
            `${batchMs.toFixed(1)} ms maximum batch, ${pauses} lock-contention pauses`,
        );
        lastReport = now;
      }
      if (complete) {
        sessions = [];
      }
      return complete;
    } finally {
      await client.close();
    }
  };
}
