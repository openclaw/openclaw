import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFixtureLifetime } from "../../../test/helpers/fixture-lifetime.js";
import { createDeferred, withinTest } from "../../../test/helpers/promise.js";
import { observeHostDataSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../../infra/kysely-sync.js";
import { closeOpenClawAgentDatabaseByPathAsync } from "../../state/openclaw-agent-db-lifecycle.js";
import type { DB } from "../../state/openclaw-agent-db.generated.js";
import { runOpenClawAgentWriteTransaction } from "../../state/openclaw-agent-db.js";
import * as agentExecution from "../../state/openclaw-agent-execution.js";
import { runOpenClawAgentWorkerWrite } from "../../state/openclaw-agent-write-admission.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { replaceTranscriptEvents } from "./session-accessor.sqlite-transcript-write.js";
import { captureSessionStoreReadCandidate } from "./session-store-read-candidates.js";
import * as projectionWriter from "./session-transcript-projection-writer.js";
import {
  isSessionTranscriptIndexReconcileRunning,
  reconcileSessionTranscriptIndexes,
  waitForSessionTranscriptIndexReconcile,
} from "./session-transcript-reconcile.js";
import {
  searchSessionTranscripts,
  searchSessionTranscriptsReadOnlySync,
} from "./session-transcript-search.js";
import {
  historyLane,
  projectionLane,
  withSessionHistoryWorkerReadCandidates,
} from "./session-transcript-worker-resources.js";
import { retainSessionHistoryWorkerDatabase } from "./session-transcript-worker-runtime.js";

it("keeps a warmed search reader through discovery and retires it through its captured alias", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const directory = fs.realpathSync(state.stateDir);
    const storePath = path.join(directory, "discovery.main.sqlite");
    const aliasDirectory = path.join(directory, "discovery-alias");
    fs.symlinkSync(directory, aliasDirectory, "junction");
    const aliasPath = path.join(aliasDirectory, path.basename(storePath));
    const database = { agentId: "main", path: storePath, env: state.env };
    const scope = { agentId: "main", storePath, env: state.env };
    const sessionKey = "agent:main:discovery-custody";
    await replaceTranscriptEvents({ ...scope, sessionKey, sessionId: "discovery-custody" }, [
      { type: "session", id: "discovery-custody", version: 3 },
      {
        type: "message",
        id: "selected-message",
        parentId: null,
        timestamp: 1,
        message: { role: "assistant", content: "Retained discovery needle" },
      },
    ]);
    await waitForSessionTranscriptIndexReconcile(database);
    const request = { ...scope, query: "needle", sessionKeys: [sessionKey] };
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
      const changed = await reader.owner.searchTranscripts(request, async () => {
        runOpenClawAgentWriteTransaction(({ db }) => {
          executeSqliteQuerySync(
            db,
            getNodeSqliteKysely<DB>(db)
              .updateTable("schema_meta")
              .set({ updated_at: 2 })
              .where("meta_key", "=", "primary"),
          );
        }, database);
        return projectionWriter.readSessionTranscriptIndexStatus(database);
      });
      expect(changed.indexing).toBe(true);
      const refreshed = await search();
      expect(refreshed.hits).toEqual(initial.hits);
      expect(refreshed.indexing).toBe(false);
      await closeOpenClawAgentDatabaseByPathAsync(aliasPath, "main");
      await expect(search()).rejects.toThrow("revoked");
    } finally {
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
    const {
      found,
      revision: _revision,
      ...golden
    } = searchSessionTranscriptsReadOnlySync(request, {
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
      });
      expect(slowUnavailable).toHaveBeenCalledTimes(1);
    } finally {
      slowUnavailable.mockRestore();
      clock.mockRestore();
    }

    runOpenClawAgentWriteTransaction(
      ({ db }) => {
        executeSqliteQuerySync(
          db,
          getNodeSqliteKysely<DB>(db)
            .updateTable("session_transcript_index_state")
            .set({ needs_rebuild: 1 }),
        );
      },
      { ...database, env: state.env },
    );
    const readStatus = projectionWriter.readSessionTranscriptIndexStatus;
    const status = vi
      .spyOn(projectionWriter, "readSessionTranscriptIndexStatus")
      .mockImplementationOnce(async (...args) => {
        // Complete publication after the hit snapshot but before its clean status is read.
        await reconcileSessionTranscriptIndexes({ ...database, env: state.env });
        const pending = await readStatus(...args);
        expect(pending).toBe(false);
        expect(isSessionTranscriptIndexReconcileRunning({ ...database, env: state.env })).toBe(
          false,
        );
        return pending;
      });
    try {
      expect(await searchSessionTranscripts(request, database)).toMatchObject({
        hits: [],
        indexing: true,
      });
    } finally {
      status.mockRestore();
    }
    expect(await searchSessionTranscripts(request, database)).toEqual({
      ...golden,
      indexing: false,
    });
  });
});

it("cancels a search status callback queued behind a stuck writer at its deadline", async (test) => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const storePath = path.join(state.stateDir, "search-cancellation.sqlite");
    const database = { agentId: "main", path: storePath, env: state.env };
    const scope = { agentId: "main", storePath, env: state.env };
    const sessionKey = "agent:main:search-cancellation";
    await replaceTranscriptEvents({ ...scope, sessionKey, sessionId: "search-cancellation" }, [
      { type: "session", id: "search-cancellation", version: 3 },
      {
        type: "message",
        id: "needle",
        parentId: null,
        timestamp: 1,
        message: { role: "assistant", content: "Committed needle" },
      },
    ]);
    await waitForSessionTranscriptIndexReconcile(database);
    const request = { ...scope, query: "needle", sessionKeys: [sessionKey] };
    const committed = await searchSessionTranscripts(request, database);
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
    expect(await searchSessionTranscripts(request, database)).toEqual(committed);
  });
});

describe("search reader concurrency", () => {
  const lifetime = createFixtureLifetime();
  afterEach(() => lifetime.cleanup());

  it.skipIf(historyLane.pool.getSnapshot().maxWorkers < 2)(
    "searches while foreground and projection readers await index status",
    (context) =>
      lifetime.run(() =>
        withOpenClawTestState({ scenario: "minimal" }, async (state) => {
          const storePath = path.join(state.stateDir, "parallel-search.sqlite");
          const sessionKey = "agent:main:parallel-search";
          const scope = { agentId: "main", storePath, env: state.env };
          const database = { agentId: "main", path: storePath, env: state.env };
          await replaceTranscriptEvents({ ...scope, sessionKey, sessionId: "parallel-search" }, [
            { type: "session", id: "parallel-search", version: 3 },
            {
              type: "message",
              id: "needle",
              parentId: null,
              timestamp: 1,
              message: { role: "assistant", content: "Parallel needle" },
            },
          ]);
          await waitForSessionTranscriptIndexReconcile(database);
          const request = { ...scope, query: "needle", sessionKeys: [sessionKey] };
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
