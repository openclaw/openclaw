import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs";
import path from "node:path";
import type { Worker } from "node:worker_threads";
import { afterEach, expect, test, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  closeOpenClawAgentDatabaseByPath,
  closeOpenClawAgentDatabasesForTest,
  getOpenClawAgentDatabaseIfOpen,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { measureSessionPhysicalDiskUsage } from "./disk-budget.js";
import { replaceSessionEntry } from "./session-accessor.js";
import * as archiveWorker from "./session-accessor.sqlite-archive.js";
import type { SqliteSessionReclamationDiagnostics } from "./session-accessor.sqlite-contract.js";
import { loadSessionEntryReadOnly } from "./session-accessor.sqlite-entry.js";
import { ensureSessionEntrySync } from "./session-accessor.sqlite-initial-entry.js";
import { SqliteReclamationWorker } from "./session-accessor.sqlite-reclamation-worker.js";
import * as reclamation from "./session-accessor.sqlite-reclamation.js";
import {
  createLifecycleArtifactReclamationPlan,
  runSqliteSessionReclamation,
} from "./session-accessor.sqlite-reclamation.js";
import { reclaimSqliteFreePages } from "./session-history-archive-pruning.js";
import { enforceSqliteSessionHistoryDiskBudget } from "./session-history-eviction.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => {
  vi.restoreAllMocks();
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
});

function createFixture() {
  const env = { OPENCLAW_STATE_DIR: fs.realpathSync(tempDirs.make("reclamation-reuse-")) };
  const options = { agentId: "main", env };
  const scopes = ["first", "second"].map((sessionId) => ({
    agentId: options.agentId,
    env,
    sessionId,
    sessionKey: `agent:main:${sessionId}`,
  }));
  for (const scope of scopes) {
    ensureSessionEntrySync(scope, { sessionId: scope.sessionId, updatedAt: 1 });
  }
  const database = openOpenClawAgentDatabase(options);
  const plans = scopes.map((scope) =>
    createLifecycleArtifactReclamationPlan({
      agentId: "main",
      databaseOptions: { ...options, path: database.path },
      entries: [{ sessionKey: scope.sessionKey, expectedEntry: loadSessionEntryReadOnly(scope) }],
      materializedPlans: [],
    }),
  );
  return { options, scopes, database, plans };
}

test.each([false, true])(
  "reuses one validated Worker with a fresh request context and claim (cold parent: %s)",
  async (cold) => {
    const { options, database, plans, scopes } = createFixture();
    await using worker = new SqliteReclamationWorker();
    const spawned: Worker[] = [];
    const observe = (child: Worker) => spawned.push(child);
    const context = new AsyncLocalStorage<number>();
    const diagnostics: SqliteSessionReclamationDiagnostics[] = [{}, {}];
    process.on("worker", observe);
    try {
      for (const [index, plan] of plans.entries()) {
        if (cold && index === 1) {
          expect(closeOpenClawAgentDatabaseByPath(database.path)).toBe(true);
        }
        let checks = 0;
        await expect(
          context.run(index, () =>
            runSqliteSessionReclamation({
              forceInProcess: false,
              worker,
              plan,
              diagnostics: diagnostics[index],
              assertCommitAllowed: () => {
                checks += 1;
                expect(context.getStore()).toBe(index);
              },
            }),
          ),
        ).resolves.toMatchObject({ kind: "lifecycle-artifacts", value: { removedEntries: 1 } });
        expect(checks).toBeGreaterThan(1);
        expect(loadSessionEntryReadOnly(scopes[index]!)).toBeUndefined();
      }
      expect(spawned).toHaveLength(1);
      expect(diagnostics[0]?.workerThreadId).toBeGreaterThan(0);
      expect(diagnostics[1]?.workerThreadId).toBe(diagnostics[0]?.workerThreadId);
      if (cold) {
        expect(getOpenClawAgentDatabaseIfOpen(options)).toBeUndefined();
      }
      await worker.close();
      expect(spawned[0]?.threadId).toBe(-1);
      const leases = openOpenClawStateDatabase({ env: options.env })
        .db.prepare("SELECT lease_id FROM agent_database_leases WHERE path = ?")
        .all(database.path);
      expect(leases).toHaveLength(cold ? 0 : 1);
    } finally {
      process.off("worker", observe);
    }
  },
);

test.each(["admission", "commit"] as const)(
  "rejects a revoked retained claim on the reused Worker's next %s",
  async (checkpoint) => {
    const { database, plans, scopes } = createFixture();
    await using worker = new SqliteReclamationWorker();
    await runSqliteSessionReclamation({ forceInProcess: false, worker, plan: plans[0]! });
    const run = worker.run.bind(worker);
    let revoked = false;
    vi.spyOn(worker, "run").mockImplementation((params) =>
      run({
        ...params,
        ...(checkpoint === "commit"
          ? {
              onCommitRequest: () => {
                revoked = closeOpenClawAgentDatabaseByPath(database.path);
                return params.onCommitRequest();
              },
            }
          : {
              withWriteAdmission: async (...args) => {
                revoked = closeOpenClawAgentDatabaseByPath(database.path);
                return params.withWriteAdmission(...args);
              },
            }),
      }),
    );
    await expect(
      runSqliteSessionReclamation({ forceInProcess: false, worker, plan: plans[1]! }),
    ).rejects.toThrow("claim is no longer current");
    expect(revoked).toBe(true);
    expect(loadSessionEntryReadOnly(scopes[0]!)).toBeUndefined();
    expect(loadSessionEntryReadOnly(scopes[1]!)).toMatchObject({ sessionId: "second" });
  },
);

test.each([false, true])(
  "joins the sweep's one Worker across history and cap-entry victims (failure: %s)",
  async (failure) => {
    await withOpenClawTestState(
      { prefix: "reclamation-sweep-", layout: "state-only" },
      async (state) => {
        const sessionKey = "agent:main:explicit:sweep-lifetime";
        const storePath = path.join(state.sessionsDir(), "sessions.json");
        const databaseOptions = { agentId: "main", env: state.env };
        for (const [index, sessionId] of ["first", "second", "current"].entries()) {
          await replaceSessionEntry(
            { sessionKey, storePath },
            {
              sessionId,
              updatedAt: index + 1,
              ...(sessionId === "current"
                ? { archivedAt: 4, archiveReason: "active-session-cap" as const }
                : {}),
            },
          );
        }
        await reclaimSqliteFreePages(databaseOptions);
        const workers: Worker[] = [];
        const spawn = archiveWorker.createSqliteTranscriptArchiveWorker;
        vi.spyOn(archiveWorker, "createSqliteTranscriptArchiveWorker").mockImplementation(
          (data) => {
            const worker = spawn(data);
            workers.push(worker);
            return worker;
          },
        );
        const run = reclamation.runSqliteSessionReclamation;
        let requests = 0;
        vi.spyOn(reclamation, "runSqliteSessionReclamation").mockImplementation(async (params) => {
          if (++requests === 2 && failure) {
            throw new Error("next victim preparation failed");
          }
          return run(params);
        });
        const sweep = enforceSqliteSessionHistoryDiskBudget({
          storePath,
          mode: "enforce",
          maintenance: { maxDiskBytes: 1, highWaterBytes: 1 },
        });
        if (failure) {
          await expect(sweep).rejects.toThrow("next victim preparation failed");
        } else {
          const result = await sweep;
          expect(result?.removedEntries).toBe(3);
          expect(result?.totalBytesAfter).toBe(
            (await measureSessionPhysicalDiskUsage(storePath)).totalBytes,
          );
        }
        expect(
          openOpenClawAgentDatabase(databaseOptions)
            .db.prepare("SELECT session_id FROM session_windows ORDER BY session_id")
            .all(),
        ).toEqual(failure ? [{ session_id: "current" }, { session_id: "second" }] : []);
        expect(workers).toHaveLength(1);
        expect(workers[0]?.threadId).toBe(-1);
      },
    );
  },
);
