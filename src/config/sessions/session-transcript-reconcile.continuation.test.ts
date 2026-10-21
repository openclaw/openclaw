import type { WorkerOptions } from "node:worker_threads";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, expect, it, vi } from "vitest";
import { runInDetachedAsyncContext } from "../../shared/detached-async-context.js";
import {
  closeOpenClawAgentDatabasesAsync,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../io.js";
import { resolveSessionStorePathCore } from "./paths.js";
import { closeSessionTranscriptReconcileWorkerPool } from "./session-transcript-reconcile-pool.js";
import * as fixtures from "./session-transcript-reconcile.fixtures.test-support.js";
import {
  reconcileSessionTranscriptIndexes,
  startSessionTranscriptIndexReconcile,
  waitForSessionTranscriptIndexReconcile,
} from "./session-transcript-reconcile.js";

vi.mock("node:worker_threads", async () => {
  const observed = await (
    await import("./session-transcript-reconcile.test-support.js")
  ).createObservedWorkerThreads();
  return {
    ...observed,
    Worker: class extends observed.Worker {
      constructor(filename: string | URL, options: WorkerOptions = {}) {
        if (!String(filename).includes("sqlite-store.worker")) {
          super(filename, options);
          return;
        }
        // Inject the native failure on its writer connection without changing the main schema.
        super(
          `const { DatabaseSync } = require('node:sqlite');
          const prepare = DatabaseSync.prototype.prepare;
          DatabaseSync.prototype.prepare = function(sql) {
            const statement = prepare.call(this, sql);
            if (sql.startsWith('delete from "session_transcript_fts_rows"')) {
              const run = statement.run.bind(statement), database = this;
              statement.run = (...args) => {
                database.exec("CREATE TEMP TRIGGER IF NOT EXISTS refuse_orphan_cleanup BEFORE DELETE ON main.session_transcript_fts_rows WHEN OLD.session_id = 'orphan-sweep-failure' BEGIN SELECT RAISE(ABORT, 'fixture sweep deletion refused'); END;");
                return run(...args);
              };
            }
            return statement;
          };
          void import(${JSON.stringify(String(filename))});`,
          { ...options, eval: true },
        );
      }
    },
  };
});
const { observer, tempDirs } = fixtures.useReconcileTestRuntime();

afterEach(async () => {
  observer.onTask = undefined;
  await closeSessionTranscriptReconcileWorkerPool();
  await fixtures.closeReconcileDatabases();
  clearRuntimeConfigSnapshot();
});

it.each([
  "continues",
  "redirtied",
  "retires",
  "retires-between-batches",
  "closes-pool",
  "fails-before-cancellation",
] as const)(
  "preserves committed reconciliation when newly pending work %s",
  async (continuation) => {
    const retires = continuation === "retires" || continuation === "retires-between-batches";
    const closesPool = continuation === "closes-pool";
    const failsBeforeCancellation = continuation === "fails-before-cancellation";
    const continuedSession = continuation === "redirtied" ? "first" : "second";
    const stateDir = tempDirs.make("transcript-reconcile-continuation-");
    const options = { agentId: "main", env: { ...process.env, OPENCLAW_STATE_DIR: stateDir } };
    setRuntimeConfigSnapshot({
      session: { store: resolveSessionStorePathCore(undefined, options) },
    });
    for (const sessionId of ["first", "second"]) {
      await fixtures.seedTranscript(
        { ...options, sessionId, sessionKey: `agent:main:${sessionId}` },
        `${sessionId}-message`,
        `${sessionId} continuation transcript`,
      );
    }
    await waitForSessionTranscriptIndexReconcile(options);
    const database = openOpenClawAgentDatabase(options);
    const dirty = (sessionId: string) => fixtures.markRebuild(database.db, sessionId);
    dirty("first");
    const worklists: string[][] = [];
    observer.onTask = ({ input }) => {
      if (input.mode !== "disk") {
        return;
      }
      worklists.push([...input.sessionIds]);
      if (worklists.length === 1) {
        expect(input.sessionIds).toEqual(["first"]);
        if (continuation !== "redirtied" && !failsBeforeCancellation) {
          // The real worker has not received its captured plan; this connection is a foreign writer.
          dirty("second");
          database.db
            .prepare("DELETE FROM session_transcript_fts_rows WHERE session_id = ?")
            .run("second");
        }
        if (continuation === "retires-between-batches") {
          fixtures.seedScanBacklog(database.db, "agent:main:first");
        }
      }
    };
    let closing: Promise<void> | undefined;
    let sweepDispatches = 0;
    let sweepResults = 0;
    let dirtiedAgain = false;
    let orphanInserted = false;
    let sweepFailure: unknown;
    const controller = new AbortController();
    const operationSpy =
      continuation !== "continues"
        ? fixtures.interceptWorkerExecution((execute) => async (command, commandOptions) => {
            const publication =
              command.type === "database.domain.publish" &&
              isRecord(command.input) &&
              isRecord(command.input.command)
                ? command.input.command
                : undefined;
            const sweep = publication?.type === "sweep";
            if (sweep) {
              sweepDispatches++;
              if (continuation === "retires-between-batches" && sweepDispatches === 2) {
                closing = runInDetachedAsyncContext(() =>
                  closeOpenClawAgentDatabasesAsync(stateDir),
                );
              }
            }
            const result = await execute(command, commandOptions).catch((error: unknown) => {
              if (failsBeforeCancellation && sweep) {
                sweepFailure = error;
                controller.abort(new Error("caller cancelled after native sweep failure"));
              }
              throw error;
            });
            if (
              publication?.type === "finalize" &&
              isRecord(publication.input) &&
              isRecord(publication.input.plan) &&
              publication.input.plan.sessionId === "first" &&
              isRecord(result) &&
              result.finalized === true
            ) {
              if (continuation === "redirtied" && !dirtiedAgain) {
                dirtiedAgain = true;
                dirty("first");
                database.db
                  .prepare("DELETE FROM session_transcript_fts_rows WHERE session_id = ?")
                  .run("first");
              } else if (failsBeforeCancellation && !orphanInserted) {
                orphanInserted = true;
                database.db
                  .prepare("INSERT INTO session_transcript_fts_rows (session_id) VALUES (?)")
                  .run("orphan-sweep-failure");
              }
            }
            if (sweep) {
              sweepResults++;
              if (continuation === "retires-between-batches") {
                expect(result).toMatchObject({
                  hasMore: true,
                  traversalComplete: false,
                });
              } else if (continuation === "retires" || (closesPool && !closing)) {
                expect(result).toMatchObject({
                  sessionIds: ["second"],
                  hasMore: false,
                });
                // Closing joins this operation, so await it only after reconciliation settles.
                closing = runInDetachedAsyncContext(
                  closesPool
                    ? closeSessionTranscriptReconcileWorkerPool
                    : () => closeOpenClawAgentDatabasesAsync(stateDir),
                );
              }
            }
            return result;
          })
        : undefined;
    try {
      if (closesPool) {
        startSessionTranscriptIndexReconcile(options);
      }
      const reconciliation = closesPool
        ? waitForSessionTranscriptIndexReconcile(options)
        : reconcileSessionTranscriptIndexes({
            ...options,
            ...(failsBeforeCancellation ? { signal: controller.signal } : {}),
          });
      if (failsBeforeCancellation) {
        await expect(reconciliation).rejects.toThrow("fixture sweep deletion refused");
        expect(sweepFailure).toMatchObject({
          message: expect.stringContaining("fixture sweep deletion refused"),
        });
        expect(orphanInserted).toBe(true);
        expect(sweepDispatches).toBe(1);
        expect(sweepResults).toBe(0);
        fixtures.expectRows(
          database.db,
          "SELECT session_id FROM session_transcript_fts_rows WHERE session_id = ?",
          [{ session_id: "orphan-sweep-failure" }],
          "orphan-sweep-failure",
        );
      } else if (closesPool) {
        await expect(reconciliation).resolves.toBeUndefined();
      } else {
        await fixtures.expectReconciled(reconciliation);
      }
      if (retires || closesPool) {
        expect(closing).toBeDefined();
        await closing;
        if (retires) {
          expect(sweepDispatches).toBe(continuation === "retires-between-batches" ? 2 : 1);
          expect(sweepResults).toBe(1);
        }
      } else if (!failsBeforeCancellation) {
        await waitForSessionTranscriptIndexReconcile(options);
      }
      expect(worklists).toEqual(
        retires || failsBeforeCancellation ? [["first"]] : [["first"], [continuedSession]],
      );
      if (continuation === "redirtied") {
        expect(dirtiedAgain).toBe(true);
      }
      const verified = openOpenClawAgentDatabase(options);
      fixtures.expectRows(
        verified.db,
        "SELECT session_id, needs_rebuild FROM session_transcript_index_state ORDER BY session_id",
        [
          { session_id: "first", needs_rebuild: 0 },
          { session_id: "second", needs_rebuild: retires ? 1 : 0 },
        ],
      );
      fixtures.expectRows(
        verified.db,
        "SELECT session_id, message_id FROM session_transcript_fts WHERE session_transcript_fts MATCH ?",
        retires
          ? []
          : [{ session_id: continuedSession, message_id: `${continuedSession}-message` }],
        continuedSession,
      );
    } finally {
      await Promise.allSettled([closing]);
      operationSpy?.mockRestore();
    }
  },
);
