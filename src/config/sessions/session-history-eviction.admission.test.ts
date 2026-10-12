import fs from "node:fs";
import path from "node:path";
import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { executeSqliteQuerySync } from "../../infra/kysely-sync.js";
import * as sqlite from "../../infra/node-sqlite.js";
import { revokeSqliteDatabaseAdmissionsForPath } from "../../infra/sqlite-database-admission.js";
import { isSessionLifecycleMutationActive } from "../../sessions/session-lifecycle-admission.js";
import { closeCachedOpenClawAgentDatabase } from "../../state/openclaw-agent-db-lifecycle.js";
import { invalidateOpenClawAgentDatabaseValidation } from "../../state/openclaw-agent-db-validation-cache.js";
import {
  closeOpenClawAgentDatabaseByPath,
  closeOpenClawAgentDatabaseByPathAsync,
  closeOpenClawAgentDatabasesAsync,
  getOpenClawAgentDatabaseIfOpen,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import {
  appendTranscriptMessage,
  loadSessionEntryReadOnly,
  loadTranscriptEventsSync,
  replaceSessionEntry,
  resetSessionEntryLifecycle,
} from "./session-accessor.js";
import { createWorkerSqliteIntegrityGate } from "./session-accessor.sqlite-integrity-counter.test-support.js";
import {
  getSessionKysely,
  runExclusiveSqliteSessionWrite,
} from "./session-accessor.sqlite-scope.js";
import { enforceSqliteSessionHistoryDiskBudget } from "./session-history-eviction.js";
import { resolveSqliteTargetFromSessionStorePath } from "./session-sqlite-target.js";

const hook = vi.hoisted(() => ({
  beforePlan: undefined as (() => Promise<void>) | undefined,
  afterMaterialize: undefined as (() => Promise<void>) | undefined,
  integrityGate: undefined as ReturnType<typeof createWorkerSqliteIntegrityGate> | undefined,
}));
vi.mock("node:worker_threads", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:worker_threads")>();
  const { observeWorkerSqliteIntegrity } =
    await import("./session-accessor.sqlite-integrity-counter.test-support.js");
  return {
    ...actual,
    Worker: observeWorkerSqliteIntegrity(actual.Worker, () => hook.integrityGate),
  };
});
vi.mock("../../sessions/session-lifecycle-admission.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../sessions/session-lifecycle-admission.js")>();
  return {
    ...actual,
    runExclusiveSessionLifecycleMutation: <T>(
      operation: Parameters<typeof actual.runExclusiveSessionLifecycleMutation<T>>[0],
      params: Parameters<typeof actual.runExclusiveSessionLifecycleMutation<T>>[1],
    ) =>
      actual.runExclusiveSessionLifecycleMutation(operation, {
        ...params,
        run: async () => {
          await hook.beforePlan?.();
          return params.run();
        },
      }),
  };
});
vi.mock("./session-accessor.sqlite-archive.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./session-accessor.sqlite-archive.js")>();
  return {
    ...actual,
    materializeSessionHistoryEvictionPlan: async (
      ...args: Parameters<typeof actual.materializeSessionHistoryEvictionPlan>
    ) => {
      const result = await actual.materializeSessionHistoryEvictionPlan(...args);
      await hook.afterMaterialize?.();
      return result;
    },
  };
});

let testState: OpenClawTestState;
const pending: Promise<unknown>[] = [];
const releases: Array<() => void> = [];
const realOpen = sqlite.openNodeSqliteDatabase;

beforeEach(async () => {
  testState = await createOpenClawTestState({
    prefix: "history-cold-parent-repro-",
    layout: "state-only",
  });
});

afterEach(async () => {
  releases.splice(0).forEach((release) => release());
  await Promise.allSettled(pending.splice(0));
  hook.beforePlan = undefined;
  hook.afterMaterialize = undefined;
  vi.restoreAllMocks();
  await closeOpenClawAgentDatabasesAsync();
  await testState.cleanup();
  if (hook.integrityGate) {
    expect([...hook.integrityGate.workers].every((worker) => worker.threadId === -1)).toBe(true);
    hook.integrityGate = undefined;
  }
});

function own<T>(promise: Promise<T>): Promise<T> {
  pending.push(promise);
  void promise.catch(() => {});
  return promise;
}

it.each([
  { boundary: "initial", cold: false, outcome: "reclaim" },
  { boundary: "initial", cold: true, outcome: "reclaim" },
  { boundary: "replan", cold: false, outcome: "reclaim" },
  { boundary: "replan", cold: true, outcome: "reclaim" },
  { boundary: "initial", cold: true, outcome: "protected" },
  { boundary: "replan", cold: true, outcome: "protected" },
  { boundary: "initial", cold: true, outcome: "revoked" },
  { boundary: "replan", cold: true, outcome: "revoked" },
] as const)(
  "keeps $boundary history preparation and $outcome ordered at worker admission (cold: $cold)",
  async ({ boundary: preparationBoundary, cold, outcome }) => {
    const sessionsDir = testState.sessionsDir();
    fs.mkdirSync(sessionsDir, { recursive: true });
    const storePath = path.join(sessionsDir, "sessions.json");
    const sessionKey = "agent:main:cold-history-repro";
    const oldSessionId = "old-generation";
    const currentSessionId = "current-generation";
    const dayMs = 24 * 60 * 60 * 1000;
    const oldAt = Date.now() - 8 * dayMs;
    await replaceSessionEntry(
      { sessionKey, storePath },
      { sessionId: oldSessionId, updatedAt: oldAt },
    );
    await appendTranscriptMessage(
      { sessionKey, sessionId: oldSessionId, storePath },
      {
        message: { role: "user", content: "synthetic historical payload " + "x".repeat(64 * 1024) },
      },
    );
    await resetSessionEntryLifecycle({
      storePath,
      target: { canonicalKey: sessionKey, storeKeys: [sessionKey] },
      buildNextEntry: () => ({ sessionId: currentSessionId, updatedAt: oldAt + 1 }),
    });
    const target = resolveSqliteTargetFromSessionStorePath(storePath);
    const options = { agentId: target.agentId ?? "main", path: target.path };
    // Instrument the next executor before discovery retains it for preparation.
    await closeOpenClawAgentDatabaseByPathAsync(options.path);
    const database = openOpenClawAgentDatabase(options);
    const historyBefore = loadTranscriptEventsSync({
      sessionKey,
      sessionId: oldSessionId,
      storePath,
    });
    expect(historyBefore.length).toBeGreaterThan(0);
    const currentEntry = loadSessionEntryReadOnly({ sessionKey, storePath });
    expect(currentEntry).toMatchObject({ sessionId: currentSessionId });
    // Synthetic bootstrap fixes victim age; it does not change the cleanup algorithm.
    database.db
      .prepare("UPDATE session_windows SET updated_at = ? WHERE session_id = ?")
      .run(oldAt, oldSessionId);
    database.walMaintenance.checkpoint();
    const peerBytes = 2 * 1024 * 1024;
    fs.writeFileSync(path.join(sessionsDir, "synthetic-pressure.bin"), Buffer.alloc(peerBytes));
    const { measureSessionPhysicalDiskUsage } = await import("./disk-budget.js");
    const before = await measureSessionPhysicalDiskUsage(storePath);

    const events: string[] = [];
    let observingAdmission = false;
    let parentChecks = 0;
    let laterWriterRan = false;
    const preparationReady = createDeferred();
    const blockerEntered = createDeferred();
    const releaseBlocker = createDeferred();
    const integrityGate = createWorkerSqliteIntegrityGate(database.path);
    hook.integrityGate = integrityGate;
    releases.push(() => releaseBlocker.resolve(), integrityGate.release);

    vi.spyOn(sqlite, "openNodeSqliteDatabase").mockImplementation((pathname, openOptions) => {
      const opened = realOpen(pathname, openOptions);
      if (pathname === database.path && !openOptions?.readOnly) {
        const prepare = opened.prepare.bind(opened);
        opened.prepare = (sql) => {
          const statement = prepare(sql);
          if (
            sql === "PRAGMA integrity_check;" ||
            sql === "PRAGMA integrity_check('sqlite_schema');"
          ) {
            const all = statement.all.bind(statement);
            statement.all = () => {
              if (observingAdmission) {
                parentChecks += 1;
                events.push("parent-integrity-check");
              }
              return all();
            };
          }
          return statement;
        };
      }
      return opened;
    });
    const beforePreparation = async () => {
      hook.beforePlan = undefined;
      hook.afterMaterialize = undefined;
      events.push("preparation-ready");
      expect(database.db.isTransaction).toBe(false);
      if (cold) {
        closeCachedOpenClawAgentDatabase(database, { eviction: true });
        invalidateOpenClawAgentDatabaseValidation(database.path);
        revokeSqliteDatabaseAdmissionsForPath(database.path);
        expect(getOpenClawAgentDatabaseIfOpen(options)).toBeUndefined();
        events.push("parent-handle-closed");
      }
      observingAdmission = true;
      if (cold) {
        integrityGate.arm();
      }
      void own(
        runExclusiveSqliteSessionWrite(
          options,
          async () => {
            events.push("blocker-entered");
            blockerEntered.resolve();
            await releaseBlocker.promise;
            events.push("blocker-released");
          },
          "session.history.eviction-prepare",
        ),
      );
      await blockerEntered.promise;
      preparationReady.resolve();
    };
    if (preparationBoundary === "initial") {
      hook.beforePlan = beforePreparation;
    } else {
      hook.afterMaterialize = beforePreparation;
    }

    const work = own(
      enforceSqliteSessionHistoryDiskBudget({
        storePath,
        mode: "enforce",
        maintenance: {
          maxDiskBytes: before.totalBytes - 1,
          highWaterBytes: before.totalBytes - peerBytes / 2,
          preserveRecentMs: 7 * dayMs,
        },
      }),
    );
    await preparationReady.promise;
    await yieldToEventLoop();
    const laterWriter = own(
      runExclusiveSqliteSessionWrite(
        options,
        async () => {
          laterWriterRan = true;
          events.push("later-writer");
        },
        "session.history.eviction-prepare",
      ),
    );
    expect(laterWriterRan).toBe(false);
    releaseBlocker.resolve();
    const boundary = await Promise.race([
      integrityGate.entered.then(() => "worker" as const),
      work.then(() => "completed" as const),
    ]);
    let followingWriter: Promise<void> | undefined;
    if (boundary === "worker") {
      await laterWriter;
      let followingWriterRan = false;
      followingWriter = own(
        runExclusiveSqliteSessionWrite(
          options,
          async () => {
            followingWriterRan = true;
            events.push("following-writer");
          },
          "session.history.eviction-prepare",
        ),
      );
      await yieldToEventLoop();
      // Both archive reads and cold integrity validation release writer admission;
      // transaction ordering resumes only when the reclaimer requests its write.
      expect(laterWriterRan).toBe(true);
      expect(followingWriterRan).toBe(true);
      expect(isSessionLifecycleMutationActive(storePath, [oldSessionId])).toBe(true);
      if (outcome === "protected") {
        // A peer connection can refresh the live entry while its worker validates.
        const peer = realOpen(database.path);
        try {
          const updatedAt = Date.now();
          executeSqliteQuerySync(
            peer,
            getSessionKysely(peer)
              .updateTable("session_nodes")
              .set({
                updated_at: updatedAt,
                entry_json: JSON.stringify({ ...currentEntry, updatedAt }),
              })
              .where("session_key", "=", sessionKey),
          );
          // Match the canonical writer's validity settlement after its payload/projection update.
          executeSqliteQuerySync(
            peer,
            getSessionKysely(peer)
              .updateTable("session_nodes")
              .set({ entry_valid: 1 })
              .where("session_key", "=", sessionKey),
          );
        } finally {
          peer.close();
        }
      } else if (outcome === "revoked") {
        closeOpenClawAgentDatabaseByPath(database.path);
      }
    }
    integrityGate.release();
    if (outcome === "revoked") {
      await expect(work).rejects.toThrow(/revoked|admission is closed/);
      expect(getOpenClawAgentDatabaseIfOpen(options)).toBeUndefined();
    } else {
      await expect(work).resolves.toMatchObject({
        removedEntries: outcome === "reclaim" ? 1 : 0,
      });
    }
    await laterWriter;
    await followingWriter;
    observingAdmission = false;
    expect(boundary).toBe(cold ? "worker" : "completed");
    expect(events.indexOf("later-writer")).toBeGreaterThan(events.indexOf("blocker-released"));
    expect(parentChecks).toBe(0);
    expect(integrityGate.count()).toBe(cold ? 1 : 0);
    expect(isSessionLifecycleMutationActive(storePath, [oldSessionId])).toBe(false);
    if (outcome === "revoked") {
      await closeOpenClawAgentDatabaseByPathAsync(database.path);
    }
    expect(loadSessionEntryReadOnly({ sessionKey, storePath })).toMatchObject({
      sessionId: currentSessionId,
    });
    if (outcome !== "reclaim") {
      expect(loadTranscriptEventsSync({ sessionKey, sessionId: oldSessionId, storePath })).toEqual(
        historyBefore,
      );
    }
  },
);
