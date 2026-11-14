import { addAbortListener } from "node:events";
import { runtimeProcessEntrypoints } from "../../infra/runtime-process-entrypoints.js";
import { resolveRuntimeWorkerUrl } from "../../infra/runtime-worker-url.js";
import type { OpenClawAgentDatabaseOptions } from "../../state/openclaw-agent-db-contract.js";
import {
  openOpenClawAgentSqliteWorkerStoreV2,
  type OpenClawAgentSqliteWorkerStoreV2,
} from "../../state/openclaw-agent-worker-store.js";
import type {
  TranscriptActiveFactsBackfillOperations,
  TranscriptActiveFactsBackfillSession,
} from "./session-transcript-active-facts-backfill.worker.js";

export type SessionTranscriptFactsBackfill = {
  runBatch(): Promise<{ complete: boolean; delayMs: number }>;
  close(): Promise<void>;
};

/** The scheduler owns cadence; background writer admission yields to the foreground FIFO. */
export function createSessionTranscriptFactsBackfill(params: {
  database: OpenClawAgentDatabaseOptions;
  assertCurrent: () => void;
  signal: AbortSignal;
  log: { info: (message: string) => void; warn: (message: string) => void };
}): SessionTranscriptFactsBackfill {
  let sessions: TranscriptActiveFactsBackfillSession[] | undefined;
  let sessionIndex = 0;
  let afterPosition = -1;
  let rowsFilled = 0;
  let rowsSkipped = 0;
  let bytesRead = 0;
  let batchMs = 0;
  let pauses = 0;
  let lastReport = 0;
  let contentionDelayMs = 250;
  let writeExecutionMs = 0;
  let maxWriteExecutionMs = 0;
  let closed = false;
  let client:
    | Promise<OpenClawAgentSqliteWorkerStoreV2<TranscriptActiveFactsBackfillOperations>>
    | undefined;
  const assertCurrent = () => {
    params.signal.throwIfAborted();
    params.assertCurrent();
  };
  const close = async () => {
    closed = true;
    abortListener[Symbol.dispose]();
    await (await client)?.close();
  };
  const abortListener = addAbortListener(params.signal, () => {
    // Database lifecycle ownership also joins this idempotent close during shutdown.
    void close().catch((error: unknown) =>
      params.log.warn(`Transcript facts backfill cleanup failed: ${String(error)}`),
    );
  });
  const runBatch = async () => {
    if (closed) {
      return { complete: true, delayMs: 250 };
    }
    try {
      assertCurrent();
      client ??= openOpenClawAgentSqliteWorkerStoreV2<TranscriptActiveFactsBackfillOperations>(
        params.database,
        { version: 2, assertCurrent },
        {
          moduleUrl: resolveRuntimeWorkerUrl(
            runtimeProcessEntrypoints.sessionTranscriptActiveFactsBackfill,
          ),
          input: undefined,
          priority: "background",
          observeWriteExecution: (elapsedMs) => {
            writeExecutionMs = elapsedMs;
            maxWriteExecutionMs = Math.max(maxWriteExecutionMs, elapsedMs);
          },
        },
      );
      const store = await client;
      if (!sessions) {
        const discovery = await store.execute(
          { type: "discover", input: undefined },
          assertCurrent,
          { signal: params.signal },
        );
        if (!discovery.supported) {
          params.log.info(
            "session: transcript facts backfill skipped: background backfill supports SQLite only",
          );
          await close();
          return { complete: true, delayMs: 250 };
        }
        sessions = discovery.sessions;
        params.log.info(
          `session: transcript facts backfill discovered ${sessions.length} active session(s)`,
        );
        if (sessions.length === 0) {
          await close();
        }
        return {
          complete: sessions.length === 0,
          delayMs: Math.max(250, 20 * writeExecutionMs),
        };
      }
      const session = sessions[sessionIndex];
      if (!session) {
        await close();
        return { complete: true, delayMs: 250 };
      }
      const batch = await store.execute(
        { type: "batch", input: { sessionId: session.sessionId, afterPosition } },
        assertCurrent,
        { signal: params.signal },
      );
      contentionDelayMs = batch.busy ? Math.min(5_000, contentionDelayMs * 2) : 250;
      // Charge preparation and reply delivery while holding the writer, not foreground FIFO wait.
      const delayMs = Math.max(
        250,
        20 * Math.max(batch.elapsedMs, writeExecutionMs),
        contentionDelayMs,
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
            `${batchMs.toFixed(1)} ms maximum batch, ${pauses} lock-contention pauses, ` +
            `${maxWriteExecutionMs.toFixed(1)} ms maximum admitted execution`,
        );
        lastReport = now;
      }
      if (complete) {
        sessions = [];
        await close();
      }
      return { complete, delayMs };
    } catch (error) {
      await close();
      throw error;
    }
  };
  return { runBatch, close };
}
