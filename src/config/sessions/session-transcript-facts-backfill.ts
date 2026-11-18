import { addAbortListener } from "node:events";
import path from "node:path";
import { runtimeProcessEntrypoints } from "../../infra/runtime-process-entrypoints.js";
import { resolveRuntimeWorkerUrl } from "../../infra/runtime-worker-url.js";
import type { OpenClawAgentDatabaseOptions } from "../../state/openclaw-agent-db-contract.js";
import {
  openOpenClawAgentSqliteWorkerStoreV2,
  type OpenClawAgentSqliteWorkerStoreV2,
} from "../../state/openclaw-agent-worker-store.js";
import type { PreparedSessionColdNavigation } from "./session-cold-navigation-preparation.js";
import type { SessionStoreReadCustody } from "./session-store-read-candidates.js";
import type {
  TranscriptActiveFactsBackfillBatch,
  TranscriptActiveFactsBackfillOperations,
  TranscriptActiveFactsBackfillSession,
} from "./session-transcript-active-facts-backfill.worker.js";
import { coldNavigationLane, sessionStoreLane } from "./session-transcript-worker-resources.js";
import { withSessionHistoryWorkerDatabase } from "./session-transcript-worker-runtime.js";

// Admitted execution includes reply pickup, so startup or main-thread contention can
// inflate one charge to seconds; 20x of that would park the pass for minutes.
const MAX_YIELD_MS = 30_000;

function yieldAfter(executionMs: number, minimumMs = 250): number {
  return Math.min(MAX_YIELD_MS, Math.max(minimumMs, 20 * executionMs));
}

// Covered-window probes take no writer reservation, so a restart can skip finished
// sessions quickly; reply-pickup charges still stretch this under main-thread load.
const PROBE_MIN_YIELD_MS = 25;

export type SessionTranscriptFactsBackfill = {
  runBatch(): Promise<{ complete: boolean; delayMs: number }>;
  close(): Promise<void>;
};

/** The scheduler owns cadence; background writer admission yields to the foreground FIFO. */
export function createSessionTranscriptFactsBackfill(params: {
  database: OpenClawAgentDatabaseOptions;
  assertCurrent: () => void;
  readCustody?: readonly SessionStoreReadCustody[];
  signal: AbortSignal;
  log: { info: (message: string) => void; warn: (message: string) => void };
}): SessionTranscriptFactsBackfill {
  let sessions: TranscriptActiveFactsBackfillSession[] | undefined;
  let sessionIndex = 0;
  let afterPosition = -1;
  // Probe at each session start and after an all-covered write batch.
  let probeNext = true;
  let sessionsSkipped = 0;
  let rowsFilled = 0;
  let rowsSkipped = 0;
  let bytesRead = 0;
  let pauses = 0;
  let lastReport = 0;
  let contentionDelayMs = 250;
  let writeExecutionMs = 0;
  // Per-report maxima and totals let operators line batches up with foreground write holds.
  let intervalBatches = 0;
  let intervalBatchMs = 0;
  let intervalWriteMs = 0;
  let intervalMaxWriteMs = 0;
  let intervalPreparationMs = 0;
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
  const report = (complete: boolean) => {
    const now = Date.now();
    if (!sessions || (!complete && now - lastReport < 60_000)) {
      return;
    }
    const current = sessions[sessionIndex];
    params.log.info(
      `session: transcript facts backfill ${complete ? "pass complete" : "progress"}: ` +
        `${rowsFilled} rows filled, ${rowsSkipped} rows skipped, ` +
        `${sessionIndex}/${sessions.length} sessions completed ` +
        `(${sessionsSkipped} already covered)` +
        (current
          ? current.coldNavigation
            ? " (current: cold navigation)"
            : ` (current at position ${afterPosition} of ${current.activeEventCount} active events)`
          : "") +
        `, ${bytesRead} payload bytes, ${pauses} lock-contention pauses; ` +
        `since last report: ${intervalBatches} batches, ` +
        `${intervalBatchMs.toFixed(1)} ms maximum batch, ` +
        `${intervalMaxWriteMs.toFixed(1)} ms maximum and ` +
        `${intervalWriteMs.toFixed(0)} ms total admitted execution, ` +
        `${intervalPreparationMs.toFixed(0)} ms cold preparation outside the writer`,
    );
    lastReport = now;
    intervalBatches = 0;
    intervalBatchMs = 0;
    intervalWriteMs = 0;
    intervalMaxWriteMs = 0;
    intervalPreparationMs = 0;
  };
  const runBatch = async () => {
    if (closed) {
      return { complete: true, delayMs: 250 };
    }
    try {
      assertCurrent();
      if (!sessions) {
        const started = performance.now();
        const discovery = await withSessionHistoryWorkerDatabase(
          { ...params.database, readCustody: params.readCustody },
          (reader) =>
            reader.discoverTranscriptFacts(
              { env: params.database.env ?? process.env },
              params.signal,
            ),
          sessionStoreLane,
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
          `session: transcript facts backfill discovered ${sessions.length} transcript(s), including ${sessions.filter((session) => session.coldNavigation).length} pending cold archive(s)`,
        );
        if (sessions.length === 0) {
          await close();
        }
        return {
          complete: sessions.length === 0,
          delayMs: yieldAfter(performance.now() - started),
        };
      }
      const session = sessions[sessionIndex];
      if (!session) {
        await close();
        return { complete: true, delayMs: 250 };
      }
      if (probeNext && !session.coldNavigation) {
        const started = performance.now();
        const probe = await withSessionHistoryWorkerDatabase(
          { ...params.database, readCustody: params.readCustody },
          (reader) =>
            reader.probeTranscriptFacts(
              {
                env: params.database.env ?? process.env,
                cursor: { sessionId: session.sessionId, afterPosition },
              },
              params.signal,
            ),
          sessionStoreLane,
        );
        afterPosition = probe.afterPosition;
        if (!probe.uncovered) {
          if (probe.done) {
            sessionIndex++;
            sessionsSkipped++;
            afterPosition = -1;
          }
          const complete = sessionIndex === sessions.length;
          if (complete) {
            report(true);
            sessions = [];
            await close();
          } else {
            report(false);
          }
          return {
            complete,
            delayMs: yieldAfter(performance.now() - started, PROBE_MIN_YIELD_MS),
          };
        }
        probeNext = false;
      }
      const publish = async (preparedColdNavigation?: PreparedSessionColdNavigation) => {
        client ??= openOpenClawAgentSqliteWorkerStoreV2<TranscriptActiveFactsBackfillOperations>(
          params.database,
          { version: 2, assertCurrent },
          {
            moduleUrl: resolveRuntimeWorkerUrl(
              runtimeProcessEntrypoints.sessionTranscriptActiveFactsBackfill,
            ),
            input: undefined,
            readCustody: params.readCustody,
            priority: "background",
            observeWriteExecution: (elapsedMs) => {
              writeExecutionMs = elapsedMs;
              intervalWriteMs += elapsedMs;
              intervalMaxWriteMs = Math.max(intervalMaxWriteMs, elapsedMs);
            },
          },
        );
        const store = await client;
        return store.execute(
          {
            type: "batch",
            input: {
              sessionId: session.sessionId,
              afterPosition,
              ...(session.coldNavigation ? { coldNavigation: true } : {}),
              ...(preparedColdNavigation ? { preparedColdNavigation } : {}),
            },
          },
          assertCurrent,
          { signal: params.signal },
        );
      };
      let batch: TranscriptActiveFactsBackfillBatch;
      let preparationMs = 0;
      writeExecutionMs = 0;
      if (session.coldNavigation) {
        const [
          { createSqliteSnapshotStagingDirectory },
          { resolvePrivateSqliteSnapshotStagingRoot },
          { retainSnapshotWork, removeTempDirectoryAsync },
          { prepareSqliteDatabaseAdmissionAsync },
        ] = await Promise.all([
          import("../../infra/sqlite-snapshot-staging.js"),
          import("../../infra/sqlite-private-directory.js"),
          import("../../infra/sqlite-readonly-location-cleanup.js"),
          import("../../infra/sqlite-database-admission.js"),
        ]);
        const started = performance.now();
        const directory = await createSqliteSnapshotStagingDirectory(
          resolvePrivateSqliteSnapshotStagingRoot(params.database.env),
          false,
          params.signal,
          true,
        );
        try {
          batch = await retainSnapshotWork(
            (async () => {
              await prepareSqliteDatabaseAdmissionAsync({
                location: path.join(directory, "database.sqlite"),
                assertCurrent,
                create: {
                  authorize: assertCurrent,
                  retain: (work) => {
                    void retainSnapshotWork(work);
                  },
                },
              });
              const prepared = await withSessionHistoryWorkerDatabase(
                { ...params.database, readCustody: params.readCustody },
                (reader) =>
                  reader.prepareColdNavigation(
                    {
                      env: params.database.env ?? process.env,
                      sessionId: session.sessionId,
                      directory,
                    },
                    params.signal,
                  ),
                coldNavigationLane,
              );
              preparationMs = performance.now() - started;
              intervalPreparationMs += preparationMs;
              assertCurrent();
              if (prepared.kind === "unavailable") {
                return {
                  afterPosition: -1,
                  done: true,
                  unavailable: true,
                  busy: false,
                  rowsFilled: 0,
                  rowsSkipped: 0,
                  rowsVisited: 0,
                  bytesRead: 0,
                  elapsedMs: 0,
                  warning: prepared.warning,
                };
              }
              return publish(prepared);
            })(),
          );
        } finally {
          if (!(await removeTempDirectoryAsync(directory))) {
            params.log.warn("Cold navigation preparation cleanup remains pending");
          }
        }
      } else {
        batch = await publish();
      }
      if (batch.warning) {
        params.log.warn(
          `Cold navigation for ${session.sessionId} remains pending: ${batch.warning}`,
        );
      }
      contentionDelayMs = batch.busy ? Math.min(5_000, contentionDelayMs * 2) : 250;
      // Pace total work, including off-writer preparation; report writer occupancy separately.
      const delayMs = Math.max(
        yieldAfter(preparationMs + Math.max(batch.elapsedMs, writeExecutionMs)),
        contentionDelayMs,
      );
      afterPosition = batch.afterPosition;
      rowsFilled += batch.rowsFilled;
      rowsSkipped += batch.rowsSkipped;
      bytesRead += batch.bytesRead;
      intervalBatches++;
      intervalBatchMs = Math.max(intervalBatchMs, batch.elapsedMs);
      pauses += Number(batch.busy);
      if (batch.done || batch.unavailable) {
        sessionIndex++;
        afterPosition = -1;
        probeNext = true;
      } else if (!batch.busy && batch.rowsFilled + batch.rowsSkipped === 0) {
        // A fully covered write window: hand the rest of the stretch back to the probe.
        probeNext = true;
      }
      const complete = sessionIndex === sessions.length;
      report(complete);
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
