import fs from "node:fs";
import path from "node:path";
import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { createTempDirTracker } from "../../../test/helpers/temp-dir.js";
import * as sqlite from "../../infra/node-sqlite.js";
import * as integrity from "../../infra/sqlite-integrity-worker.js";
import {
  closeOpenClawAgentDatabaseByPath,
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { resetConfigRuntimeState, setRuntimeConfigSnapshot } from "../config.js";
import {
  appendTranscriptMessage,
  cleanupSessionLifecycleArtifactsCore,
  deleteSessionEntryLifecycle,
  loadSessionEntryReadOnly,
  replaceSessionEntrySync,
  resetSessionEntryLifecycle,
} from "./session-accessor.js";
import { runExclusiveSqliteSessionWrite } from "./session-accessor.sqlite-scope.js";

const archiveHook = vi.hoisted(() => ({ afterMaterialize: undefined as (() => void) | undefined }));
vi.mock("./session-accessor.sqlite-archive.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./session-accessor.sqlite-archive.js")>();
  return {
    ...actual,
    materializeSessionStateDeletePlans: async (
      ...args: Parameters<typeof actual.materializeSessionStateDeletePlans>
    ) => {
      const result = await actual.materializeSessionStateDeletePlans(...args);
      archiveHook.afterMaterialize?.();
      return result;
    },
  };
});

const roots = createTempDirTracker();
const pending: Promise<unknown>[] = [];
const releases: Array<() => void> = [];
const realOpen = sqlite.openNodeSqliteDatabase;
const realIntegrity = integrity.assertSqliteIntegrityInWorker;

beforeEach(() => {
  resetConfigRuntimeState();
  const config = { session: { maintenance: { mode: "warn" as const } } };
  setRuntimeConfigSnapshot(config, config);
});

afterEach(async () => {
  for (const release of releases.splice(0)) {
    release();
  }
  await Promise.allSettled(pending.splice(0));
  archiveHook.afterMaterialize = undefined;
  await closeOpenClawAgentDatabasesAsync();
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  resetConfigRuntimeState();
  roots.cleanup();
});

function own<T>(promise: Promise<T>): Promise<T> {
  pending.push(promise);
  void promise.catch(() => {});
  return promise;
}

function fixture() {
  const root = roots.make("session-lifecycle-admission-");
  vi.stubEnv("OPENCLAW_STATE_DIR", root);
  const storePath = path.join(root, "agents", "main", "sessions", "sessions.json");
  const scope = { storePath, sessionKey: "agent:main:cleanup-admission-target" };
  replaceSessionEntrySync(scope, { sessionId: "retained", updatedAt: 1 });
  const database = openOpenClawAgentDatabase({ agentId: "main" });
  const databaseOptions = {
    agentId: "main",
    path: database.path,
    env: { OPENCLAW_STATE_DIR: root },
  };
  closeOpenClawAgentDatabaseByPath(database.path);
  return { scope, databaseOptions };
}

function observeColdAdmission(databasePath: string) {
  const entered = createDeferred();
  const release = createDeferred();
  releases.push(() => release.resolve());
  let parentChecks = 0;
  vi.spyOn(sqlite, "openNodeSqliteDatabase").mockImplementation((pathname, options) => {
    const database = realOpen(pathname, options);
    if (pathname === databasePath && !options?.readOnly) {
      const prepare = database.prepare.bind(database);
      database.prepare = (sql) => {
        const statement = prepare(sql);
        if (sql === "PRAGMA integrity_check;") {
          const all = statement.all.bind(statement);
          statement.all = () => {
            parentChecks += 1;
            return all();
          };
        }
        return statement;
      };
    }
    return database;
  });
  vi.spyOn(integrity, "assertSqliteIntegrityInWorker").mockImplementation((...args) => {
    const work = realIntegrity(...args);
    if (args[0] !== databasePath) {
      return work;
    }
    entered.resolve();
    return Promise.all([work, release.promise]).then(() => undefined);
  });
  return { entered, release, parentChecks: () => parentChecks };
}

it.each(["delete", "artifact cleanup"] as const)(
  "keeps cold %s preparation asynchronous inside its writer FIFO",
  async (operation) => {
    const f = fixture();
    const admission = observeColdAdmission(f.databaseOptions.path);
    const work =
      operation === "delete"
        ? own(
            deleteSessionEntryLifecycle({
              storePath: f.scope.storePath,
              target: { canonicalKey: f.scope.sessionKey, storeKeys: [f.scope.sessionKey] },
              archiveTranscript: false,
            }),
          )
        : own(
            cleanupSessionLifecycleArtifactsCore({
              storePath: f.scope.storePath,
              sessionKeySegmentPrefix: "cleanup-admission-",
              transcriptContentMarker: "unused-marker",
              archiveRemovedEntryTranscripts: false,
              orphanTranscriptMinAgeMs: 0,
            }),
          );
    await yieldToEventLoop();
    expect(admission.parentChecks()).toBe(0);
    expect(
      await Promise.race([
        admission.entered.promise.then(() => true),
        work.then(
          () => false,
          () => false,
        ),
      ]),
    ).toBe(true);
    let followingWriterEntered = false;
    const following = own(
      runExclusiveSqliteSessionWrite(f.databaseOptions, async () => {
        followingWriterEntered = true;
      }),
    );
    await yieldToEventLoop();
    expect(followingWriterEntered).toBe(false);
    expect(loadSessionEntryReadOnly(f.scope)).toMatchObject({ sessionId: "retained" });
    admission.release.resolve();
    await expect(work).resolves.toMatchObject(
      operation === "delete" ? { deleted: true } : { removedEntries: 1 },
    );
    await following;
    expect(followingWriterEntered).toBe(true);
    expect(loadSessionEntryReadOnly(f.scope)).toBeUndefined();
  },
);

it("rejects retired authority before evaluating a stale deletion target", async () => {
  const f = fixture();
  const admission = observeColdAdmission(f.databaseOptions.path);
  let allowed = true;
  const revoked = new Error("deletion authority retired during validation");
  const work = own(
    deleteSessionEntryLifecycle({
      storePath: f.scope.storePath,
      target: { canonicalKey: f.scope.sessionKey, storeKeys: [f.scope.sessionKey] },
      archiveTranscript: false,
      expectedSessionId: "stale-generation",
      commitGuard: () => {
        if (!allowed) {
          throw revoked;
        }
      },
    }),
  );
  expect(
    await Promise.race([
      admission.entered.promise.then(() => true),
      work.then(
        () => false,
        () => false,
      ),
    ]),
  ).toBe(true);
  allowed = false;
  admission.release.resolve();
  await expect(work).rejects.toBe(revoked);
  expect(loadSessionEntryReadOnly(f.scope)).toMatchObject({ sessionId: "retained" });
});

it("keeps a warm lifecycle owner synchronous without another integrity child", async () => {
  const f = fixture();
  openOpenClawAgentDatabase(f.databaseOptions);
  const admission = observeColdAdmission(f.databaseOptions.path);
  const work = own(
    deleteSessionEntryLifecycle({
      storePath: f.scope.storePath,
      target: { canonicalKey: f.scope.sessionKey, storeKeys: [f.scope.sessionKey] },
      archiveTranscript: false,
    }),
  );
  expect(
    await Promise.race([admission.entered.promise.then(() => false), work.then(() => true)]),
  ).toBe(true);
  await expect(work).resolves.toMatchObject({ deleted: true });
  expect(admission.parentChecks()).toBe(0);
});

it("retains the selected state owner while cold deletion waits in the FIFO", async () => {
  const f = fixture();
  const blockerEntered = createDeferred();
  const releaseBlocker = createDeferred();
  releases.push(() => releaseBlocker.resolve());
  const blocker = own(
    runExclusiveSqliteSessionWrite(f.databaseOptions, async () => {
      blockerEntered.resolve();
      await releaseBlocker.promise;
    }),
  );
  await blockerEntered.promise;
  const admission = observeColdAdmission(f.databaseOptions.path);
  const work = own(
    deleteSessionEntryLifecycle({
      storePath: f.scope.storePath,
      target: { canonicalKey: f.scope.sessionKey, storeKeys: [f.scope.sessionKey] },
      archiveTranscript: false,
    }),
  );
  const otherRoot = roots.make("session-lifecycle-other-state-");
  vi.stubEnv("OPENCLAW_STATE_DIR", otherRoot);
  releaseBlocker.resolve();
  await blocker;
  expect(
    await Promise.race([
      admission.entered.promise.then(() => true),
      work.then(
        () => false,
        () => false,
      ),
    ]),
  ).toBe(true);
  admission.release.resolve();
  await expect(work).resolves.toMatchObject({ deleted: true });
  expect(fs.existsSync(path.join(otherRoot, "state", "openclaw.sqlite"))).toBe(false);
  expect(loadSessionEntryReadOnly(f.scope)).toBeUndefined();
});

it("keeps historical preparation asynchronous after materialization evicts its parent handle", async () => {
  const f = fixture();
  const target = { canonicalKey: f.scope.sessionKey, storeKeys: [f.scope.sessionKey] };
  await appendTranscriptMessage(
    { ...f.scope, sessionId: "retained" },
    {
      message: { role: "user", content: "historical content" },
    },
  );
  await resetSessionEntryLifecycle({
    storePath: f.scope.storePath,
    target,
    buildNextEntry: () => ({ sessionId: "current", updatedAt: 2 }),
  });
  await appendTranscriptMessage(
    { ...f.scope, sessionId: "current" },
    {
      message: { role: "user", content: "current content" },
    },
  );
  const admission = observeColdAdmission(f.databaseOptions.path);
  archiveHook.afterMaterialize = () => {
    archiveHook.afterMaterialize = undefined;
    closeOpenClawAgentDatabaseByPath(f.databaseOptions.path);
  };
  const work = own(
    deleteSessionEntryLifecycle({
      storePath: f.scope.storePath,
      target,
      archiveTranscript: true,
    }),
  );
  expect(
    await Promise.race([
      admission.entered.promise.then(() => true),
      work.then(
        () => false,
        () => false,
      ),
    ]),
  ).toBe(true);
  expect(admission.parentChecks()).toBe(0);
  expect(loadSessionEntryReadOnly(f.scope)).toMatchObject({ sessionId: "current" });
  admission.release.resolve();
  const result = await work;
  expect(result.deleted).toBe(true);
  expect(result.archivedTranscripts.map((archive) => archive.sessionId).toSorted()).toEqual([
    "current",
    "retained",
  ]);
  expect(loadSessionEntryReadOnly(f.scope)).toBeUndefined();
});
