import fs from "node:fs";
import path from "node:path";
import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { executeSqliteQuerySync } from "../../infra/kysely-sync.js";
import * as sqlite from "../../infra/node-sqlite.js";
import * as integrity from "../../infra/sqlite-integrity-worker.js";
import { isSessionLifecycleMutationActive } from "../../sessions/session-lifecycle-admission.js";
import {
  closeOpenClawAgentDatabaseByPath,
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
import {
  getSessionKysely,
  runExclusiveSqliteSessionWrite,
} from "./session-accessor.sqlite-scope.js";
import { enforceSqliteSessionHistoryDiskBudget } from "./session-history-eviction.js";
import { resolveSqliteTargetFromSessionStorePath } from "./session-sqlite-target.js";

const hook = vi.hoisted(() => ({
  beforePlan: undefined as (() => Promise<void>) | undefined,
  afterMaterialize: undefined as (() => Promise<void>) | undefined,
}));
vi.mock("../../sessions/session-lifecycle-admission.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../sessions/session-lifecycle-admission.js")>();
  return {
    ...actual,
    runExclusiveSessionLifecycleMutation: <T>(
      params: Parameters<typeof actual.runExclusiveSessionLifecycleMutation<T>>[0],
    ) =>
      actual.runExclusiveSessionLifecycleMutation({
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
    materializeSessionStateDeletePlans: async (
      ...args: Parameters<typeof actual.materializeSessionStateDeletePlans>
    ) => {
      const result = await actual.materializeSessionStateDeletePlans(...args);
      await hook.afterMaterialize?.();
      return result;
    },
  };
});

let testState: OpenClawTestState;
const pending: Promise<unknown>[] = [];
const releases: Array<() => void> = [];
const realOpen = sqlite.openNodeSqliteDatabase;
const realIntegrity = integrity.assertSqliteIntegrityInWorker;

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
  "keeps $boundary history preparation and $outcome inside its writer FIFO (cold: $cold)",
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
    let childChecks = 0;
    let laterWriterRan = false;
    const preparationReady = createDeferred();
    const blockerEntered = createDeferred();
    const releaseBlocker = createDeferred();
    const childEntered = createDeferred();
    const releaseChild = createDeferred();
    releases.push(
      () => releaseBlocker.resolve(),
      () => releaseChild.resolve(),
    );

    vi.spyOn(sqlite, "openNodeSqliteDatabase").mockImplementation((pathname, openOptions) => {
      const opened = realOpen(pathname, openOptions);
      if (pathname === database.path && !openOptions?.readOnly) {
        const prepare = opened.prepare.bind(opened);
        opened.prepare = (sql) => {
          const statement = prepare(sql);
          if (sql === "PRAGMA integrity_check;") {
            const all = statement.all.bind(statement);
            statement.all = () => {
              if (observingAdmission) {
                parentChecks += 1;
                events.push("parent-full-integrity-check");
              }
              return all();
            };
          }
          return statement;
        };
      }
      return opened;
    });
    vi.spyOn(integrity, "assertSqliteIntegrityInWorker").mockImplementation((...args) => {
      const check = realIntegrity(...args);
      if (!observingAdmission || args[0] !== database.path) {
        return check;
      }
      childChecks += 1;
      events.push("child-integrity-entered");
      childEntered.resolve();
      return Promise.all([check, releaseChild.promise]).then(() => undefined);
    });

    const beforePreparation = async () => {
      hook.beforePlan = undefined;
      hook.afterMaterialize = undefined;
      events.push("preparation-ready");
      expect(database.db.isTransaction).toBe(false);
      if (cold) {
        closeOpenClawAgentDatabaseByPath(database.path);
        expect(getOpenClawAgentDatabaseIfOpen(options)).toBeUndefined();
        events.push("parent-handle-closed");
      }
      observingAdmission = true;
      void own(
        runExclusiveSqliteSessionWrite(options, async () => {
          events.push("blocker-entered");
          blockerEntered.resolve();
          await releaseBlocker.promise;
          events.push("blocker-released");
        }),
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
      runExclusiveSqliteSessionWrite(options, async () => {
        laterWriterRan = true;
        events.push("later-writer");
      }),
    );
    expect(laterWriterRan).toBe(false);
    releaseBlocker.resolve();
    const boundary = await Promise.race([
      childEntered.promise.then(() => "child" as const),
      work.then(() => "completed" as const),
    ]);
    if (boundary === "child") {
      await yieldToEventLoop();
      expect(laterWriterRan).toBe(false);
      expect(isSessionLifecycleMutationActive(storePath, [oldSessionId])).toBe(true);
      if (outcome === "protected") {
        // A peer connection can refresh the live entry while the parent validates.
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
    releaseChild.resolve();
    if (outcome === "revoked") {
      await expect(work).rejects.toThrow(/revoked/);
      expect(getOpenClawAgentDatabaseIfOpen(options)).toBeUndefined();
    } else {
      await expect(work).resolves.toMatchObject({
        removedEntries: outcome === "reclaim" ? 1 : 0,
      });
    }
    await laterWriter;
    observingAdmission = false;
    expect(boundary).toBe(cold ? "child" : "completed");
    expect(events.indexOf("later-writer")).toBeGreaterThan(events.indexOf("blocker-released"));
    expect(parentChecks).toBe(0);
    expect(childChecks).toBe(cold ? 1 : 0);
    expect(isSessionLifecycleMutationActive(storePath, [oldSessionId])).toBe(false);
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
