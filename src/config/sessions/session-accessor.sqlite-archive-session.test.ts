import fs from "node:fs";
import path from "node:path";
import type { Worker } from "node:worker_threads";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred, withTestTimeout } from "../../../test/helpers/promise.js";
import {
  closeOpenClawAgentDatabaseByPathAsync,
  closeOpenClawAgentDatabasesAsync,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
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
import type {
  TranscriptArchivePublishWorkerMessage,
  TranscriptArchiveWorkerMessage,
} from "./session-accessor.sqlite-archive-types.js";
import { runExclusiveSqliteTranscriptArchiveWorker } from "./session-accessor.sqlite-archive.js";
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

  it("joins a failed publisher before returning and recovers its committed archive on retry", async () => {
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
    expect(loadSessionEntry({ sessionKey, storePath })).toMatchObject({ sessionId: sessionIds[1] });
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

    await expect(deleteSessionEntryLifecycle(deletionParams)).resolves.toMatchObject({
      deleted: true,
    });
    expect(readArchiveLines(collisionPath)).toEqual([JSON.stringify(events[0])]);
    expect(
      openLifecycleTestDatabase(storePath)
        .db.prepare(
          "SELECT published_at, last_publish_error FROM session_transcript_archives WHERE session_id = ?",
        )
        .get(sessionIds[0]!),
    ).toEqual({ published_at: expect.any(Number), last_publish_error: null });
  });

  it("retires competing archive scopes and publishes with the originally captured environment", async () => {
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

      vi.stubEnv("OPENCLAW_STATE_DIR", successorRoot);
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

  it("retires a scoped archive worker before closing its database and refuses later scope work", async () => {
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
      if (message.type === "done" && !retirement) {
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
    expect(archiveWorkers.replies.map(({ message }) => message.type)).toEqual(["done"]);
    expect(loadSessionEntry(scope)).toMatchObject({ sessionId });
    await expect(loadTranscriptEvents(scope)).resolves.toEqual([event]);
    await expect(deleteSessionEntryLifecycle(deletionParams)).resolves.toMatchObject({
      deleted: true,
    });
  });
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
