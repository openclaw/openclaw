import fs from "node:fs";
import path from "node:path";
import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import type { WorkerOptions } from "node:worker_threads";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { createTempDirTracker } from "../../../test/helpers/temp-dir.js";
import * as sqlite from "../../infra/node-sqlite.js";
import * as integrity from "../../infra/sqlite-integrity-worker.js";
import * as logging from "../../logging/logger.js";
import { closeCachedOpenClawAgentDatabase } from "../../state/openclaw-agent-db-lifecycle.js";
import { invalidateOpenClawAgentDatabaseValidation } from "../../state/openclaw-agent-db-validation-cache.js";
import {
  closeOpenClawAgentDatabaseByPath,
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { clearOpenClawAgentIntegrityVerification } from "../../state/openclaw-quarantine-store.js";
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
import { withWorkerSqliteIntegrityCounter } from "./session-accessor.sqlite-integrity-counter.test-support.js";
import * as reclamationWorker from "./session-accessor.sqlite-reclamation-worker.js";
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

const nativeAdmission = vi.hoisted<{
  current?: {
    databasePath: string;
    mode: "integrity" | "historical-check";
    armed: boolean;
    held: boolean;
    checks: SharedArrayBuffer;
    release: SharedArrayBuffer;
    entered: () => void;
  };
}>(() => ({}));
vi.mock("node:worker_threads", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:worker_threads")>();
  return {
    ...actual,
    Worker: class extends actual.Worker {
      private readonly admissionProbe: typeof nativeAdmission.current;

      constructor(filename: string | URL, options: WorkerOptions = {}) {
        const probe = nativeAdmission.current;
        super(
          filename,
          probe
            ? withWorkerSqliteIntegrityCounter(
                options,
                probe.checks,
                probe.mode === "integrity" ? probe.release : undefined,
                probe.databasePath,
              )
            : options,
        );
        this.admissionProbe = probe;
      }

      override emit(event: string | symbol, ...args: unknown[]): boolean {
        const message = args[0];
        if (
          this.admissionProbe?.mode === "integrity" &&
          event === "message" &&
          args.length === 1 &&
          isRecord(message) &&
          Object.keys(message).length === 2 &&
          message.type === "test-integrity-check" &&
          (message.phase === "checking" || message.phase === "checked")
        ) {
          if (message.phase === "checking") {
            this.admissionProbe.entered();
          }
          return true;
        }
        return super.emit(event, ...args);
      }
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
  nativeAdmission.current = undefined;
  archiveHook.afterMaterialize = undefined;
  await logging.flushLogger();
  logging.resetLogger();
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
  invalidateOpenClawAgentDatabaseValidation(database.path);
  clearOpenClawAgentIntegrityVerification(database.path, databaseOptions.env);
  return { scope, databaseOptions };
}

function observeColdAdmission(
  databasePath: string,
  mode: "integrity" | "historical-check" = "integrity",
) {
  const entered = createDeferred();
  const hostRelease = createDeferred();
  const nativeRelease = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
  const probe = {
    databasePath: fs.realpathSync(databasePath),
    mode,
    armed: false,
    held: false,
    checks: new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT),
    release: nativeRelease,
    entered: () => entered.resolve(),
  };
  nativeAdmission.current = probe;
  const release = {
    resolve() {
      hostRelease.resolve();
      Atomics.store(new Int32Array(nativeRelease), 0, 1);
      Atomics.notify(new Int32Array(nativeRelease), 0);
    },
  };
  releases.push(() => release.resolve());
  let parentChecks = 0;
  vi.spyOn(sqlite, "openNodeSqliteDatabase").mockImplementation((pathname, options) => {
    const database = realOpen(pathname, options);
    if (pathname === databasePath && !options?.readOnly) {
      const prepare = database.prepare.bind(database);
      database.prepare = (sql) => {
        const statement = prepare(sql);
        if (
          sql === "PRAGMA integrity_check;" ||
          sql === "PRAGMA integrity_check('sqlite_schema');"
        ) {
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
    if (args[0] !== databasePath || mode !== "integrity") {
      return work;
    }
    entered.resolve();
    return Promise.all([work, hostRelease.promise]).then(() => undefined);
  });
  if (mode === "historical-check") {
    const withWorker = reclamationWorker.withSqliteReclamationWorker;
    vi.spyOn(reclamationWorker, "withSqliteReclamationWorker").mockImplementation(
      (options, claim, run, assertCurrent, signal) =>
        withWorker(
          options,
          claim,
          async (worker) => {
            const execute = worker.run.bind(worker);
            const spy = vi.spyOn(worker, "run").mockImplementation((params) => {
              if (
                !probe.armed ||
                probe.held ||
                params.plan.databaseOptions.path !== probe.databasePath ||
                params.plan.kind !== "deletion-plan" ||
                params.plan.planning.operation !== "check"
              ) {
                return execute(params);
              }
              return execute({
                ...params,
                withWriteAdmission: (performWrite, diagnostics) =>
                  params.withWriteAdmission(async (...admissionArgs) => {
                    const [refusal] = admissionArgs;
                    if (!refusal && !probe.held) {
                      probe.held = true;
                      entered.resolve();
                      await hostRelease.promise;
                    }
                    return performWrite(...admissionArgs);
                  }, diagnostics),
              });
            });
            try {
              return await run(worker);
            } finally {
              spy.mockRestore();
            }
          },
          assertCurrent,
          signal,
        ),
    );
  }
  return {
    entered,
    release,
    parentChecks: () => parentChecks,
    armHistoricalCheck: () => {
      probe.armed = true;
    },
  };
}

it("keeps cold delete preparation asynchronous inside its writer FIFO", async () => {
  const f = fixture();
  const admission = observeColdAdmission(f.databaseOptions.path);
  const work = own(
    deleteSessionEntryLifecycle({
      storePath: f.scope.storePath,
      target: { canonicalKey: f.scope.sessionKey, storeKeys: [f.scope.sessionKey] },
      archiveTranscript: false,
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
    runExclusiveSqliteSessionWrite(
      f.databaseOptions,
      async () => {
        followingWriterEntered = true;
      },
      "session.transcript.batch",
    ),
  );
  await yieldToEventLoop();
  expect(followingWriterEntered).toBe(false);
  expect(loadSessionEntryReadOnly(f.scope)).toMatchObject({ sessionId: "retained" });
  admission.release.resolve();
  await expect(work).resolves.toMatchObject({ deleted: true });
  await following;
  expect(followingWriterEntered).toBe(true);
  expect(loadSessionEntryReadOnly(f.scope)).toBeUndefined();
});

it.each(["cold", "warm"] as const)(
  "keeps no-op lifecycle cleanup read-only across a %s ordinary-session fleet",
  async (admission) => {
    const root = roots.make("session-lifecycle-clean-fleet-");
    vi.stubEnv("OPENCLAW_STATE_DIR", root);
    const fleet = ["first", "second", "third"].map((agentId) => {
      const storePath = path.join(root, "agents", agentId, "sessions", "sessions.json");
      const scope = { agentId, storePath, sessionKey: `agent:${agentId}:ordinary` };
      const entry = { sessionId: `${agentId}-retained`, updatedAt: 1 };
      replaceSessionEntrySync(scope, entry);
      return { scope, entry, path: openOpenClawAgentDatabase({ agentId }).path };
    });
    const paths = new Set(fleet.map((store) => store.path));
    const opened = vi.spyOn(sqlite, "openNodeSqliteDatabase");
    const inspected = vi.spyOn(integrity, "assertSqliteIntegrityInWorker");
    if (admission === "cold") {
      await closeOpenClawAgentDatabasesAsync();
      closeOpenClawAgentDatabasesForTest();
    }
    opened.mockClear();
    inspected.mockClear();
    for (const { scope, entry } of fleet) {
      await expect(
        cleanupSessionLifecycleArtifactsCore({
          agentId: scope.agentId,
          storePath: scope.storePath,
          sessionKeySegmentPrefix: "dreaming-",
          transcriptContentMarker: "dreaming-marker",
          orphanTranscriptMinAgeMs: 0,
        }),
      ).resolves.toEqual({ removedEntries: 0, archivedTranscriptArtifacts: 0 });
      expect(loadSessionEntryReadOnly(scope)).toMatchObject(entry);
    }
    expect(
      opened.mock.calls.filter(
        ([pathname, options]) =>
          typeof pathname === "string" && paths.has(pathname) && options?.readOnly !== true,
      ),
    ).toEqual([]);
    expect(inspected.mock.calls.filter(([pathname]) => paths.has(pathname))).toEqual([]);
  },
);

it("retains canonical repair refusal during warm cleanup with no matching artifacts", async () => {
  const f = fixture();
  const database = openOpenClawAgentDatabase(f.databaseOptions);
  database.db
    .prepare("UPDATE session_nodes SET entry_json = ? WHERE session_key = ?")
    .run("{", f.scope.sessionKey);
  await expect(
    cleanupSessionLifecycleArtifactsCore({
      storePath: f.scope.storePath,
      sessionKeySegmentPrefix: "dreaming-",
      transcriptContentMarker: "dreaming-marker",
      orphanTranscriptMinAgeMs: 0,
    }),
  ).rejects.toThrow("invalid persisted session row requires repair");
  expect(database.db.isTransaction).toBe(false);
  expect(
    database.db
      .prepare("SELECT entry_json FROM session_nodes WHERE session_key = ?")
      .get(f.scope.sessionKey),
  ).toEqual({ entry_json: "{" });
});

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

it("retains the selected state owner while cold deletion waits in the FIFO", async () => {
  const f = fixture();
  const blockerEntered = createDeferred();
  const releaseBlocker = createDeferred();
  releases.push(() => releaseBlocker.resolve());
  const blocker = own(
    runExclusiveSqliteSessionWrite(
      f.databaseOptions,
      async () => {
        blockerEntered.resolve();
        await releaseBlocker.promise;
      },
      "session.transcript.batch",
    ),
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
  const admission = observeColdAdmission(f.databaseOptions.path, "historical-check");
  archiveHook.afterMaterialize = () => {
    archiveHook.afterMaterialize = undefined;
    closeCachedOpenClawAgentDatabase(openOpenClawAgentDatabase(f.databaseOptions), {
      eviction: true,
    });
    invalidateOpenClawAgentDatabaseValidation(f.databaseOptions.path);
    clearOpenClawAgentIntegrityVerification(f.databaseOptions.path, f.databaseOptions.env);
    admission.armHistoricalCheck();
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
  await yieldToEventLoop();
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
