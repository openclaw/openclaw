import { AsyncLocalStorage } from "node:async_hooks";
import { once } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { Worker } from "node:worker_threads";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../../test/helpers/promise.js";
import { useSqliteWorkerFault } from "../../../test/helpers/sqlite-worker-fault.js";
import { requireNodeSqlite } from "../../infra/node-sqlite.js";
import * as processRespawn from "../../infra/process-respawn.js";
import * as workerCpu from "../../infra/worker-cpu.js";
import { runInDetachedAsyncContext } from "../../shared/detached-async-context.js";
import {
  closeOpenClawAgentDatabaseByPathAsync as closeAgentDatabase,
  closeOpenClawAgentDatabasesAsync,
  openOpenClawAgentDatabase,
  getOpenClawAgentDatabaseIfOpen,
} from "../../state/openclaw-agent-db.js";
import * as writeAdmission from "../../state/openclaw-agent-write-admission.js";
import { closeOpenClawStateDatabaseByPathAsync } from "../../state/openclaw-state-db-cache.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import { claimOpenClawStateOwnership } from "../../state/openclaw-state-ownership-operations.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { readSessionArchiveContentSync } from "./archive-compression.js";
import {
  deleteSessionEntryLifecycle,
  loadSessionEntry,
  loadTranscriptEvents,
  replaceSessionEntry,
} from "./session-accessor.js";
import { withSqliteTranscriptArchiveSession as withArchiveSession } from "./session-accessor.sqlite-archive-session.js";
import * as archiveSession from "./session-accessor.sqlite-archive-session.js";
import * as archiveStore from "./session-accessor.sqlite-archive-store.js";
import type {
  TranscriptArchivePublishWorkerMessage,
  TranscriptArchiveWorkerMessage,
} from "./session-accessor.sqlite-archive-types.js";
import * as archiveWorker from "./session-accessor.sqlite-archive.js";
import { runExclusiveSqliteTranscriptArchiveWorker as withArchiveWorker } from "./session-accessor.sqlite-archive.js";
import { planSessionStateDeleteIfUnreferenced } from "./session-accessor.sqlite-delete-snapshot.js";
import * as sessionDeletion from "./session-accessor.sqlite-deletion.js";
import * as reclamation from "./session-accessor.sqlite-reclamation-run.js";
import type { SqliteReclamationWorker } from "./session-accessor.sqlite-reclamation-worker-lifetime.js";
import * as reclamationWorker from "./session-accessor.sqlite-reclamation-worker.js";
import * as sessionWorker from "./session-accessor.sqlite-replacement-worker.js";
import { replaceTranscriptEvents } from "./session-accessor.sqlite-transcript-write.test-support.js";
import * as archivePublication from "./session-archive-publication.js";
import { runSessionColdStorageMaintenance } from "./session-cold-storage.js";
import {
  createSessionColdStorageFixture,
  maintenanceConfig,
} from "./session-cold-storage.test-support.js";
import { resolveSqliteTargetFromSessionStorePath } from "./session-sqlite-target.js";
import { waitForSessionTranscriptIndexReconcilesInStateDir as waitForReconciliation } from "./session-transcript-reconcile.js";

const createNativeTrackedWorker = workerCpu.createCpuTrackedWorker;

const fault = useSqliteWorkerFault([
  {
    name: "refuse_archive_result",
    match: /^update session_transcript_archives\b/u,
    sql: `CREATE TEMP TRIGGER refuse_archive_result BEFORE UPDATE OF published_at
      ON main.session_transcript_archives
      BEGIN SELECT RAISE(ABORT, 'synthetic archive result recording failure'); END;`,
  },
]);

describe("SQLite transcript archive sessions", () => {
  let testState: OpenClawTestState;
  let tempDir: string;
  let storePath: string;

  beforeEach(async () => {
    testState = await createOpenClawTestState({
      prefix: "openclaw-sqlite-archive-session-",
      layout: "state-only",
    });
    tempDir = testState.stateDir;
    storePath = path.join(testState.sessionsDir(), "sessions.json");
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await waitForReconciliation(tempDir);
    await closeOpenClawAgentDatabasesAsync(tempDir);
    await testState.cleanup();
  });

  function sessionScope(sessionId: string, agentId = "main") {
    return {
      sessionId,
      sessionKey: `agent:${agentId}:${sessionId}`,
      storePath: path.join(testState.sessionsDir(agentId), "sessions.json"),
    };
  }

  async function seedSession(
    scope: ReturnType<typeof sessionScope>,
    content: string,
    updatedAt = 1,
  ) {
    const { sessionId } = scope;
    const event = { type: "session", id: sessionId, content };
    await replaceSessionEntry(scope, { sessionId, updatedAt });
    await replaceTranscriptEvents(scope, [event]);
    return event;
  }

  async function prepareSession(sessionId: string, content = "synthetic archive payload") {
    const scope = sessionScope(sessionId);
    const event = await seedSession(scope, content);
    await waitForReconciliation(tempDir);
    const database = openLifecycleTestDatabase(storePath);
    return { ...scope, scope, event, database };
  }

  async function prepareGenerations(
    sessionKey: string,
    sessionIds: readonly string[],
    content: string,
  ) {
    const events = [];
    for (const [index, sessionId] of sessionIds.entries()) {
      events.push(await seedSession({ sessionKey, sessionId, storePath }, content, index + 1));
    }
    await waitForReconciliation(tempDir);
    return events;
  }

  function archiveRow(sessionId: string, columns: string) {
    return openLifecycleTestDatabase(storePath)
      .db.prepare(`SELECT ${columns} FROM session_transcript_archives WHERE session_id = ?`)
      .get(sessionId);
  }

  async function expectSession(scope: ReturnType<typeof sessionScope>, event?: unknown) {
    if (event === undefined) {
      expect(loadSessionEntry(scope)).toBeUndefined();
    } else {
      expect(loadSessionEntry(scope)).toMatchObject({ sessionId: scope.sessionId });
    }
    await expect(loadTranscriptEvents(scope)).resolves.toEqual(event === undefined ? [] : [event]);
  }

  function expectArchivedEvent(archivePath: string | undefined, event: unknown) {
    expect(archivePath).toBeTruthy();
    expect(
      readSessionArchiveContentSync(archivePath ?? "")
        .trim()
        .split("\n"),
    ).toEqual([JSON.stringify(event)]);
  }

  function deleteArchivedSession(sessionKey: string, targetStorePath = storePath) {
    return deleteSessionEntryLifecycle({
      archiveTranscript: true,
      storePath: targetStorePath,
      target: { canonicalKey: sessionKey, storeKeys: [sessionKey] },
    });
  }

  it.each(["one-shot", "scoped"] as const)(
    "retains a timed-out %s archive until native exit and requests recovery when retirement stalls",
    async (mode) => {
      const { sessionId, scope, event, database } = await prepareSession(`timeout-${mode}`);
      const plan = planSessionStateDeleteIfUnreferenced({
        archiveDirectory: path.dirname(storePath),
        database,
        referencedSessionIds: new Set(),
        sessionId,
      });
      if (!plan) {
        throw new Error("expected a retained archive plan");
      }
      const gate = new Int32Array(new SharedArrayBuffer(8));
      let archive: Worker | undefined;
      using createWorker = vi
        .spyOn(workerCpu, "createCpuTrackedWorker")
        .mockImplementation((filename, options) => {
          if (
            !isRecord(options?.workerData) ||
            options.workerData.type !== "sqlite-transcript-archive-v2"
          ) {
            return createNativeTrackedWorker(filename, options);
          }
          archive = createNativeTrackedWorker(
            new URL("./session-accessor.sqlite-archive-timeout.test-support.mjs", import.meta.url),
            {
              ...options,
              workerData: {
                ...options.workerData,
                archiveTimeoutGate: gate.buffer,
                archiveTimeoutEntry:
                  typeof filename === "string" ? pathToFileURL(filename).href : filename.href,
              },
            },
          );
          return archive;
        });
      const run = () => archiveWorker.materializeSessionStateDeletePlans([plan]);
      let expire: (() => void) | undefined;
      let retireGrace: (() => void) | undefined;
      using recovery = vi
        .spyOn(processRespawn, "requestGatewayNativeWorkerRecovery")
        .mockResolvedValue({
          status: "report-only",
          reason: "Synthetic test has no Gateway process lifecycle.",
        });
      const schedule = globalThis.setTimeout;
      using deadline = vi
        .spyOn(globalThis, "setTimeout")
        .mockImplementation((callback, delay, ...args) => {
          if (delay === 180_000) {
            expire = () => callback(...args);
          } else if (delay === 5_000) {
            retireGrace = () => callback(...args);
          }
          return schedule(callback, delay, ...args);
        });
      const active =
        mode === "scoped"
          ? withArchiveSession({ agentId: "main", path: database.path, env: testState.env }, run)
          : run();
      const outcome = Promise.allSettled([active]);
      let following: Promise<void> | undefined;
      try {
        await Promise.race([
          Atomics.waitAsync(gate, 0, 0).value,
          active.then(() => {
            throw new Error("Archive completed before entering the flush gate");
          }),
        ]);
        if (!archive) {
          throw new Error("expected an archive worker");
        }
        const native = archive;
        const nativeTerminate = native.terminate.bind(native);
        const retirement = createDeferred<number>();
        using terminate = vi.spyOn(native, "terminate").mockReturnValue(retirement.promise);
        const next = vi.fn(async () => {
          expect(native.threadId).toBe(-1);
        });
        following = withArchiveWorker(next);
        expect(terminate).not.toHaveBeenCalled();
        expect(next).not.toHaveBeenCalled();
        if (!expire) {
          throw new Error("Archive operation has no settlement deadline");
        }
        expire();
        expect(terminate).toHaveBeenCalledOnce();
        expect(recovery).not.toHaveBeenCalled();
        expect(native.threadId).toBeGreaterThan(0);
        expect(next).not.toHaveBeenCalled();
        expect(
          fs.readdirSync(path.dirname(storePath)).some((entry) => entry.includes("stage")),
        ).toBe(true);
        if (!retireGrace) {
          throw new Error("Archive retirement has no recovery grace");
        }
        retireGrace();
        await vi.dynamicImportSettled();
        expect(recovery).toHaveBeenCalledOnce();
        const request = recovery.mock.calls[0]![0];
        expect(request.isCurrent()).toBe(true);
        expect(next).not.toHaveBeenCalled();
        retirement.resolve(await nativeTerminate());
        await expect(active).rejects.toMatchObject({ code: "timeout" });
        await following;
        expect(native.threadId).toBe(-1);
        expect(request.isCurrent()).toBe(false);
        expect(
          fs.readdirSync(path.dirname(storePath)).filter((entry) => entry.includes("stage")),
        ).toEqual([]);
        await expectSession(scope, event);
      } finally {
        deadline.mockRestore();
        Atomics.store(gate, 1, 1);
        Atomics.notify(gate, 1);
        if (archive && archive.threadId !== -1) {
          await archive.terminate();
        }
        await Promise.allSettled([outcome, following]);
      }
      createWorker.mockRestore();
      const recovered = await deleteArchivedSession(scope.sessionKey);
      expectArchivedEvent(recovered.archivedTranscripts[0]?.archivedPath, event);
    },
    30_000,
  );

  it.each([false, true])(
    "retires idle archive execution before cold restoration (open scope: %s)",
    async (keepScopeOpen) => {
      const fixture = await createSessionColdStorageFixture(
        openLifecycleTestDatabase(storePath).path,
      );
      const original = fixture.snapshot();
      const carriers: Worker[] = [];
      const createWorker = vi.mocked(workerCpu.createCpuTrackedWorker).getMockImplementation();
      if (!createWorker) {
        throw new Error("Expected the suite's SQLite worker fault wrapper");
      }
      let finishClose: (() => void) | undefined;
      vi.spyOn(workerCpu, "createCpuTrackedWorker").mockImplementation((...args) => {
        const worker = createWorker(...args);
        if (args[1]?.workerData?.operation === "archive-session") {
          const previous = carriers[0];
          if (previous) {
            expect(previous.threadId).toBe(-1);
          }
          carriers.push(worker);
        }
        return worker;
      });
      const exercise = async () => {
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
        try {
          await runSessionColdStorageMaintenance({
            config: maintenanceConfig(fixture.scope.storePath),
          });
          expect(carriers).toHaveLength(1);
          const carrier = expectDefined(carriers[0], "initial archive carrier");
          const leases = () =>
            openOpenClawStateDatabase()
              .db.prepare(
                "SELECT lease_id FROM agent_database_leases WHERE path = ? ORDER BY lease_id",
              )
              .all(fixture.options.path);
          const baselineLeases = leases();
          const postMessage = carrier.postMessage.bind(carrier);
          vi.spyOn(carrier, "postMessage").mockImplementation((...args) => {
            if (isRecord(args[0]) && args[0].type === "close") {
              finishClose = () => postMessage(...args);
              return;
            }
            postMessage(...args);
          });
          await vi.advanceTimersByTimeAsync(5 * 60_000 - 1);
          expect(carrier.threadId).toBeGreaterThan(0);
          // Empty scope preparation is not archive activity and cannot renew its deadline.
          await archiveSession.withSqliteTranscriptArchiveSession(fixture.options, async () => {});
          await vi.advanceTimersByTimeAsync(1);
          expect(finishClose).toBeTypeOf("function");
          const entered = createDeferred();
          const mutate = archiveSession.runScopedSqliteArchiveMutation;
          vi.spyOn(archiveSession, "runScopedSqliteArchiveMutation").mockImplementation(
            (...args) => {
              const result = mutate(...args);
              entered.resolve();
              return result;
            },
          );
          const restored = loadTranscriptEvents(fixture.scope);
          await entered.promise;
          expect(carriers).toHaveLength(1);
          const exited = once(carrier, "exit");
          finishClose?.();
          finishClose = undefined;
          await exited;
          expect(await restored).toHaveLength(3);
          expect(carriers).toHaveLength(2);
          expect(leases()).toEqual(baselineLeases);
          expect(fixture.snapshot()).toEqual(original);
          const replacement = expectDefined(carriers[1], "replacement archive carrier");
          const replacementExited = once(replacement, "exit");
          await vi.advanceTimersByTimeAsync(5 * 60_000);
          await replacementExited;
          expect(replacement.threadId).toBe(-1);
          expect(leases()).toEqual(baselineLeases);
        } finally {
          finishClose?.();
          vi.useRealTimers();
        }
      };
      if (keepScopeOpen) {
        await archiveSession.withSqliteTranscriptArchiveSession(fixture.options, exercise);
      } else {
        await exercise();
      }
    },
  );

  it("reads fresh pending archives without waiting for reclamation or writer admission", async ({
    signal,
  }) => {
    const database = openLifecycleTestDatabase(storePath);
    const options = { agentId: "main", path: database.path, env: testState.env };
    const archiveEntered = createDeferred();
    const writerEntered = createDeferred();
    const release = createDeferred();
    const peer = new (requireNodeSqlite().DatabaseSync)(database.path);
    const archive = withArchiveWorker(async () => {
      archiveEntered.resolve();
      await release.promise;
    });
    const writer = writeAdmission.runOpenClawAgentWriteAdmission(options, async () => {
      writerEntered.resolve();
      await release.promise;
    });
    try {
      await Promise.all([archiveEntered.promise, writerEntered.promise]);
      const readPending = () =>
        withArchiveSession(options, () =>
          archiveWorker.readPendingSqliteTranscriptArchivesInWorker(
            { agentId: "main", databasePath: database.path, env: testState.env },
            signal,
          ),
        );
      await expect(readPending()).resolves.toBe(false);
      peer
        .prepare(
          "INSERT INTO session_transcript_archives (session_id, generation, session_key, reason, encoding, archive_blob, archive_sha256, archive_name, created_at) VALUES ('deleted-session', 'generation', 'agent:main:deleted-session', 'deleted', 'identity', X'', ?, 'pending.jsonl', 1)",
        )
        .run("0".repeat(64));
      await expect(readPending()).resolves.toBe(true);
      peer.exec("UPDATE session_transcript_archives SET published_at = 2");
      await expect(readPending()).resolves.toBe(false);
    } finally {
      peer.close();
      release.resolve();
      await Promise.allSettled([archive, writer]);
    }
  });

  it("reuses one archive worker across deletion generations and joins it at database close", async () => {
    const sessionKey = "agent:main:durable-delete";
    const sessionIds = ["durable-delete-first", "durable-delete-second", "durable-delete-current"];
    const events = await prepareGenerations(sessionKey, sessionIds, "你好 🦞\narchive");
    const database = openLifecycleTestDatabase(storePath);
    const publicationRows: unknown[] = [];
    using archiveWorkers = observeArchiveSessionWorkers((message) => {
      if (message.type === "published") {
        for (const result of message.results) {
          publicationRows.push(archiveRow(result.sessionId, "session_key"));
        }
      }
    });

    const result = await deleteArchivedSession(sessionKey);

    archiveWorkers.expectReused(3);
    expect(publicationRows).toEqual(sessionIds.map(() => ({ session_key: sessionKey })));
    expect(result.deleted).toBe(true);
    expect(result.archivedTranscripts).toHaveLength(sessionIds.length);
    for (const [index, sessionId] of sessionIds.entries()) {
      const archive = result.archivedTranscripts.find((entry) => entry.sessionId === sessionId);
      expectArchivedEvent(archive?.archivedPath, events[index]);
      await expect(loadTranscriptEvents({ sessionKey, sessionId, storePath })).resolves.toEqual([]);
    }
    expect(loadSessionEntry({ sessionKey, storePath })).toBeUndefined();
    expect(
      database.db
        .prepare(
          "SELECT session_key, published_at FROM session_transcript_archives ORDER BY session_id",
        )
        .all(),
    ).toEqual(
      sessionIds.map(() => ({ published_at: expect.any(Number), session_key: sessionKey })),
    );
    await closeAgentDatabase(database.path);
    archiveWorkers.expectJoined(1);
  });

  it("publishes archive metadata off the main thread even inside a native deletion scope", async () => {
    const { sessionId, sessionKey, database, event } = await prepareSession(
      "native-scope-publication",
    );
    const deleted = await deleteArchivedSession(sessionKey);
    vi.spyOn(sessionDeletion, "hasPreparedNativeSessionDeletion").mockReturnValue(true);
    using statements = vi.spyOn(database.db, "prepare");
    await expect(
      archiveStore.publishSessionStateArchives(
        { agentId: "main", path: database.path, env: testState.env },
        deleted.archivedTranscripts,
      ),
    ).resolves.toEqual(deleted.archivedTranscripts);
    expect(
      statements.mock.calls.filter(([query]) =>
        /\b(?:update|insert into)\s+"?session_transcript_archives\b/iu.test(query),
      ),
    ).toEqual([]);
    expectArchivedEvent(deleted.archivedTranscripts[0]?.archivedPath, event);
    expect(archiveRow(sessionId, "publish_attempts")).toEqual({ publish_attempts: 2 });
  });

  it("joins a failed publisher and recovers its committed archive after result recording fails", async () => {
    const sessionKey = "agent:main:scoped-publish-failure";
    const sessionIds = ["scoped-publish-history", "scoped-publish-current"] as const;
    const events = await prepareGenerations(sessionKey, sessionIds, "recover exact bytes");
    let collisionPath: string | undefined;
    using archiveWorkers = observeArchiveSessionWorkers((message) => {
      if (message.type === "done" && !collisionPath) {
        const archiveName = message.results[0]?.archive?.archiveName;
        if (archiveName) {
          collisionPath = path.join(path.dirname(storePath), archiveName);
          fs.writeFileSync(collisionPath, "conflicting derived file");
        }
      }
    });
    await expect(deleteArchivedSession(sessionKey)).rejects.toThrow(
      "transcript archive file export(s) remain pending in SQLite",
    );

    expect(archiveWorkers.replies.map(({ message }) => message.type)).toEqual([
      "done",
      "published",
    ]);
    archiveWorkers.expectJoined(1);
    expect(loadSessionEntry({ sessionKey, storePath })).toMatchObject({ sessionId: sessionIds[1] });
    const historicalScope = { sessionKey, sessionId: sessionIds[0], storePath };
    await expect(loadTranscriptEvents(historicalScope)).resolves.toEqual([]);
    await expectSession({ sessionKey, sessionId: sessionIds[1], storePath }, events[1]);
    expect(archiveRow(sessionIds[0], "published_at, last_publish_error")).toEqual({
      published_at: null,
      last_publish_error: expect.stringContaining("collision"),
    });
    expect(collisionPath).toBeDefined();
    fs.rmSync(collisionPath!);
    const readPending = () =>
      archiveRow(
        sessionIds[0],
        "published_at, last_publish_attempt_at, last_publish_error, publish_attempts",
      );
    const pending = readPending();
    fault.enable();
    try {
      await expect(deleteArchivedSession(sessionKey)).rejects.toThrow(
        "synthetic archive result recording failure",
      );
      expectArchivedEvent(collisionPath, events[0]);
      expect(readPending()).toEqual(pending);
      await expect(loadTranscriptEvents(historicalScope)).resolves.toEqual([]);
    } finally {
      fault.disable();
    }

    await expect(deleteArchivedSession(sessionKey)).resolves.toMatchObject({ deleted: false });
    expectArchivedEvent(collisionPath, events[0]);
    expect(archiveRow(sessionIds[0], "published_at, last_publish_error")).toEqual({
      published_at: expect.any(Number),
      last_publish_error: null,
    });
  });

  it.each([false, true])("reuses idle workers across scopes (exited=%s)", async (exited) => {
    testState.envVars.OPENCLAW_SUPERVISOR_MODE = " ExTeRnAl ";
    testState.applyEnv();
    const first = sessionScope("competing-first");
    const second = sessionScope("competing-second", "other");
    const events = [];
    for (const scope of [first, second]) {
      events.push(await seedSession(scope, `bytes for ${scope.sessionId}`));
    }
    await waitForReconciliation(tempDir);
    const publicationEntered = createDeferred();
    const releasePublication = createDeferred();
    const publish = archiveStore.publishSessionStateArchives;
    vi.spyOn(archiveStore, "publishSessionStateArchives").mockImplementation(async (...args) => {
      if (args[1].some(({ sessionId }) => sessionId === first.sessionId)) {
        publicationEntered.resolve();
        await releasePublication.promise;
      }
      return publish(...args);
    });
    const activeWorkersAtReply: number[] = [];
    const observedWorkers = new Set<Worker>();
    using archiveWorkers = observeArchiveSessionWorkers((_message, worker) => {
      observedWorkers.add(worker);
      activeWorkersAtReply.push(
        [...observedWorkers].filter((observed) => observed.threadId !== -1).length,
      );
    });
    const publicationWorkers = new Set<SqliteReclamationWorker>();
    const withWorker = reclamationWorker.withSqliteReclamationWorker;
    vi.spyOn(reclamationWorker, "withSqliteReclamationWorker").mockImplementation(
      (options, claim, run, assertCurrent, signal) =>
        withWorker(
          options,
          claim,
          (worker) => {
            publicationWorkers.add(worker);
            return run(worker);
          },
          assertCurrent,
          signal,
        ),
    );
    const deleteScope = (scope: typeof first) =>
      deleteArchivedSession(scope.sessionKey, scope.storePath);
    const firstDeletion = deleteScope(first);
    let secondDeletion: ReturnType<typeof deleteScope> | undefined;
    const successorRoot = path.join(tempDir, "ambient-successor");
    try {
      await awaitGateBeforeSettlement(
        publicationEntered.promise,
        firstDeletion,
        "first deletion skipped publication",
      );
      const firstWorker = archiveWorkers.replies[0]?.worker;
      expect(firstWorker?.threadId).toBeGreaterThan(0);
      if (exited) {
        await firstWorker!.terminate();
      }
      secondDeletion = deleteScope(second);
      const secondResult = await secondDeletion;
      expect(firstWorker?.threadId === -1).toBe(exited);
      expectArchivedEvent(secondResult.archivedTranscripts[0]?.archivedPath, events[1]);

      // Require fresh publication admission after the earlier deletion work has settled.
      for (const worker of publicationWorkers) {
        await worker.close();
      }
      claimOpenClawStateOwnership("archive-publication-supervisor", {
        env: { OPENCLAW_STATE_DIR: tempDir, OPENCLAW_SUPERVISOR_MODE: "external" },
      });
      vi.stubEnv("OPENCLAW_STATE_DIR", successorRoot);
      vi.stubEnv("OPENCLAW_SUPERVISOR_MODE", undefined);
      releasePublication.resolve();
      const firstResult = await firstDeletion;
      expectArchivedEvent(firstResult.archivedTranscripts[0]?.archivedPath, events[0]);
      expect(fs.existsSync(path.join(successorRoot, "state", "openclaw.sqlite"))).toBe(false);
      expect(
        archiveWorkers.replies.map(({ message }) => [message.type, message.results[0]?.sessionId]),
      ).toEqual([
        ["done", first.sessionId],
        ["done", second.sessionId],
        ["published", second.sessionId],
        ["published", first.sessionId],
      ]);
      expect(observedWorkers.size).toBe(exited ? 2 : 1);
      expect(activeWorkersAtReply).toEqual([1, 1, 1, 1]);
      await closeOpenClawAgentDatabasesAsync(tempDir);
      archiveWorkers.expectJoined(exited ? 2 : 1);
    } finally {
      releasePublication.resolve();
      await Promise.allSettled([firstDeletion, secondDeletion]);
      vi.unstubAllEnvs();
    }
    await expectSession(first);
    await expectSession(second);
  });

  it("retires queued archive work without waiting on the blocked global FIFO", async ({
    signal,
  }) => {
    const { sessionId, sessionKey, scope, event, database } =
      await prepareSession("queued-retirement");
    const blockerEntered = createDeferred();
    const releaseBlocker = createDeferred();
    const materializationQueued = createDeferred();
    let blocker: Promise<void> | undefined;
    const prepare = reclamation.runSessionDeletionPlanning;
    vi.spyOn(reclamation, "runSessionDeletionPlanning").mockImplementationOnce(async (...args) => {
      const result = await prepare(...args);
      if (result.operation !== "entry" || result.value.kind !== "ready") {
        throw new Error("Expected entry planning before blocking archive materialization");
      }
      expect(result.value.value.targetSnapshot).toMatchObject([
        { sessionKey, entry: { sessionId } },
      ]);
      blocker = withArchiveWorker(async () => {
        blockerEntered.resolve();
        await releaseBlocker.promise;
      });
      await blockerEntered.promise;
      return result;
    });
    const materialize = archiveWorker.materializeSessionStateDeletePlans;
    vi.spyOn(archiveWorker, "materializeSessionStateDeletePlans").mockImplementation((...args) => {
      const operation = materialize(...args);
      materializationQueued.resolve();
      return operation;
    });
    using archiveWorkers = observeArchiveSessionWorkers();
    const deletion = deleteArchivedSession(sessionKey);
    let retirement: Promise<boolean> | undefined;
    try {
      await withinTest(
        awaitGateBeforeSettlement(
          materializationQueued.promise,
          deletion,
          "deletion skipped archive materialization",
        ),
        signal,
      );
      retirement = closeAgentDatabase(database.path);
      await withinTest(retirement, signal);
      expect(archiveWorkers.replies).toEqual([]);
      releaseBlocker.resolve();
      await expect(deletion).rejects.toThrow(/revok/i);
      expect(archiveWorkers.replies).toEqual([]);
    } finally {
      releaseBlocker.resolve();
      await Promise.allSettled([blocker, deletion, retirement]);
    }
    await expectSession(scope, event);
  });

  it.each(["done", "published"] as const)(
    "joins scoped archive %s before database close and refuses later scope work",
    async (boundary) => {
      const { sessionKey, scope, event, database } = await prepareSession("scoped-retirement");
      let retirement: Promise<boolean> | undefined;
      let nativeExitAtRetirement = false;
      using archiveWorkers = observeArchiveSessionWorkers((message, worker) => {
        if (message.type === boundary && !retirement) {
          retirement = runInDetachedAsyncContext(() => closeAgentDatabase(database.path)).then(
            (closed) => {
              nativeExitAtRetirement = worker.threadId === -1;
              return closed;
            },
          );
        }
      });
      await expect(deleteArchivedSession(sessionKey)).rejects.toThrow(/clos|retir|revok/i);
      expect(retirement).toBeDefined();
      await retirement;

      expect(nativeExitAtRetirement).toBe(true);
      expect(archiveWorkers.replies.map(({ message }) => message.type)).toEqual(
        boundary === "done" ? ["done"] : ["done", "published"],
      );
      await expectSession(scope, boundary === "done" ? event : undefined);
      await expect(deleteArchivedSession(sessionKey)).resolves.toMatchObject({
        deleted: boundary === "done",
      });
    },
  );

  it.for([
    { phase: "file", owner: "agent" },
    { phase: "prepare", owner: "agent" },
    { phase: "record", owner: "state" },
  ] as const)(
    "cancels queued $phase publication when its $owner closes",
    async ({ phase, owner }, { signal }) => {
      const { sessionKey, database } = await prepareSession("queued-publication");
      const queued = createDeferred();
      const release = createDeferred();
      let blocker: Promise<void> | undefined;
      const blockBefore = <T>(run: () => Promise<T>) => {
        blocker = withArchiveWorker(() => release.promise);
        const pending = run();
        queued.resolve();
        return pending;
      };
      const publish = archiveWorker.runSqliteTranscriptArchivePublishWorker;
      vi.spyOn(archiveWorker, "runSqliteTranscriptArchivePublishWorker").mockImplementation(
        (...args) => (phase === "file" ? blockBefore(() => publish(...args)) : publish(...args)),
      );
      const publicationPhase = new AsyncLocalStorage<{ operations: number }>();
      const publishMetadata = archivePublication.publishSessionStateArchivesInWorker;
      vi.spyOn(archivePublication, "publishSessionStateArchivesInWorker").mockImplementation(
        (params) => publicationPhase.run({ operations: 0 }, () => publishMetadata(params)),
      );
      const withWorker = sessionWorker.withSessionEntryWorker;
      vi.spyOn(sessionWorker, "withSessionEntryWorker").mockImplementation((...args) => {
        const publication = publicationPhase.getStore();
        const operation = publication ? publication.operations++ : undefined;
        if ((phase === "prepare" && operation === 0) || (phase === "record" && operation === 1)) {
          blocker = writeAdmission.runOpenClawAgentWriteAdmission(
            { agentId: "main", path: database.path, env: testState.env },
            () => release.promise,
          );
          const pending = withWorker(...args);
          queued.resolve();
          return pending;
        }
        return withWorker(...args);
      });
      const publication = deleteArchivedSession(sessionKey);
      const observed = publication.then(
        () => undefined,
        (error: unknown) => error,
      );
      let close: Promise<boolean> | undefined;
      try {
        await withinTest(
          awaitGateBeforeSettlement(queued.promise, publication, "Publication skipped its queue"),
          signal,
        );
        close =
          owner === "agent"
            ? closeAgentDatabase(database.path)
            : closeOpenClawStateDatabaseByPathAsync(resolveOpenClawStateSqlitePath(testState.env));
        expect(await withinTest(observed, signal)).toMatchObject({
          message: expect.stringMatching(/revok/i),
        });
        // Native close also drains WAL work on this database's writer queue.
        // Publication cancellation must settle before that unrelated blocker releases.
        if (phase !== "file") {
          release.resolve();
        }
        await withinTest(close, signal);
      } finally {
        release.resolve();
        await Promise.allSettled([publication, blocker, close]);
      }
    },
  );

  it.each(["path", "agent"] as const)(
    "refuses a prepared archive reply with a different physical %s owner",
    async (changed) => {
      const { sessionId, sessionKey } = await prepareSession("archive-reply-owner");
      const otherPath = path.join(tempDir, "different-owner.sqlite");
      let changedPlans = 0;
      observeArchiveMetadata(async (operation, result) => {
        if (operation === "session.archives.preparePublication" && Array.isArray(result)) {
          for (const plan of result) {
            if (isRecord(plan) && plan.sessionId === sessionId) {
              changedPlans += 1;
              if (changed === "path") {
                plan.databasePath = otherPath;
              } else {
                plan.agentId = "other";
              }
            }
          }
        }
      });
      using workers = observeArchiveSessionWorkers();
      await expect(deleteArchivedSession(sessionKey)).rejects.toThrow(/database owner/);
      expect(changedPlans).toBe(1);
      expect(workers.replies.map(({ message }) => message.type)).toEqual(["done"]);
      workers.expectJoined(1);
      const archive = archiveRow(sessionId, "archive_name, published_at, publish_attempts");
      expect(archive).toMatchObject({ published_at: null, publish_attempts: 0 });
      if (typeof archive?.archive_name !== "string") {
        throw new Error("Expected the original committed archive row");
      }
      expect(fs.existsSync(path.join(path.dirname(storePath), archive.archive_name))).toBe(false);
      expect(fs.existsSync(otherPath)).toBe(false);
    },
  );

  it.runIf(process.platform !== "win32").each(["before file", "before record"] as const)(
    "refuses a physical database replacement %s without publishing to its successor",
    async (boundary) => {
      const { sessionId, sessionKey, database } = await prepareSession("replaced-archive-owner");
      const replacementPath = path.join(tempDir, "replacement.sqlite");
      const replacement = openOpenClawAgentDatabase({
        agentId: "main",
        path: replacementPath,
        env: testState.env,
      });
      replacement.db.exec(
        "CREATE TABLE successor_marker (value TEXT); INSERT INTO successor_marker VALUES ('untouched');",
      );
      await closeAgentDatabase(replacementPath);
      const replacementBytes = fs.readFileSync(replacementPath);
      const entered = createDeferred();
      const release = createDeferred();
      let paused = false;
      const pause = async () => {
        if (!paused) {
          paused = true;
          entered.resolve();
          await release.promise;
        }
      };
      observeArchiveMetadata(async (operation, result) => {
        if (
          boundary === "before file" &&
          operation === "session.archives.preparePublication" &&
          Array.isArray(result) &&
          result.some((plan) => isRecord(plan) && plan.sessionId === sessionId)
        ) {
          await pause();
        }
      });
      const publish = archiveWorker.runSqliteTranscriptArchivePublishWorker;
      vi.spyOn(archiveWorker, "runSqliteTranscriptArchivePublishWorker").mockImplementation(
        async (...args) => {
          const [plans] = args;
          const result = await publish(...args);
          if (boundary === "before record" && plans.some((plan) => plan.sessionId === sessionId)) {
            await pause();
          }
          return result;
        },
      );
      const deletion = deleteArchivedSession(sessionKey);
      const heldPath = `${database.path}.held`;
      let replaced = false;
      try {
        await awaitGateBeforeSettlement(
          entered.promise,
          deletion,
          "Deletion skipped the publication gate",
        );
        fs.renameSync(database.path, heldPath);
        fs.renameSync(replacementPath, database.path);
        replaced = true;
        release.resolve();
        await expect(deletion).rejects.toThrow(/replaced|file identity changed/);
        expect(fs.readFileSync(database.path)).toEqual(replacementBytes);
      } finally {
        release.resolve();
        await Promise.allSettled([deletion]);
        if (replaced) {
          fs.renameSync(database.path, replacementPath);
          fs.renameSync(heldPath, database.path);
        }
      }
      expect(archiveRow(sessionId, "published_at")).toEqual({ published_at: null });
      using successor = new (requireNodeSqlite().DatabaseSync)(replacementPath, { readOnly: true });
      expect(successor.prepare("SELECT value FROM successor_marker").all()).toEqual([
        { value: "untouched" },
      ]);
      expect(successor.prepare("SELECT session_id FROM session_transcript_archives").all()).toEqual(
        [],
      );
    },
  );

  it.each([false, true])(
    "does not create cold empty publication state (database exists: %s)",
    async (exists) => {
      const target = resolveSqliteTargetFromSessionStorePath(storePath);
      const options = { agentId: target.agentId ?? "main", path: target.path, env: testState.env };
      if (exists) {
        const database = openOpenClawAgentDatabase(options);
        database.db.exec("DROP TABLE session_transcript_archives");
        await closeAgentDatabase(database.path);
      }
      if (!target.path) {
        throw new Error("Expected a durable archive target");
      }
      await expect(archiveStore.publishSessionStateArchives(options, [])).resolves.toEqual([]);
      expect(getOpenClawAgentDatabaseIfOpen(options)).toBeUndefined();
      expect(fs.existsSync(target.path)).toBe(exists);
      if (exists) {
        using peer = new (requireNodeSqlite().DatabaseSync)(target.path, { readOnly: true });
        expect(
          peer
            .prepare("SELECT name FROM sqlite_schema WHERE name = 'session_transcript_archives'")
            .all(),
        ).toEqual([]);
      }
    },
  );
});

type ArchiveSessionReply = TranscriptArchiveWorkerMessage | TranscriptArchivePublishWorkerMessage;

function observeArchiveMetadata(afterExecute: (type: string, result: unknown) => Promise<void>) {
  const withWorker = sessionWorker.withSessionEntryWorker;
  return vi.spyOn(sessionWorker, "withSessionEntryWorker").mockImplementation((...args) => {
    const withExecution = args[3];
    args[3] = (execution, owner, context) =>
      withExecution(
        {
          ...execution,
          get fileIdentity() {
            return execution.fileIdentity;
          },
          runExisting(readSource, read, readOptions) {
            return execution.runExisting(
              readSource,
              (worker) =>
                read({
                  execute: async (command, requestOptions) => {
                    const result = await worker.execute(command, requestOptions);
                    await afterExecute(command.type, result);
                    return result;
                  },
                }),
              readOptions,
            );
          },
        },
        owner,
        context,
      );
    return withWorker(...args);
  });
}

function observeArchiveSessionWorkers(
  onReply?: (message: ArchiveSessionReply, worker: Worker) => void,
) {
  const replies: Array<{ message: ArchiveSessionReply; worker: Worker }> = [];
  const observeWorker = (worker: Worker) => {
    worker.on("message", (message: ArchiveSessionReply | null | undefined) => {
      if (
        message &&
        (message.type === "done" || message.type === "published") &&
        Array.isArray(message.results)
      ) {
        replies.push({ message, worker });
        onReply?.(message, worker);
      }
    });
  };
  process.on("worker", observeWorker);
  return {
    replies,
    expectReused(count: number) {
      expect(replies.map(({ message }) => message.type)).toEqual(
        Array.from({ length: count }, () => ["done", "published"]).flat(),
      );
      expect(new Set(replies.map(({ worker }) => worker)).size).toBe(1);
      expect(replies.every(({ worker }) => worker.threadId > 0)).toBe(true);
    },
    expectJoined(count: number) {
      const workers = new Set(replies.map(({ worker }) => worker));
      expect(workers.size).toBe(count);
      expect([...workers].every((worker) => worker.threadId === -1)).toBe(true);
    },
    [Symbol.dispose]() {
      process.off("worker", observeWorker);
    },
  };
}

function openLifecycleTestDatabase(storePath: string) {
  const target = resolveSqliteTargetFromSessionStorePath(storePath);
  if (!target.path) {
    throw new Error(`Could not resolve SQLite database path for ${storePath}`);
  }
  return openOpenClawAgentDatabase({ agentId: target.agentId ?? "main", path: target.path });
}
