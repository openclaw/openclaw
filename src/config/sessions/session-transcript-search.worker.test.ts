import { once } from "node:events";
import fs from "node:fs";
import path from "node:path";
import type { Worker } from "node:worker_threads";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFixtureLifetime } from "../../../test/helpers/fixture-lifetime.js";
import { createDeferred, withinTest } from "../../../test/helpers/promise.js";
import { observeHostDataSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../../infra/kysely-sync.js";
import { resolveRuntimeProcessEntrypointUrl } from "../../infra/runtime-process-url.js";
import * as sqliteWorkerStore from "../../infra/sqlite-worker-store.js";
import * as workerCpu from "../../infra/worker-cpu.js";
import { closeOpenClawAgentDatabaseByPathAsync } from "../../state/openclaw-agent-db-lifecycle.js";
import type { DB } from "../../state/openclaw-agent-db.generated.js";
import { runOpenClawAgentWriteTransaction } from "../../state/openclaw-agent-db.js";
import * as agentExecution from "../../state/openclaw-agent-execution.js";
import { runOpenClawAgentWorkerWrite } from "../../state/openclaw-agent-write-admission.js";
import {
  withOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { replaceSqliteTranscriptEventsInTransaction } from "./session-accessor.sqlite-transcript-store.js";
import { replaceTranscriptEvents } from "./session-accessor.sqlite-transcript-write.test-support.js";
import { captureSessionStoreReadCandidate } from "./session-store-read-candidates.js";
import { markSessionTranscriptIndexDirtyInTransaction } from "./session-transcript-index.js";
import * as projectionWriter from "./session-transcript-projection-writer.js";
import { createSessionTranscriptHistoryPool } from "./session-transcript-read-pools.js";
import {
  isSessionTranscriptIndexReconcileRunning,
  waitForSessionTranscriptIndexReconcile,
} from "./session-transcript-reconcile.js";
import {
  searchSessionTranscripts,
  searchSessionTranscriptsReadOnlySync,
} from "./session-transcript-search.js";
import {
  clearDatabaseWorkerIdleRetirement,
  historyLane,
  projectionLane,
  registerSessionTranscriptReaderLane,
  withSessionHistoryWorkerReadCandidates,
} from "./session-transcript-worker-resources.js";
import { retainSessionHistoryWorkerDatabase } from "./session-transcript-worker-runtime.js";

function transcriptMessage(id: string, content: string, timestamp = 1) {
  return {
    type: "message",
    id,
    parentId: null,
    timestamp,
    message: { role: "assistant", content },
  };
}

async function searchFixture(
  state: OpenClawTestState,
  name: string,
  messageId: string,
  content: string,
  storePath = state.statePath(`${name}.sqlite`),
) {
  const database = { agentId: "main", path: storePath, env: state.env };
  const scope = { agentId: "main", storePath, env: state.env };
  const sessionKey = `agent:main:${name}`;
  await replaceTranscriptEvents({ ...scope, sessionKey, sessionId: name }, [
    { type: "session", id: name, version: 3 },
    transcriptMessage(messageId, content),
  ]);
  await waitForSessionTranscriptIndexReconcile(database);
  return {
    database,
    scope,
    sessionKey,
    storePath,
    request: { ...scope, query: "needle", sessionKeys: [sessionKey] },
  };
}

it("reenters the projection writer from a cold search's retained read admission", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const { storePath, database, request } = await searchFixture(
      state,
      "cold-search",
      "cold-needle",
      "Cold search needle",
    );
    await closeOpenClawAgentDatabaseByPathAsync(storePath, "main");
    const reader = retainSessionHistoryWorkerDatabase(database);
    const readStatus = vi.fn((signal: AbortSignal) =>
      projectionWriter.readSessionTranscriptIndexStatus(
        database,
        reader.owner.assertCurrent,
        signal,
      ),
    );
    try {
      const result = await reader.owner.searchTranscripts(request, readStatus);
      expect(result.hits).toMatchObject([{ messageId: "cold-needle" }]);
      expect(readStatus).toHaveBeenCalledOnce();
    } finally {
      reader.release();
      await closeOpenClawAgentDatabaseByPathAsync(storePath, "main");
    }
  });
});

it("keeps a warmed search reader through discovery and retires it through its captured alias", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const directory = fs.realpathSync(state.stateDir);
    const storePath = path.join(directory, "discovery.main.sqlite");
    const aliasDirectory = path.join(directory, "discovery-alias");
    fs.symlinkSync(directory, aliasDirectory, "junction");
    const aliasPath = path.join(aliasDirectory, path.basename(storePath));
    const { database, request } = await searchFixture(
      state,
      "discovery-custody",
      "selected-message",
      "Retained discovery needle",
      storePath,
    );
    const reader = retainSessionHistoryWorkerDatabase(database);
    const search = () =>
      reader.owner.searchTranscripts(request, () =>
        projectionWriter.readSessionTranscriptIndexStatus(database),
      );
    try {
      const initial = await search();
      expect(initial.hits).toMatchObject([{ messageId: "selected-message" }]);
      expect(initial.indexing).toBe(false);
      const hostSql = observeHostDataSql();
      try {
        await withSessionHistoryWorkerReadCandidates(
          [
            captureSessionStoreReadCandidate(
              path.join(aliasDirectory, "discovery.sqlite"),
              "sibling-family",
            ),
          ],
          (owner) =>
            owner.readStoreTarget({
              agentId: "main",
              storePath: aliasPath,
              env: state.env,
              registeredDatabases: [],
            }),
        );
        expect(await search()).toEqual(initial);
        expect(hostSql.queries).toEqual([]);
      } finally {
        hostSql.restore();
      }
      await closeOpenClawAgentDatabaseByPathAsync(aliasPath, "main");
      await expect(search()).rejects.toThrow("revoked");
    } finally {
      reader.release();
    }
  });
});

it("reuses completed readiness after idle writer eviction and observes a later transcript write", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const seed = (name: string, count: number) => {
      const database = { agentId: "main", path: state.statePath(`${name}.sqlite`), env: state.env };
      runOpenClawAgentWriteTransaction((connection) => {
        for (let index = 0; index < count; index++) {
          const sessionId = `session-${index}`;
          replaceSqliteTranscriptEventsInTransaction(
            connection,
            { ...database, sessionKey: `agent:main:${sessionId}`, sessionId },
            [
              { type: "session", id: sessionId, version: 3 },
              transcriptMessage(
                `message-${index}`,
                index === 0 ? "Original needle" : `Unrelated fixture ${index}`,
                index + 1,
              ),
            ],
            { scheduleProjectionReconcile: false },
          );
        }
      }, database);
      return {
        database,
        request: {
          agentId: database.agentId,
          storePath: database.path,
          env: state.env,
          query: "needle",
          sessionKeys: ["agent:main:session-0"],
        },
      };
    };
    const primary = seed("search-retirement", 129);
    const peers = Array.from({ length: 4 }, (_, index) => seed(`search-peer-${index}`, 1));
    for (const { database } of [primary, ...peers]) {
      await closeOpenClawAgentDatabaseByPathAsync(database.path, database.agentId);
    }
    const reader = retainSessionHistoryWorkerDatabase(primary.database);
    const openWriter = vi.spyOn(sqliteWorkerStore, "openAgentDatabaseSqliteWorkerStore");
    try {
      const original = await searchSessionTranscripts(primary.request, primary.database);
      expect(original).toMatchObject({
        hits: [{ messageId: "message-0", snippet: "Original needle" }],
        indexing: false,
      });
      expect(openWriter.mock.calls[0]?.[0].databasePath).toBe(primary.database.path);
      const nativeWriter = await openWriter.mock.results[0]!.value;
      expect(nativeWriter).toBeDefined();
      const closeWriter = vi.spyOn(nativeWriter!, "close");
      try {
        // Five stores exceed the idle writer limit; the first store retains only its reader.
        for (const peer of peers) {
          expect((await searchSessionTranscripts(peer.request, peer.database)).indexing).toBe(
            false,
          );
        }
        expect(closeWriter).toHaveBeenCalledOnce();
        await closeWriter.mock.results[0]!.value;
        expect(sqliteWorkerStore.isSqliteWorkerStoreAvailable(nativeWriter!)).toBe(false);
        openWriter.mockClear();
        expect(
          JSON.stringify(await searchSessionTranscripts(primary.request, primary.database)),
        ).toBe(JSON.stringify(original));
        expect(openWriter).not.toHaveBeenCalled();
      } finally {
        closeWriter.mockRestore();
      }

      runOpenClawAgentWriteTransaction((connection) => {
        replaceSqliteTranscriptEventsInTransaction(
          connection,
          { ...primary.database, sessionKey: "agent:main:session-0", sessionId: "session-0" },
          [
            { type: "session", id: "session-0", version: 3 },
            transcriptMessage("replacement", "Replacement needle", 2),
          ],
          { scheduleProjectionReconcile: false },
        );
        markSessionTranscriptIndexDirtyInTransaction(connection.db, "session-0");
      }, primary.database);
      expect((await searchSessionTranscripts(primary.request, primary.database)).indexing).toBe(
        true,
      );
      await waitForSessionTranscriptIndexReconcile(primary.database);
      const rebuilt = await searchSessionTranscripts(primary.request, primary.database);
      expect(rebuilt.indexing).toBe(false);
      expect(rebuilt.hits).toMatchObject([
        { messageId: "replacement", snippet: "Replacement needle" },
      ]);
      expect(rebuilt.hits).toHaveLength(1);
    } finally {
      openWriter.mockRestore();
      reader.release();
    }
  });
});

it("keeps scoped search bytes while disk SQL executes outside the caller thread", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const storePath = path.join(state.stateDir, "search.sqlite");
    const scope = { agentId: "main", env: state.env, storePath };
    for (const sessionKey of ["agent:main:selected", "agent:main:excluded"]) {
      await replaceTranscriptEvents({ ...scope, sessionKey, sessionId: sessionKey }, [
        { type: "session", id: sessionKey, version: 3 },
        ...Array.from({ length: 2 }, (_, index) => ({
          type: "message" as const,
          id: `message-${index}`,
          parentId: index === 0 ? null : "message-0",
          timestamp: index + 1,
          message: { role: "assistant", content: `Needle visible text ${index}` },
        })),
      ]);
    }
    await waitForSessionTranscriptIndexReconcile({
      agentId: "main",
      env: state.env,
      path: storePath,
    });
    const request = { ...scope, query: "needle", sessionKeys: ["agent:main:selected"], limit: 1 };
    const database = { agentId: "main", path: storePath };
    const { found, ...golden } = searchSessionTranscriptsReadOnlySync(request, {
      ...database,
      env: state.env,
    });
    expect(found).toBe(true);
    expect(golden).toMatchObject({
      hits: [
        {
          sessionKey: "agent:main:selected",
          messageId: "message-1",
          snippet: "Needle visible text 1",
        },
      ],
      truncated: true,
    });
    const hostSql = observeHostDataSql();
    try {
      const actual = await searchSessionTranscripts(request, database);
      expect(actual).toEqual({ ...golden, indexing: false });
      expect(hostSql.calls.map((call) => call.mock.calls.length)).toEqual([0, 0, 0, 0, 0, 0]);
    } finally {
      hostSql.restore();
    }
    runOpenClawAgentWriteTransaction(
      ({ db }) => {
        executeSqliteQuerySync(
          db,
          getNodeSqliteKysely<DB>(db).deleteFrom("session_transcript_index_state"),
        );
      },
      { ...database, env: state.env },
    );
    expect((await searchSessionTranscripts(request, database)).indexing).toBe(true);
    await waitForSessionTranscriptIndexReconcile({ ...database, env: state.env });
    expect(await searchSessionTranscripts(request, database)).toEqual({
      ...golden,
      indexing: false,
    });

    for (const makeUnavailable of [
      () =>
        vi
          .spyOn(projectionWriter, "readSessionTranscriptIndexStatus")
          .mockRejectedValueOnce(new Error("projection writer unavailable")),
      () =>
        vi
          .spyOn(agentExecution, "captureOpenClawAgentDatabaseExecution")
          .mockImplementationOnce(() => {
            throw new Error("projection writer admission unavailable");
          }),
    ]) {
      const unavailableStatus = makeUnavailable();
      try {
        expect(await searchSessionTranscripts(request, database)).toEqual({
          ...golden,
          indexing: true,
        });
        expect(unavailableStatus).toHaveBeenCalledTimes(1);
        expect(isSessionTranscriptIndexReconcileRunning({ ...database, env: state.env })).toBe(
          false,
        );
      } finally {
        unavailableStatus.mockRestore();
      }
    }

    const now = performance.now.bind(performance);
    let hostWait = 0;
    const clock = vi.spyOn(performance, "now").mockImplementation(() => now() + hostWait);
    const slowUnavailable = vi
      .spyOn(projectionWriter, "readSessionTranscriptIndexStatus")
      .mockImplementationOnce(async () => {
        hostWait = 120_000;
        throw new Error("projection writer unavailable after admission wait");
      });
    try {
      await expect(searchSessionTranscripts(request, database)).rejects.toMatchObject({
        code: "timeout",
        message: expect.stringMatching(/narrow the session selection/),
        cause: expect.objectContaining({ code: "timeout" }),
      });
      expect(slowUnavailable).toHaveBeenCalledTimes(1);
    } finally {
      slowUnavailable.mockRestore();
      clock.mockRestore();
    }
  });
});

it("cancels a search status callback queued behind a stuck writer at its deadline", async (test) => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const { database, request } = await searchFixture(
      state,
      "search-cancellation",
      "needle",
      "Committed needle",
    );
    const committed = await searchSessionTranscripts(request, database);
    runOpenClawAgentWriteTransaction(({ db }) => {
      executeSqliteQuerySync(
        db,
        getNodeSqliteKysely<DB>(db)
          .updateTable("session_windows")
          .set({ updated_at: 2 })
          .where("session_id", "=", "search-cancellation"),
      );
    }, database);
    const releaseWriter = createDeferred();
    const writerEntered = createDeferred();
    const writer = runOpenClawAgentWorkerWrite(database, async () => {
      writerEntered.resolve();
      await releaseWriter.promise;
    });
    await withinTest(writerEntered.promise, test.signal);
    const entered = createDeferred<AbortSignal | undefined>();
    const readStatus = projectionWriter.readSessionTranscriptIndexStatus;
    const status = vi
      .spyOn(projectionWriter, "readSessionTranscriptIndexStatus")
      .mockImplementation((...args) => {
        entered.resolve(args[2]);
        return readStatus(...args);
      });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    const search = searchSessionTranscripts(request, database);
    const outcome = Promise.allSettled([search]);
    try {
      const signal = await withinTest(entered.promise, test.signal);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(signal?.aborted).toBe(true);
      expect(await withinTest(outcome, test.signal)).toEqual([
        { status: "rejected", reason: expect.objectContaining({ code: "timeout" }) },
      ]);
    } finally {
      vi.useRealTimers();
      releaseWriter.resolve();
      await writer;
      await outcome;
      status.mockRestore();
    }
    expect(await searchSessionTranscripts(request, database)).toEqual({
      ...committed,
      indexing: false,
    });
  });
});

describe("search reader concurrency", () => {
  const lifetime = createFixtureLifetime();
  afterEach(() => lifetime.cleanup());

  it.skipIf(historyLane.pool.getSnapshot().maxWorkers < 2)(
    "retires surplus workers without revoking retained readers or interrupting active reads",
    (context) =>
      lifetime.run(() =>
        withOpenClawTestState({ scenario: "minimal" }, async (state) => {
          const { storePath, database, request } = await searchFixture(
            state,
            "surplus-history",
            "retained-needle",
            "Retained reader needle",
          );
          const expected = { hits: [{ messageId: "retained-needle" }], indexing: false };
          const entered = createDeferred();
          const release = createDeferred();
          const pending: Promise<unknown>[] = [];
          const readers: ReturnType<typeof retainSessionHistoryWorkerDatabase>[] = [];
          const workers: Worker[] = [];
          const workerUrl = resolveRuntimeProcessEntrypointUrl("sessionTranscript");
          const spawn = workerCpu.createCpuTrackedWorker;
          const creation = vi
            .spyOn(workerCpu, "createCpuTrackedWorker")
            .mockImplementation((filename, options) => {
              const worker = spawn(filename, options);
              if (String(filename) === workerUrl.href) {
                workers.push(worker);
              }
              return worker;
            });
          let ownedLane: typeof historyLane | undefined;
          // The pool captures its clock when constructed; no global lane is replaced.
          vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
          try {
            const lane = registerSessionTranscriptReaderLane("Surplus history fixture", (closed) =>
              createSessionTranscriptHistoryPool(historyLane.pool.getSnapshot().maxWorkers, closed),
            );
            ownedLane = lane;
            const primary = retainSessionHistoryWorkerDatabase(database, lane);
            readers.push(primary);
            const surplus = retainSessionHistoryWorkerDatabase(database, lane);
            readers.push(surplus);
            const active = primary.owner.searchTranscripts(request, async (signal) => {
              entered.resolve();
              await release.promise;
              return projectionWriter.readSessionTranscriptIndexStatus(database, undefined, signal);
            });
            pending.push(active);
            void active.catch(() => {});
            await withinTest(entered.promise, context.signal);
            const read = () => {
              const result = surplus.owner.searchTranscripts(request, (signal) =>
                projectionWriter.readSessionTranscriptIndexStatus(database, undefined, signal),
              );
              pending.push(result);
              return withinTest(result, context.signal);
            };
            expect(await read()).toMatchObject(expected);
            expect(workers).toHaveLength(2);
            const worker = workers[1]!;
            const exited = once(worker, "exit");
            const terminate = vi.spyOn(worker, "terminate");
            try {
              await vi.advanceTimersByTimeAsync(30_000);
              expect(terminate).toHaveBeenCalledOnce();
              await withinTest(exited, context.signal);
              expect(lane.pool.getSnapshot()).toMatchObject({ workers: 1, activeTasks: 1 });
              // The primary is still occupied, so this retained reader must reopen on a new worker.
              expect(await read()).toMatchObject(expected);
              expect(lane.pool.getSnapshot()).toMatchObject({ workers: 2, workersCreated: 3 });
            } finally {
              terminate.mockRestore();
            }
            release.resolve();
            expect(await withinTest(active, context.signal)).toMatchObject(expected);
          } finally {
            release.resolve();
            try {
              // Closing cancels unfinished requests even when their fake deadlines have not fired.
              const closed = await Promise.allSettled(ownedLane ? [ownedLane.pool.close()] : []);
              await Promise.allSettled(pending);
              for (const reader of readers) {
                reader.release();
              }
              if (ownedLane) {
                clearDatabaseWorkerIdleRetirement(ownedLane);
              }
              await closeOpenClawAgentDatabaseByPathAsync(storePath, "main");
              const failures = closed.flatMap((result) =>
                result.status === "rejected" ? [result.reason] : [],
              );
              expect(failures).toEqual([]);
            } finally {
              creation.mockRestore();
              vi.useRealTimers();
            }
          }
        }),
      ),
  );

  it.skipIf(historyLane.pool.getSnapshot().maxWorkers < 2)(
    "searches while foreground and projection readers await index status",
    (context) =>
      lifetime.run(() =>
        withOpenClawTestState({ scenario: "minimal" }, async (state) => {
          const { database, request } = await searchFixture(
            state,
            "parallel-search",
            "needle",
            "Parallel needle",
          );
          const release = createDeferred();
          const readers = [historyLane, projectionLane].map((lane) => {
            const reader = retainSessionHistoryWorkerDatabase(database, lane);
            const entered = createDeferred();
            const work = reader.owner.searchTranscripts(request, async () => {
              entered.resolve();
              await release.promise;
              return projectionWriter.readSessionTranscriptIndexStatus(database);
            });
            void work.catch(() => {});
            return { reader, entered: entered.promise, work };
          });
          let search: ReturnType<typeof searchSessionTranscripts> | undefined;
          try {
            await withinTest(Promise.all(readers.map(({ entered }) => entered)), context.signal);
            search = searchSessionTranscripts(request, database);
            expect(await withinTest(search, context.signal)).toMatchObject({
              hits: [{ messageId: "needle" }],
              indexing: false,
            });
          } finally {
            release.resolve();
            await Promise.allSettled([
              ...readers.map(({ work }) => work),
              ...(search ? [search] : []),
            ]);
            for (const { reader } of readers) {
              reader.release();
            }
          }
        }),
      ),
  );
});
