import fs from "node:fs";
import path from "node:path";
import { setImmediate as checkpoint } from "node:timers/promises";
import { Worker, type WorkerOptions } from "node:worker_threads";
import { afterEach, expect, it, vi } from "vitest";
import { createDeferred, withTestTimeout } from "../../../test/helpers/promise.js";
import { createTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { assertNoOpenClawAgentDatabaseLeases } from "../../state/openclaw-agent-db-lease.js";
import {
  closeOpenClawAgentDatabaseByPath,
  openOpenClawAgentDatabase,
  resolveOpenClawAgentSqlitePath,
} from "../../state/openclaw-agent-db.js";
import {
  closeOpenClawStateDatabaseByPath,
  openOpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import { claimOpenClawStateOwnership } from "../../state/openclaw-state-ownership-operations.js";
import { withEnvAsync } from "../../test-utils/env.js";
import {
  appendTranscriptEvent,
  persistSessionTranscriptTurn,
  readSessionTranscriptMessageEvents,
  SessionTranscriptProjectionUnavailableError,
} from "./session-accessor.js";
import * as reconcile from "./session-transcript-reconcile.js";
import type { SessionTranscriptReconcileWorkerInput } from "./session-transcript-reconcile.worker.js";

const tempDirs = createTempDirTracker();

afterEach(() => {
  vi.restoreAllMocks();
  tempDirs.cleanup();
});

it.each([
  { trigger: "append", externallySupervised: false },
  { trigger: "append", externallySupervised: true },
  { trigger: "history read", externallySupervised: false },
])(
  "retains and drains the $trigger owner's database through native exit (external: $externallySupervised)",
  async ({ trigger, externallySupervised }) => {
    const root = tempDirs.make("openclaw-reconcile-owner-");
    const stateDir = path.join(root, "owner");
    const ambientStateDir = path.join(root, "ambient");
    fs.mkdirSync(ambientStateDir);
    const env = {
      OPENCLAW_STATE_DIR: stateDir,
      ...(externallySupervised ? { OPENCLAW_SUPERVISOR_MODE: "external" } : {}),
    };
    const databasePath =
      trigger === "append"
        ? path.join(root, "custom", "transcripts.sqlite")
        : resolveOpenClawAgentSqlitePath({ agentId: "main", env });
    const options = { agentId: "main", env, path: databasePath };
    const scope = {
      agentId: options.agentId,
      env,
      storePath: databasePath,
      sessionId: "original-owner",
      sessionKey: "agent:main:original-owner",
    };
    await withEnvAsync(
      { OPENCLAW_STATE_DIR: ambientStateDir, OPENCLAW_SUPERVISOR_MODE: undefined },
      async () => {
        const paused = createDeferred();
        const workers: Worker[] = [];
        const inputs: SessionTranscriptReconcileWorkerInput[] = [];
        let releaseAllowed = false;
        let releaseWorker: (() => void) | undefined;
        let drain: Promise<void> | undefined;
        const release = () => {
          releaseAllowed = true;
          releaseWorker?.();
        };
        const createWorker = (filename: string | URL, workerOptions: WorkerOptions) => {
          inputs.push(workerOptions.workerData as SessionTranscriptReconcileWorkerInput);
          const worker = new Worker(filename, workerOptions);
          workers.push(worker);
          const postMessage = worker.postMessage.bind(worker);
          worker.postMessage = (message: unknown, transferList) => {
            if (!releaseAllowed && (message as { type?: unknown }).type === "release") {
              // The real projection is ready, but its native worker still owns the lease.
              releaseWorker = () => postMessage(message, transferList);
              paused.resolve();
              return;
            }
            postMessage(message, transferList);
          };
          return worker;
        };
        try {
          if (externallySupervised) {
            claimOpenClawStateOwnership("fixture-supervisor", { env });
          }
          await persistSessionTranscriptTurn(scope, {
            messages: [
              { eventId: "seed", parentId: null, message: { role: "user", content: "seed" } },
              {
                eventId: "answer",
                parentId: "seed",
                message: { role: "assistant", content: "answer" },
              },
            ],
            touchSessionEntry: false,
          });
          await reconcile.waitForSessionTranscriptIndexReconcile(options);
          const database = openOpenClawAgentDatabase(options);
          const state = openOpenClawStateDatabase({ env });
          const readLeases = () =>
            state.db.prepare("SELECT lease_id FROM agent_database_leases ORDER BY lease_id").all();
          const baseline = readLeases();
          expect(baseline).toHaveLength(1);
          const ownerEnv = database.ownerEnv;
          env.OPENCLAW_STATE_DIR = ambientStateDir;
          delete env.OPENCLAW_SUPERVISOR_MODE;
          const cached = openOpenClawAgentDatabase(options);
          expect(cached).toBe(database);
          expect(cached.ownerEnv).toBe(ownerEnv);
          const start = reconcile.startSessionTranscriptIndexReconcile;
          vi.spyOn(reconcile, "startSessionTranscriptIndexReconcile").mockImplementation((params) =>
            start({ ...params, createWorker }),
          );

          if (trigger === "append") {
            await appendTranscriptEvent(scope, {
              type: "leaf",
              id: "selected-leaf",
              parentId: "answer",
              targetId: "seed",
            });
          } else {
            // Only the public history read schedules this dirty, otherwise idle projection.
            database.db
              .prepare(
                "UPDATE session_transcript_index_state SET needs_rebuild = 1 WHERE session_id = ?",
              )
              .run(scope.sessionId);
            expect(reconcile.isSessionTranscriptIndexReconcileRunning(options)).toBe(false);
            expect(() => readSessionTranscriptMessageEvents(scope)).toThrow(
              SessionTranscriptProjectionUnavailableError,
            );
          }
          let drained = false;
          drain = reconcile.waitForSessionTranscriptIndexReconcilesInStateDir(stateDir).then(() => {
            drained = true;
          });
          await withTestTimeout(
            paused.promise,
            10_000,
            `${trigger} worker did not reach lease release`,
          );
          expect(inputs).toEqual([
            expect.objectContaining({
              mode: "disk",
              path: databasePath,
              stateDir,
              externallySupervised,
            }),
          ]);
          expect(readLeases()).toHaveLength(baseline.length + 1);
          expect(fs.readdirSync(ambientStateDir)).toEqual([]);
          await reconcile.waitForSessionTranscriptProjection(scope);
          expect(readSessionTranscriptMessageEvents(scope).map(({ event }) => event)).toEqual(
            (trigger === "append" ? ["seed"] : ["seed", "answer"]).map((id) =>
              expect.objectContaining({ id }),
            ),
          );
          await checkpoint();
          expect(drained).toBe(false);
          expect(workers[0]?.threadId).not.toBe(-1);

          release();
          await drain;
          expect(workers.every((worker) => worker.threadId === -1)).toBe(true);
          expect(readLeases()).toEqual(baseline);
          expect(closeOpenClawAgentDatabaseByPath(database.path)).toBe(true);
          expect(() =>
            assertNoOpenClawAgentDatabaseLeases(options.agentId, { env: ownerEnv }),
          ).not.toThrow();
          expect(readLeases()).toEqual([]);
          expect(fs.readdirSync(ambientStateDir)).toEqual([]);
        } finally {
          release();
          await reconcile.waitForSessionTranscriptIndexReconcile(options);
          await drain;
          vi.restoreAllMocks();
          closeOpenClawAgentDatabaseByPath(databasePath);
          closeOpenClawStateDatabaseByPath(
            resolveOpenClawStateSqlitePath({ OPENCLAW_STATE_DIR: stateDir }),
          );
          closeOpenClawStateDatabaseByPath(
            resolveOpenClawStateSqlitePath({ OPENCLAW_STATE_DIR: ambientStateDir }),
          );
        }
      },
    );
  },
  20_000,
);
