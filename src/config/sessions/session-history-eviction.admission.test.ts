import fs from "node:fs";
import path from "node:path";
import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { executeSqliteQuerySync } from "../../infra/kysely-sync.js";
import * as sqlite from "../../infra/node-sqlite.js";
import { revokeSqliteDatabaseAdmissionsForPath } from "../../infra/sqlite-database-admission.js";
import { isSessionMutationActive } from "../../sessions/session-controller.lifecycle.js";
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
import { loadSessionEntryReadOnly, loadTranscriptEventsSync } from "./session-accessor.js";
import { createWorkerSqliteIntegrityGate } from "./session-accessor.sqlite-integrity-counter.test-support.js";
import { observeNativeSqliteIntegrityChecks } from "./session-accessor.sqlite-native-integrity.test-support.js";
import {
  getSessionKysely,
  runExclusiveSqliteSessionWrite,
} from "./session-accessor.sqlite-scope.js";
import { createSessionHistoryBudgetFixture } from "./session-history-budget.test-support.js";
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
vi.mock("../../sessions/session-controller.lifecycle.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../sessions/session-controller.lifecycle.js")>();
  return {
    ...actual,
    runSessionMutation: <T>(params: Parameters<typeof actual.runSessionMutation<T>>[0]) =>
      actual.runSessionMutation({
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
    const currentScope = { sessionKey, storePath };
    const oldScope = { ...currentScope, sessionId: oldSessionId };
    await createSessionHistoryBudgetFixture(() => ({
      storePath,
      tempDir: sessionsDir,
    })).createHistoricalTranscript({
      sessionKey,
      sessionId: oldSessionId,
      nextSessionId: currentSessionId,
      updatedAt: oldAt,
      content: "x".repeat(64 * 1024),
    });
    const target = resolveSqliteTargetFromSessionStorePath(storePath);
    const options = { agentId: target.agentId ?? "main", path: target.path };
    const queueWriter = (run: () => void | Promise<void>) =>
      own(
        runExclusiveSqliteSessionWrite(
          options,
          async () => run(),
          "session.history.eviction-prepare",
        ),
      );
    // Instrument the next executor before discovery retains it for preparation.
    await closeOpenClawAgentDatabaseByPathAsync(options.path);
    const database = openOpenClawAgentDatabase(options);
    const historyBefore = loadTranscriptEventsSync(oldScope);
    expect(historyBefore.length).toBeGreaterThan(0);
    const currentEntry = loadSessionEntryReadOnly(currentScope);
    expect(currentEntry).toMatchObject({ sessionId: currentSessionId });
    database.walMaintenance.checkpoint();
    const peerBytes = 2 * 1024 * 1024;
    fs.writeFileSync(path.join(sessionsDir, "synthetic-pressure.bin"), Buffer.alloc(peerBytes));
    const { measureSessionPhysicalDiskUsage } = await import("./disk-budget.js");
    const before = await measureSessionPhysicalDiskUsage(storePath);

    let blockerReleased = false;
    let observingAdmission = false;
    let parentChecks = 0;
    let laterWriterRan = false;
    const preparationReady = createDeferred();
    const blockerEntered = createDeferred();
    const releaseBlocker = createDeferred();
    const integrityGate = createWorkerSqliteIntegrityGate(database.path);
    hook.integrityGate = integrityGate;
    releases.push(() => releaseBlocker.resolve(), integrityGate.release);

    observeNativeSqliteIntegrityChecks(database.path, () => {
      parentChecks += Number(observingAdmission);
    });
    const beforePreparation = async () => {
      hook.beforePlan = undefined;
      hook.afterMaterialize = undefined;
      expect(database.db.isTransaction).toBe(false);
      if (cold) {
        closeCachedOpenClawAgentDatabase(database);
        invalidateOpenClawAgentDatabaseValidation(database.path);
        revokeSqliteDatabaseAdmissionsForPath(database.path);
        expect(getOpenClawAgentDatabaseIfOpen(options)).toBeUndefined();
      }
      observingAdmission = true;
      if (cold) {
        integrityGate.arm();
      }
      void queueWriter(async () => {
        blockerEntered.resolve();
        await releaseBlocker.promise;
        blockerReleased = true;
      });
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
    const laterWriter = queueWriter(() => {
      expect(blockerReleased).toBe(true);
      laterWriterRan = true;
    });
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
      followingWriter = queueWriter(() => {
        followingWriterRan = true;
      });
      await yieldToEventLoop();
      // Both archive reads and cold integrity validation release writer admission;
      // transaction ordering resumes only when the reclaimer requests its write.
      expect(laterWriterRan).toBe(true);
      expect(followingWriterRan).toBe(true);
      expect(isSessionMutationActive(storePath, [oldSessionId])).toBe(true);
      if (outcome === "protected") {
        // A peer connection can refresh the live entry while its worker validates.
        const peer = realOpen(database.path);
        try {
          const updatedAt = Date.now();
          const row = getSessionKysely(peer)
            .updateTable("session_nodes")
            .where("session_key", "=", sessionKey);
          executeSqliteQuerySync(
            peer,
            row.set({
              updated_at: updatedAt,
              entry_json: JSON.stringify({ ...currentEntry, updatedAt }),
            }),
          );
          // Match the canonical writer's validity settlement after its payload/projection update.
          executeSqliteQuerySync(peer, row.set({ entry_valid: 1 }));
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
    expect(laterWriterRan).toBe(true);
    expect(boundary).toBe(cold ? "worker" : "completed");
    expect(parentChecks).toBe(0);
    expect(integrityGate.count()).toBe(cold ? 1 : 0);
    expect(isSessionMutationActive(storePath, [oldSessionId])).toBe(false);
    if (outcome === "revoked") {
      await closeOpenClawAgentDatabaseByPathAsync(database.path);
    }
    expect(loadSessionEntryReadOnly(currentScope)).toMatchObject({
      sessionId: currentSessionId,
    });
    if (outcome !== "reclaim") {
      expect(loadTranscriptEventsSync(oldScope)).toEqual(historyBefore);
    }
  },
);
