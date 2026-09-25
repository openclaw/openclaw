import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs";
import path from "node:path";
import type { Worker } from "node:worker_threads";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred, withTestTimeout } from "../../../test/helpers/promise.js";
import { requireNodeSqlite } from "../../infra/node-sqlite.js";
import * as readonlyDatabase from "../../state/openclaw-agent-db-readonly.js";
import {
  closeOpenClawAgentDatabaseByPathAsync,
  closeOpenClawAgentDatabasesAsync,
  openOpenClawAgentDatabase,
  getOpenClawAgentDatabaseIfOpen,
} from "../../state/openclaw-agent-db.js";
import * as writeAdmission from "../../state/openclaw-agent-write-admission.js";
import { closeOpenClawStateDatabaseByPathAsync } from "../../state/openclaw-state-db-cache.js";
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
import { publishSessionStateArchives } from "./session-accessor.sqlite-archive-store.js";
import type {
  TranscriptArchivePublishWorkerMessage,
  TranscriptArchiveWorkerMessage,
} from "./session-accessor.sqlite-archive-types.js";
import * as archiveWorker from "./session-accessor.sqlite-archive.js";
import { runExclusiveSqliteTranscriptArchiveWorker } from "./session-accessor.sqlite-archive.js";
import * as reclamationWorker from "./session-accessor.sqlite-reclamation-worker.js";
import * as reclamation from "./session-accessor.sqlite-reclamation.js";
import { replaceTranscriptEvents } from "./session-accessor.sqlite-transcript-write.js";
import { resolveSqliteTargetFromSessionStorePath } from "./session-sqlite-target.js";
import { waitForSessionTranscriptIndexReconcilesInStateDir } from "./session-transcript-reconcile.js";

const archiveScopeHooks = vi.hoisted(() => ({
  afterMaterializeQueued: undefined as (() => void) | undefined,
  beforePublish: undefined as ((sessionIds: string[]) => Promise<void>) | undefined,
}));

vi.mock("./session-accessor.sqlite-archive.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./session-accessor.sqlite-archive.js")>();
  return {
    ...actual,
    materializeSessionStateDeletePlans: (
      ...args: Parameters<typeof actual.materializeSessionStateDeletePlans>
    ) => {
      const operation = actual.materializeSessionStateDeletePlans(...args);
      archiveScopeHooks.afterMaterializeQueued?.();
      return operation;
    },
  };
});

vi.mock("./session-accessor.sqlite-archive-store.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("./session-accessor.sqlite-archive-store.js")>();
  return {
    ...actual,
    publishSessionStateArchives: async (
      ...args: Parameters<typeof actual.publishSessionStateArchives>
    ) => {
      if (archiveScopeHooks.beforePublish) {
        await archiveScopeHooks.beforePublish(args[1].map((archive) => archive.sessionId));
      }
      return actual.publishSessionStateArchives(...args);
    },
  };
});

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
    archiveScopeHooks.afterMaterializeQueued = undefined;
    archiveScopeHooks.beforePublish = undefined;
    vi.unstubAllEnvs();
    await waitForSessionTranscriptIndexReconcilesInStateDir(tempDir);
    await closeOpenClawAgentDatabasesAsync(tempDir);
    await testState.cleanup();
  });

  it("reuses one archive worker across deletion generations and joins it before returning", async () => {
    const sessionKey = "agent:main:durable-delete";
    const sessionIds = ["durable-delete-first", "durable-delete-second", "durable-delete-current"];
    const events = sessionIds.map((sessionId) =>
      createTranscriptEvent(sessionId, "你好 🦞\narchive"),
    );
    for (const [index, sessionId] of sessionIds.entries()) {
      await replaceSessionEntry({ sessionKey, storePath }, { sessionId, updatedAt: index + 1 });
      await replaceTranscriptEvents({ sessionKey, sessionId, storePath }, [events[index]!]);
    }
    await waitForSessionTranscriptIndexReconcilesInStateDir(tempDir);
    const database = openLifecycleTestDatabase(storePath);
    const publicationRows: unknown[] = [];
    const archiveWorkers = observeArchiveSessionWorkers((message) => {
      if (message.type === "published") {
        for (const result of message.results) {
          publicationRows.push(
            database.db
              .prepare("SELECT session_key FROM session_transcript_archives WHERE session_id = ?")
              .get(result.sessionId),
          );
        }
      }
    });

    let result: Awaited<ReturnType<typeof deleteSessionEntryLifecycle>>;
    try {
      result = await deleteSessionEntryLifecycle({
        archiveTranscript: true,
        storePath,
        target: { canonicalKey: sessionKey, storeKeys: [sessionKey] },
      });
    } finally {
      archiveWorkers.stop();
    }

    expect(archiveWorkers.replies.map(({ message }) => message.type)).toEqual([
      "done",
      "published",
      "done",
      "published",
      "done",
      "published",
    ]);
    expect(new Set(archiveWorkers.replies.map(({ worker }) => worker)).size).toBe(1);
    expect(archiveWorkers.replies.every(({ worker }) => worker.threadId === -1)).toBe(true);
    expect(archiveWorkers.replies.every(({ message }) => message.settled === true)).toBe(true);
    const operationIds = archiveWorkers.replies.flatMap(({ message }) =>
      typeof message.operationId === "number" ? [message.operationId] : [],
    );
    expect(operationIds).toHaveLength(archiveWorkers.replies.length);
    expect(new Set(operationIds).size).toBe(operationIds.length);
    expect(operationIds).toEqual([...operationIds].toSorted((a, b) => a - b));
    expect(publicationRows).toEqual(sessionIds.map(() => ({ session_key: sessionKey })));
    expect(result.deleted).toBe(true);
    expect(result.archivedTranscripts).toHaveLength(sessionIds.length);
    for (const [index, sessionId] of sessionIds.entries()) {
      const archive = result.archivedTranscripts.find((entry) => entry.sessionId === sessionId);
      expect(readArchiveLines(archive?.archivedPath)).toEqual([JSON.stringify(events[index])]);
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
  });

  it.each(["file collision", "result recording"] as const)(
    "joins a failed publisher and recovers its committed archive after %s",
    async (failure) => {
      const sessionKey = "agent:main:scoped-publish-failure";
      const sessionIds = ["scoped-publish-history", "scoped-publish-current"] as const;
      const events = sessionIds.map((sessionId) =>
        createTranscriptEvent(sessionId, "recover exact bytes"),
      );
      for (const [index, sessionId] of sessionIds.entries()) {
        await replaceSessionEntry({ sessionKey, storePath }, { sessionId, updatedAt: index + 1 });
        await replaceTranscriptEvents({ sessionKey, sessionId, storePath }, [events[index]!]);
      }
      await waitForSessionTranscriptIndexReconcilesInStateDir(tempDir);
      let collisionPath: string | undefined;
      const archiveWorkers = observeArchiveSessionWorkers((message) => {
        if (message.type === "done" && !collisionPath) {
          const archiveName = message.results[0]?.archive?.archiveName;
          if (archiveName) {
            collisionPath = path.join(path.dirname(storePath), archiveName);
            fs.writeFileSync(collisionPath, "conflicting derived file");
          }
        }
      });
      const deletionParams = {
        archiveTranscript: true,
        storePath,
        target: { canonicalKey: sessionKey, storeKeys: [sessionKey] },
      };
      try {
        await expect(deleteSessionEntryLifecycle(deletionParams)).rejects.toThrow(
          "transcript archive file export(s) remain pending in SQLite",
        );
      } finally {
        archiveWorkers.stop();
      }

      expect(archiveWorkers.replies.map(({ message }) => message.type)).toEqual([
        "done",
        "published",
      ]);
      expect(new Set(archiveWorkers.replies.map(({ worker }) => worker)).size).toBe(1);
      expect(archiveWorkers.replies.every(({ worker }) => worker.threadId === -1)).toBe(true);
      expect(loadSessionEntry({ sessionKey, storePath })).toMatchObject({
        sessionId: sessionIds[1],
      });
      await expect(
        loadTranscriptEvents({ sessionKey, sessionId: sessionIds[0], storePath }),
      ).resolves.toEqual([]);
      await expect(
        loadTranscriptEvents({ sessionKey, sessionId: sessionIds[1], storePath }),
      ).resolves.toEqual([events[1]]);
      expect(
        openLifecycleTestDatabase(storePath)
          .db.prepare(
            "SELECT published_at, last_publish_error FROM session_transcript_archives WHERE session_id = ?",
          )
          .get(sessionIds[0]!),
      ).toEqual({ published_at: null, last_publish_error: expect.stringContaining("collision") });
      expect(collisionPath).toBeDefined();
      fs.rmSync(collisionPath!);
      if (failure === "result recording") {
        const database = openLifecycleTestDatabase(storePath);
        const readPending = () =>
          database.db
            .prepare(
              "SELECT published_at, last_publish_attempt_at, last_publish_error, publish_attempts FROM session_transcript_archives WHERE session_id = ?",
            )
            .get(sessionIds[0]);
        const pending = readPending();
        database.db.exec(`
        CREATE TRIGGER refuse_archive_result BEFORE UPDATE OF published_at
        ON session_transcript_archives BEGIN
          SELECT RAISE(ABORT, 'synthetic archive result recording failure');
        END;
      `);
        try {
          await expect(deleteSessionEntryLifecycle(deletionParams)).rejects.toThrow(
            "synthetic archive result recording failure",
          );
          expect(readArchiveLines(collisionPath)).toEqual([JSON.stringify(events[0])]);
          expect(readPending()).toEqual(pending);
          await expect(
            loadTranscriptEvents({ sessionKey, sessionId: sessionIds[0], storePath }),
          ).resolves.toEqual([]);
        } finally {
          database.db.exec("DROP TRIGGER refuse_archive_result");
        }
      }

      await expect(deleteSessionEntryLifecycle(deletionParams)).resolves.toMatchObject({
        deleted: failure === "file collision",
      });
      expect(readArchiveLines(collisionPath)).toEqual([JSON.stringify(events[0])]);
      expect(
        openLifecycleTestDatabase(storePath)
          .db.prepare(
            "SELECT published_at, last_publish_error FROM session_transcript_archives WHERE session_id = ?",
          )
          .get(sessionIds[0]!),
      ).toEqual({ published_at: expect.any(Number), last_publish_error: null });
    },
  );

  it("retires competing archive scopes and publishes with the originally captured environment", async () => {
    testState.envVars.OPENCLAW_SUPERVISOR_MODE = " ExTeRnAl ";
    testState.applyEnv();
    const first = {
      sessionId: "competing-first",
      sessionKey: "agent:main:competing-first",
      storePath,
    };
    const second = {
      sessionId: "competing-second",
      sessionKey: "agent:other:competing-second",
      storePath: path.join(tempDir, "agents", "other", "sessions", "sessions.json"),
    };
    const events = [first, second].map(({ sessionId }) =>
      createTranscriptEvent(sessionId, `bytes for ${sessionId}`),
    );
    for (const [index, scope] of [first, second].entries()) {
      await replaceSessionEntry(scope, { sessionId: scope.sessionId, updatedAt: 1 });
      await replaceTranscriptEvents(scope, [events[index]!]);
    }
    await waitForSessionTranscriptIndexReconcilesInStateDir(tempDir);
    const publicationEntered = createDeferred();
    const releasePublication = createDeferred();
    archiveScopeHooks.beforePublish = async (sessionIds) => {
      if (sessionIds.includes(first.sessionId)) {
        publicationEntered.resolve();
        await releasePublication.promise;
      }
    };
    const activeWorkersAtReply: number[] = [];
    const observedWorkers = new Set<Worker>();
    const archiveWorkers = observeArchiveSessionWorkers((_message, worker) => {
      observedWorkers.add(worker);
      activeWorkersAtReply.push(
        [...observedWorkers].filter((observed) => observed.threadId !== -1).length,
      );
    });
    const publicationWorkers = new Set<reclamationWorker.SqliteReclamationWorker>();
    const withWorker = reclamationWorker.withSqliteReclamationWorker;
    const reclamationObserver = vi
      .spyOn(reclamationWorker, "withSqliteReclamationWorker")
      .mockImplementation((options, claim, run, assertCurrent, signal) =>
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
      deleteSessionEntryLifecycle({
        archiveTranscript: true,
        storePath: scope.storePath,
        target: { canonicalKey: scope.sessionKey, storeKeys: [scope.sessionKey] },
      });
    const firstDeletion = deleteScope(first);
    let secondDeletion: ReturnType<typeof deleteScope> | undefined;
    const successorRoot = path.join(tempDir, "ambient-successor");
    try {
      await Promise.race([
        publicationEntered.promise,
        firstDeletion.then(() => {
          throw new Error("first deletion skipped publication");
        }),
      ]);
      const firstWorker = archiveWorkers.replies[0]?.worker;
      expect(firstWorker?.threadId).toBeGreaterThan(0);
      secondDeletion = deleteScope(second);
      const secondResult = await secondDeletion;
      expect(firstWorker?.threadId).toBe(-1);
      expect(readArchiveLines(secondResult.archivedTranscripts[0]?.archivedPath)).toEqual([
        JSON.stringify(events[1]),
      ]);

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
      expect(readArchiveLines(firstResult.archivedTranscripts[0]?.archivedPath)).toEqual([
        JSON.stringify(events[0]),
      ]);
      expect(fs.existsSync(path.join(successorRoot, "state", "openclaw.sqlite"))).toBe(false);
      expect(
        archiveWorkers.replies.map(({ message }) => [message.type, message.results[0]?.sessionId]),
      ).toEqual([
        ["done", first.sessionId],
        ["done", second.sessionId],
        ["published", second.sessionId],
        ["published", first.sessionId],
      ]);
      expect(observedWorkers.size).toBe(3);
      expect(activeWorkersAtReply).toEqual([1, 1, 1, 1]);
      expect([...observedWorkers].every((worker) => worker.threadId === -1)).toBe(true);
    } finally {
      releasePublication.resolve();
      await Promise.allSettled([firstDeletion, secondDeletion]);
      archiveWorkers.stop();
      reclamationObserver.mockRestore();
      vi.unstubAllEnvs();
    }
    expect(loadSessionEntry(first)).toBeUndefined();
    expect(loadSessionEntry(second)).toBeUndefined();
    await expect(loadTranscriptEvents(first)).resolves.toEqual([]);
    await expect(loadTranscriptEvents(second)).resolves.toEqual([]);
  });

  it("retires queued archive work without waiting on the blocked global FIFO", async () => {
    const sessionId = "queued-retirement";
    const sessionKey = "agent:main:queued-retirement";
    const scope = { sessionKey, sessionId, storePath };
    const event = createTranscriptEvent(sessionId, "do not dispatch after retirement");
    await replaceSessionEntry(scope, { sessionId, updatedAt: 1 });
    await replaceTranscriptEvents(scope, [event]);
    await waitForSessionTranscriptIndexReconcilesInStateDir(tempDir);
    const database = openLifecycleTestDatabase(storePath);
    const blockerEntered = createDeferred();
    const releaseBlocker = createDeferred();
    const materializationQueued = createDeferred();
    const blocker = runExclusiveSqliteTranscriptArchiveWorker(async () => {
      blockerEntered.resolve();
      await releaseBlocker.promise;
    });
    await blockerEntered.promise;
    archiveScopeHooks.afterMaterializeQueued = () => materializationQueued.resolve();
    const archiveWorkers = observeArchiveSessionWorkers();
    const deletion = deleteSessionEntryLifecycle({
      archiveTranscript: true,
      storePath,
      target: { canonicalKey: sessionKey, storeKeys: [sessionKey] },
    });
    let retirement: Promise<boolean> | undefined;
    try {
      await Promise.race([
        materializationQueued.promise,
        deletion.then(() => {
          throw new Error("deletion skipped archive materialization");
        }),
      ]);
      retirement = closeOpenClawAgentDatabaseByPathAsync(database.path);
      await withTestTimeout(retirement, 5_000, "retirement waited on undispatched archive work");
      expect(archiveWorkers.replies).toEqual([]);
      releaseBlocker.resolve();
      await expect(deletion).rejects.toThrow(/revok/i);
      expect(archiveWorkers.replies).toEqual([]);
    } finally {
      releaseBlocker.resolve();
      await Promise.allSettled([blocker, deletion, retirement]);
      archiveWorkers.stop();
    }
    expect(loadSessionEntry(scope)).toMatchObject({ sessionId });
    await expect(loadTranscriptEvents(scope)).resolves.toEqual([event]);
  });

  it.each(["done", "published"] as const)(
    "joins scoped archive %s before database close and refuses later scope work",
    async (boundary) => {
      const sessionId = "scoped-retirement";
      const sessionKey = "agent:main:scoped-retirement";
      const scope = { sessionKey, sessionId, storePath };
      const event = createTranscriptEvent(sessionId, "retain after retirement");
      await replaceSessionEntry(scope, { sessionId, updatedAt: 1 });
      await replaceTranscriptEvents(scope, [event]);
      await waitForSessionTranscriptIndexReconcilesInStateDir(tempDir);
      const database = openLifecycleTestDatabase(storePath);
      let retirement: Promise<boolean> | undefined;
      let nativeExitAtRetirement = false;
      const archiveWorkers = observeArchiveSessionWorkers((message, worker) => {
        if (message.type === boundary && !retirement) {
          retirement = closeOpenClawAgentDatabaseByPathAsync(database.path).then((closed) => {
            nativeExitAtRetirement = worker.threadId === -1;
            return closed;
          });
        }
      });
      const deletionParams = {
        archiveTranscript: true,
        storePath,
        target: { canonicalKey: sessionKey, storeKeys: [sessionKey] },
      };
      try {
        await expect(deleteSessionEntryLifecycle(deletionParams)).rejects.toThrow(
          /clos|retir|revok/i,
        );
        expect(retirement).toBeDefined();
        await retirement;
      } finally {
        archiveWorkers.stop();
      }

      expect(nativeExitAtRetirement).toBe(true);
      expect(archiveWorkers.replies.map(({ message }) => message.type)).toEqual(
        boundary === "done" ? ["done"] : ["done", "published"],
      );
      if (boundary === "done") {
        expect(loadSessionEntry(scope)).toMatchObject({ sessionId });
        await expect(loadTranscriptEvents(scope)).resolves.toEqual([event]);
      } else {
        expect(loadSessionEntry(scope)).toBeUndefined();
        await expect(loadTranscriptEvents(scope)).resolves.toEqual([]);
      }
      await expect(deleteSessionEntryLifecycle(deletionParams)).resolves.toMatchObject({
        deleted: boundary === "done",
      });
    },
  );

  it.each([
    { phase: "pending", owner: "agent" },
    { phase: "pending writer", owner: "agent" },
    { phase: "pending writer", owner: "state" },
    { phase: "file", owner: "agent" },
    { phase: "prepare", owner: "agent" },
    { phase: "record", owner: "agent" },
    { phase: "prepare", owner: "state" },
    { phase: "record", owner: "state" },
  ] as const)(
    "cancels queued $phase publication at $owner close without waiting on another queue owner",
    async ({ phase, owner }) => {
      const sessionId = "queued-publication";
      const sessionKey = "agent:main:queued-publication";
      await replaceSessionEntry({ sessionKey, storePath }, { sessionId, updatedAt: 1 });
      await replaceTranscriptEvents({ sessionKey, sessionId, storePath }, [
        createTranscriptEvent(sessionId, "queued bytes"),
      ]);
      await waitForSessionTranscriptIndexReconcilesInStateDir(tempDir);
      const database = openLifecycleTestDatabase(storePath);
      const options = { agentId: "main", path: database.path, env: testState.env };
      const probesPending = phase === "pending" || phase === "pending writer";
      if (probesPending) {
        await closeOpenClawAgentDatabaseByPathAsync(database.path);
      }
      const queued = createDeferred();
      const release = createDeferred();
      let blocker: Promise<void> | undefined;
      const blockBefore = <T>(run: () => Promise<T>) => {
        blocker = runExclusiveSqliteTranscriptArchiveWorker(() => release.promise);
        const pending = run();
        queued.resolve();
        return pending;
      };
      const writerEntered = createDeferred();
      let pendingReadEntered = false;
      const admit = writeAdmission.runOpenClawAgentWriteAdmission;
      const writerObserver = vi
        .spyOn(writeAdmission, "runOpenClawAgentWriteAdmission")
        .mockImplementation((...args) => {
          if (phase !== "pending writer" || args[0].path !== database.path || blocker) {
            return admit(...args);
          }
          const [writerOptions, run, reentrant, timing, signal] = args;
          blocker = admit(writerOptions, () => {
            writerEntered.resolve();
            return release.promise;
          });
          const pending = admit(
            writerOptions,
            () => {
              pendingReadEntered = true;
              return run();
            },
            reentrant,
            timing,
            signal,
          );
          queued.resolve();
          return pending;
        });
      const probe = archiveWorker.readPendingSqliteTranscriptArchivesInWorker;
      const publish = archiveWorker.runSqliteTranscriptArchivePublishWorker;
      const probeObserver = vi
        .spyOn(archiveWorker, "readPendingSqliteTranscriptArchivesInWorker")
        .mockImplementation((...args) =>
          phase === "pending" ? blockBefore(() => probe(...args)) : probe(...args),
        );
      const publishObserver = vi
        .spyOn(archiveWorker, "runSqliteTranscriptArchivePublishWorker")
        .mockImplementation((...args) =>
          phase === "file" ? blockBefore(() => publish(...args)) : publish(...args),
        );
      const metadataPhase = new AsyncLocalStorage<string>();
      const reclaim = reclamation.runSqliteSessionReclamation;
      const metadataObserver = vi
        .spyOn(reclamation, "runSqliteSessionReclamation")
        .mockImplementation((params) => metadataPhase.run(params.plan.kind, () => reclaim(params)));
      const withWorker = reclamationWorker.withSqliteReclamationWorker;
      const metadataQueueObserver = vi
        .spyOn(reclamationWorker, "withSqliteReclamationWorker")
        .mockImplementation((...args) =>
          (phase === "prepare" || phase === "record") &&
          metadataPhase.getStore() === `archive-publish-${phase}`
            ? blockBefore(() => withWorker(...args))
            : withWorker(...args),
        );
      const publication = probesPending
        ? publishSessionStateArchives(options, [])
        : deleteSessionEntryLifecycle({
            archiveTranscript: true,
            storePath,
            target: { canonicalKey: sessionKey, storeKeys: [sessionKey] },
          });
      const observed = publication.then(
        () => undefined,
        (error: unknown) => error,
      );
      let close: Promise<boolean> | undefined;
      try {
        await Promise.race([
          queued.promise,
          publication.then(() => {
            throw new Error("Publication skipped its queue");
          }),
        ]);
        if (phase === "pending writer") {
          await writerEntered.promise;
          expect(pendingReadEntered).toBe(false);
        }
        close =
          owner === "agent"
            ? closeOpenClawAgentDatabaseByPathAsync(database.path)
            : closeOpenClawStateDatabaseByPathAsync(resolveOpenClawStateSqlitePath(testState.env));
        await withTestTimeout(close, 5_000, "close waited on an unrelated queue owner");
        expect(await observed).toMatchObject({ message: expect.stringMatching(/revok/i) });
      } finally {
        release.resolve();
        await Promise.allSettled([publication, blocker, close]);
        probeObserver.mockRestore();
        publishObserver.mockRestore();
        metadataObserver.mockRestore();
        metadataQueueObserver.mockRestore();
        writerObserver.mockRestore();
      }
      if (phase === "pending writer") {
        expect(pendingReadEntered).toBe(false);
      }
    },
  );

  it.each(["path", "agent"] as const)(
    "refuses a prepared archive reply with a different physical %s owner",
    async (changed) => {
      const sessionId = "archive-reply-owner";
      const sessionKey = "agent:main:archive-reply-owner";
      const scope = { sessionKey, sessionId, storePath };
      await replaceSessionEntry(scope, { sessionId, updatedAt: 1 });
      await replaceTranscriptEvents(scope, [createTranscriptEvent(sessionId, "original archive")]);
      await waitForSessionTranscriptIndexReconcilesInStateDir(tempDir);
      const database = openLifecycleTestDatabase(storePath);
      const otherPath = path.join(tempDir, "different-owner.sqlite");
      const reclaim = reclamation.runSqliteSessionReclamation;
      let changedPlans = 0;
      const prepareObserver = vi
        .spyOn(reclamation, "runSqliteSessionReclamation")
        .mockImplementation(async (params) => {
          const result = await reclaim(params);
          if (result.kind === "archive-publish-prepare") {
            for (const plan of result.value) {
              if (plan.sessionId === sessionId) {
                changedPlans += 1;
                if (changed === "path") {
                  plan.databasePath = otherPath;
                } else {
                  plan.agentId = "other";
                }
              }
            }
          }
          return result;
        });
      const workers = observeArchiveSessionWorkers();
      try {
        await expect(
          deleteSessionEntryLifecycle({
            archiveTranscript: true,
            storePath,
            target: { canonicalKey: sessionKey, storeKeys: [sessionKey] },
          }),
        ).rejects.toThrow(/database owner/);
      } finally {
        prepareObserver.mockRestore();
        workers.stop();
      }
      expect(changedPlans).toBe(1);
      expect(workers.replies.map(({ message }) => message.type)).toEqual(["done"]);
      expect(workers.replies.every(({ worker }) => worker.threadId === -1)).toBe(true);
      const archive = database.db
        .prepare(
          "SELECT archive_name, published_at, publish_attempts FROM session_transcript_archives WHERE session_id = ?",
        )
        .get(sessionId);
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
      const sessionId = "replaced-archive-owner";
      const sessionKey = "agent:main:replaced-archive-owner";
      const scope = { sessionKey, sessionId, storePath };
      await replaceSessionEntry(scope, { sessionId, updatedAt: 1 });
      await replaceTranscriptEvents(scope, [createTranscriptEvent(sessionId, "original source")]);
      await waitForSessionTranscriptIndexReconcilesInStateDir(tempDir);
      const database = openLifecycleTestDatabase(storePath);
      const replacementPath = path.join(tempDir, "replacement.sqlite");
      const replacement = openOpenClawAgentDatabase({
        agentId: "main",
        path: replacementPath,
        env: testState.env,
      });
      replacement.db.exec(
        "CREATE TABLE successor_marker (value TEXT); INSERT INTO successor_marker VALUES ('untouched');",
      );
      await closeOpenClawAgentDatabaseByPathAsync(replacementPath);
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
      const reclaim = reclamation.runSqliteSessionReclamation;
      const prepareObserver = vi
        .spyOn(reclamation, "runSqliteSessionReclamation")
        .mockImplementation(async (params) => {
          const result = await reclaim(params);
          if (
            boundary === "before file" &&
            result.kind === "archive-publish-prepare" &&
            result.value.some((plan) => plan.sessionId === sessionId)
          ) {
            await pause();
          }
          return result;
        });
      const publish = archiveWorker.runSqliteTranscriptArchivePublishWorker;
      const publishObserver = vi
        .spyOn(archiveWorker, "runSqliteTranscriptArchivePublishWorker")
        .mockImplementation(async (...args) => {
          const [plans] = args;
          const result = await publish(...args);
          if (boundary === "before record" && plans.some((plan) => plan.sessionId === sessionId)) {
            await pause();
          }
          return result;
        });
      const deletion = deleteSessionEntryLifecycle({
        archiveTranscript: true,
        storePath,
        target: { canonicalKey: sessionKey, storeKeys: [sessionKey] },
      });
      const heldPath = `${database.path}.held`;
      let replaced = false;
      try {
        await Promise.race([
          entered.promise,
          deletion.then(() => {
            throw new Error("Deletion skipped the publication gate");
          }),
        ]);
        fs.renameSync(database.path, heldPath);
        fs.renameSync(replacementPath, database.path);
        replaced = true;
        release.resolve();
        await expect(deletion).rejects.toThrow(/replaced/);
        expect(fs.readFileSync(database.path)).toEqual(replacementBytes);
      } finally {
        release.resolve();
        await Promise.allSettled([deletion]);
        if (replaced) {
          fs.renameSync(database.path, replacementPath);
          fs.renameSync(heldPath, database.path);
        }
        prepareObserver.mockRestore();
        publishObserver.mockRestore();
      }
      expect(
        database.db
          .prepare("SELECT published_at FROM session_transcript_archives WHERE session_id = ?")
          .get(sessionId),
      ).toEqual({ published_at: null });
      const { DatabaseSync } = requireNodeSqlite();
      const successor = new DatabaseSync(replacementPath, { readOnly: true });
      try {
        expect(successor.prepare("SELECT value FROM successor_marker").all()).toEqual([
          { value: "untouched" },
        ]);
        expect(
          successor.prepare("SELECT session_id FROM session_transcript_archives").all(),
        ).toEqual([]);
      } finally {
        successor.close();
      }
    },
  );

  it.each(["publication fails", "publication succeeds"] as const)(
    "preserves retained claim release failures when %s",
    async (outcome) => {
      let requested: Parameters<typeof publishSessionStateArchives>[1] = [
        {
          sessionId: "missing-canonical-archive",
          generation: "missing-generation",
          sourcePath: path.join(tempDir, "missing-source.jsonl"),
          archivedPath: path.join(tempDir, "missing-archive.jsonl"),
        },
      ];
      if (outcome === "publication succeeds") {
        const sessionId = "archive-release-success";
        const sessionKey = "agent:main:archive-release-success";
        await replaceSessionEntry({ sessionKey, storePath }, { sessionId, updatedAt: 1 });
        await replaceTranscriptEvents({ sessionKey, sessionId, storePath }, [
          createTranscriptEvent(sessionId, "publish before releasing the claim"),
        ]);
        requested = (
          await deleteSessionEntryLifecycle({
            archiveTranscript: true,
            storePath,
            target: { canonicalKey: sessionKey, storeKeys: [sessionKey] },
          })
        ).archivedTranscripts;
        expect(requested).toHaveLength(1);
        await waitForSessionTranscriptIndexReconcilesInStateDir(tempDir);
        await closeOpenClawAgentDatabasesAsync(tempDir);
      }
      const database = openLifecycleTestDatabase(storePath);
      const options = { agentId: "main", path: database.path, env: testState.env };
      const releaseFailure = new Error("synthetic retained archive claim release failure");
      const retain = readonlyDatabase.retainOpenClawAgentDatabaseReadOnly;
      let releaseInstalled = false;
      let releases = 0;
      const retainObserver = vi
        .spyOn(readonlyDatabase, "retainOpenClawAgentDatabaseReadOnly")
        .mockImplementation((...args) => {
          const retained = retain(...args);
          if (retained.found && !releaseInstalled) {
            releaseInstalled = true;
            const releaseClaim = retained.claim.release;
            retained.claim.release = () => {
              releaseClaim();
              releases += 1;
              throw releaseFailure;
            };
          }
          return retained;
        });
      try {
        const caught = await publishSessionStateArchives(options, requested).then(
          () => undefined,
          (error: unknown) => error,
        );
        expect(releases).toBe(1);
        if (outcome === "publication fails") {
          expect(caught).toBeInstanceOf(AggregateError);
          if (!(caught instanceof AggregateError)) {
            throw new Error("Expected publication and claim release failures to be preserved");
          }
          expect(caught.errors).toHaveLength(2);
          expect(caught.errors[0]).toMatchObject({
            message: expect.stringContaining("transcript archive file export(s) remain pending"),
          });
          expect(caught.cause).toBe(caught.errors[0]);
          expect(caught.errors[1]).toBe(releaseFailure);
        } else {
          expect(caught).toBe(releaseFailure);
          expect(
            database.db
              .prepare(
                "SELECT publish_attempts FROM session_transcript_archives WHERE session_id = ?",
              )
              .get("archive-release-success"),
          ).toEqual({ publish_attempts: 2 });
        }
      } finally {
        retainObserver.mockRestore();
      }
      await expect(publishSessionStateArchives(options, [])).resolves.toEqual([]);
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
        await closeOpenClawAgentDatabaseByPathAsync(database.path);
      }
      if (!target.path) {
        throw new Error("Expected a durable archive target");
      }
      await expect(publishSessionStateArchives(options, [])).resolves.toEqual([]);
      expect(getOpenClawAgentDatabaseIfOpen(options)).toBeUndefined();
      expect(fs.existsSync(target.path)).toBe(exists);
      if (exists) {
        const { DatabaseSync } = requireNodeSqlite();
        const peer = new DatabaseSync(target.path, { readOnly: true });
        try {
          expect(
            peer
              .prepare("SELECT name FROM sqlite_schema WHERE name = 'session_transcript_archives'")
              .all(),
          ).toEqual([]);
        } finally {
          peer.close();
        }
      }
    },
  );
});

type ArchiveSessionReply = {
  operationId?: number;
  settled?: boolean;
} & (TranscriptArchiveWorkerMessage | TranscriptArchivePublishWorkerMessage);

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
  return { replies, stop: () => process.off("worker", observeWorker) };
}

function createTranscriptEvent(sessionId: string, content: string) {
  return { type: "session", id: sessionId, content };
}

function readArchiveLines(archivePath: string | undefined): string[] {
  expect(archivePath).toBeTruthy();
  return readSessionArchiveContentSync(archivePath ?? "")
    .trim()
    .split("\n");
}

function openLifecycleTestDatabase(storePath: string) {
  const target = resolveSqliteTargetFromSessionStorePath(storePath);
  if (!target.path) {
    throw new Error(`Could not resolve SQLite database path for ${storePath}`);
  }
  return openOpenClawAgentDatabase({ agentId: target.agentId ?? "main", path: target.path });
}
