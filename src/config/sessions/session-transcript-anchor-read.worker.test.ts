import fs from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../../test/helpers/promise.js";
import {
  observeHostDataSql,
  trackSqliteStatementExecutions,
} from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { runSqliteImmediateTransactionSync } from "../../infra/sqlite-transaction.js";
import {
  closeOpenClawAgentDatabaseByPathAsync,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { resolveIncognitoOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
import { runOpenClawAgentWriteAdmission } from "../../state/openclaw-agent-write-admission.js";
import { requireNativeSqliteDatabase } from "../../test-utils/native-sqlite.js";
import {
  withOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { createSessionEntryWithTranscript } from "./session-accessor.entry-mutation.js";
import { loadSessionEntryForAdmission } from "./session-accessor.sqlite-entry-admission.js";
import {
  readCurrentProjectionSnapshot,
  type CurrentTranscriptProjection,
} from "./session-accessor.sqlite-projection-read.js";
import { readActiveTranscriptEntryAnchorFromProjection } from "./session-accessor.sqlite-transcript-anchor.js";
import { appendTranscriptEventsInTransaction } from "./session-accessor.sqlite-transcript-store.js";
import { replaceTranscriptEvents } from "./session-accessor.sqlite-transcript-write.test-support.js";
import { memorySessionActorOwners } from "./session-actor-memory-owner.js";
import {
  readActiveTranscriptEntryAnchorAsync as readAnchor,
  readSessionTranscriptAnchorsAsync as readAnchors,
} from "./session-transcript-anchor-read.js";
import {
  prepareSessionTranscriptAnchorMessageReader as prepareMessageReader,
  readSessionTranscriptAnchorFactsInDatabase as readFacts,
} from "./session-transcript-anchor-read.kernel.js";
import { readSessionTranscriptHydrationRequest } from "./session-transcript-hydration-read.worker.js";
import { prepareSessionTranscriptHydration } from "./session-transcript-hydration.js";
import * as targetWorker from "./session-transcript-read-worker-runtime.js";
import { historyLane } from "./session-transcript-worker-resources.js";
import { withOwnedSessionTranscriptWrites } from "./transcript-write-context.js";

afterEach(() => memorySessionActorOwners.reset());

const events = [
  { type: "session", id: "anchors", version: 3 },
  {
    type: "message",
    id: "question",
    parentId: null,
    message: { role: "user", content: "question", idempotencyKey: "question-key" },
  },
  message("answer", "question", "answer", "answer-run"),
  message("alternate", "question", "other branch"),
  { type: "leaf", id: "selected-leaf", parentId: "alternate", targetId: "answer" },
];

function transcriptScope(state: OpenClawTestState) {
  return {
    agentId: "main",
    env: state.env,
    sessionId: "anchors",
    sessionKey: "agent:main:anchors",
    storePath: state.statePath("transcript.sqlite"),
  };
}

type Scope = ReturnType<typeof transcriptScope>;

function openDatabase(scope: Scope) {
  return openOpenClawAgentDatabase({
    agentId: scope.agentId,
    env: scope.env,
    path: scope.storePath,
  });
}

function incognitoScope(state: OpenClawTestState): Scope {
  return {
    ...transcriptScope(state),
    sessionKey: "agent:main:dashboard:incognito-anchors",
    storePath: resolveIncognitoOpenClawAgentSqlitePath({ agentId: "main", env: state.env }),
  };
}

function initializeIncognito(scope: Scope) {
  return createSessionEntryWithTranscript(scope, () => ({
    ok: true,
    entry: { incognito: true, sessionId: scope.sessionId, updatedAt: 1 },
    transcriptEvents: events,
  }));
}

function expectRebuilding(read: Promise<unknown>, scope: Scope) {
  return expect(read).rejects.toMatchObject({
    name: "SessionTranscriptProjectionUnavailableError",
    sessionId: scope.sessionId,
    reason: "rebuilding",
  });
}

function trackProjection(database: ReturnType<typeof openDatabase>) {
  const statements = trackSqliteStatementExecutions(
    requireNativeSqliteDatabase(database.db),
    ["projection", "watermark"],
    (sql) =>
      sql.includes('"session_transcript_index_state"')
        ? "projection"
        : sql.includes('as "max_seq"')
          ? "watermark"
          : null,
  );
  return { ...statements, [Symbol.dispose]: statements.restore };
}

function withTranscript(
  label: string,
  run: (scope: Scope, state: OpenClawTestState) => Promise<void>,
) {
  return withOpenClawTestState({ label }, (state) => run(transcriptScope(state), state));
}

function message(id: string, parentId: string | null, content: string, runId?: string) {
  return {
    type: "message",
    id,
    parentId,
    message: { role: "assistant", content, ...(runId ? { __openclaw: { runId } } : {}) },
  };
}

function expectTailMessage(entries: unknown, entryId: string, content: string) {
  expect(entries).toContainEqual(
    expect.objectContaining({
      entryId,
      message: expect.objectContaining({ content }),
    }),
  );
}

it("keeps replay tails metadata-only unless message payloads are selected", async () => {
  await withTranscript("transcript-tail-payload-selection", async (scope) => {
    await createSessionEntryWithTranscript(scope, () => ({
      ok: true,
      entry: { sessionId: scope.sessionId, updatedAt: 1 },
    }));
    await replaceTranscriptEvents(scope, [
      ...events.slice(0, 2),
      message("untagged", "question", "metadata-only answer"),
      message("tagged", "untagged", "selected answer", "tail-run"),
    ]);
    const selection = {
      entryIds: ["question"],
      afterSeq: 1,
      replayValidation: { allowInitial: false },
    };
    const metadata = await readAnchors(scope, selection);
    expect(metadata.replayValidated).toBe("current");
    expect(metadata.tail?.entries).toEqual([
      { entryId: "untagged", role: "assistant" },
      { entryId: "tagged", role: "assistant", runId: "tail-run" },
    ]);
    const selected = await readAnchors(scope, {
      ...selection,
      includeMessagesForRunId: "tail-run",
    });
    expect(selected.tail?.entries[0]).toEqual({ entryId: "untagged", role: "assistant" });
    expect(selected.tail?.entries[1]).toMatchObject({
      entryId: "tagged",
      anchor: { entryId: "tagged" },
      message: { role: "assistant", content: "selected answer" },
    });
  });
});

it("settles callback-owned tail reads while independent history waits on the writer", async () => {
  await withTranscript("writer-owned-transcript-tail", async (scope) => {
    await replaceTranscriptEvents(scope, events);
    openOpenClawAgentDatabase({ agentId: scope.agentId, path: scope.storePath });
    const independentRead = createDeferred();
    const blockedHistory = createDeferred<never>();
    void blockedHistory.promise.catch(() => {});
    const spy = vi.spyOn(historyLane.pool, "run").mockImplementation(() => {
      independentRead.resolve();
      return blockedHistory.promise;
    });
    let accepted = false;
    const reading = readAnchors(
      scope,
      { entryIds: ["question"], afterSeq: 1, includeMessagesForRunId: "answer-run" },
      undefined,
      (facts) => {
        expect(facts.anchors).toContainEqual(expect.objectContaining({ entryId: "question" }));
        expect(facts.tail?.entries).toContainEqual(
          expect.objectContaining({ entryId: "answer", runId: "answer-run" }),
        );
        accepted = true;
      },
    );
    try {
      await Promise.race([
        reading,
        independentRead.promise.then(() => {
          throw new Error("Tail acceptance waited on independent history custody");
        }),
      ]);
      expect(accepted).toBe(true);
    } finally {
      blockedHistory.reject(new Error("Synthetic history custody released"));
      await reading.catch(() => {});
      spy.mockRestore();
    }
  });
});

it("rejects an async anchor consumer on the selected execution owner", async () => {
  await withTranscript("transcript-anchors-async-consumer", async (scope) => {
    await createSessionEntryWithTranscript(scope, () => ({
      ok: true,
      entry: { sessionId: scope.sessionId, updatedAt: 1 },
    }));
    await replaceTranscriptEvents(scope, events);
    const { databaseClaim } = await loadSessionEntryForAdmission(scope);
    if (!("kind" in databaseClaim) || databaseClaim.kind !== "worker" || !databaseClaim.reader) {
      throw new Error("Expected admitted durable session reader");
    }
    try {
      await withOwnedSessionTranscriptWrites(
        {
          sessionTarget: scope,
          sessionReader: databaseClaim.reader,
          withTranscriptWrite: async (write) => write(),
        },
        async () => {
          let consumed = false;
          await expect(
            readAnchors(
              scope,
              { entryIds: ["question"] },
              undefined,
              // oxlint-disable-next-line typescript/no-misused-promises -- Exercise runtime rejection of an async consumer.
              async (facts) => {
                expect(facts.anchors).toMatchObject([{ entryId: "question" }]);
                consumed = true;
              },
            ),
          ).rejects.toThrow("must remain synchronous");
          expect(consumed).toBe(true);
        },
      );
    } finally {
      await databaseClaim.release();
    }
  });
});

it("reads active anchors and raw tail facts without caller SQL, including cold discovery", async () => {
  await withTranscript("transcript-anchors-worker", async (scope, state) => {
    await replaceTranscriptEvents(scope, events);
    await closeOpenClawAgentDatabaseByPathAsync(scope.storePath);
    const absentPath = state.statePath("absent.sqlite");
    const absentScope = { ...scope, storePath: absentPath };
    const hostSql = observeHostDataSql();
    try {
      const result = await readAnchors(scope, {
        entryIds: ["question", "answer", "alternate", "missing"],
        afterSeq: 1,
      });
      const anchorBase = {
        agentId: scope.agentId,
        sessionId: scope.sessionId,
        sessionKey: scope.sessionKey,
        storePath: scope.storePath,
        generation: expect.any(String),
      };
      expect(result.anchors).toEqual([
        {
          ...anchorBase,
          entryId: "question",
          rawSeq: 1,
          effectiveParentId: null,
          activeMessagePosition: 0,
          idempotencyKey: "question-key",
        },
        {
          ...anchorBase,
          entryId: "answer",
          rawSeq: 2,
          effectiveParentId: "question",
          activeMessagePosition: 1,
        },
      ]);
      expect(result.anchors[0]?.generation).toBe(result.anchors[1]?.generation);
      expect(result.tail).toEqual({
        lastSeq: 4,
        entries: [
          { entryId: "answer", role: "assistant", runId: "answer-run", anchor: result.anchors[1] },
          { entryId: "alternate", role: "assistant" },
        ],
      });
      await expect(readAnchor({ ...scope, entryId: "question" })).resolves.toEqual(
        result.anchors[0],
      );
      await expect(
        readAnchors({ ...scope, sessionId: "missing" }, { entryIds: ["question"] }),
      ).resolves.toEqual({ anchors: [] });
      await expect(readAnchor({ ...absentScope, entryId: "question" })).resolves.toBeUndefined();
      const consumeInitial = vi.fn();
      await expect(
        readAnchors(
          absentScope,
          { entryIds: [], replayValidation: { allowInitial: true } },
          undefined,
          consumeInitial,
        ),
      ).resolves.toEqual({ anchors: [], replayValidated: "initial" });
      expect(consumeInitial).toHaveBeenCalledWith({ anchors: [], replayValidated: "initial" });
      expect(hostSql.queries).toEqual([]);
    } finally {
      hostSql.restore();
    }
    await expect(fs.stat(absentPath)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

it.each([
  "UPDATE session_transcript_index_state SET needs_rebuild = 1 WHERE session_id = ?",
  "UPDATE session_transcript_index_state SET indexed_seq = indexed_seq - 1 WHERE session_id = ?",
  "UPDATE session_transcript_active_events SET context_eligible = NULL WHERE session_id = ?",
])("refuses stale projection anchors without rebuilding: %s", async (invalidate) => {
  await withTranscript("transcript-anchors-stale", async (scope) => {
    await replaceTranscriptEvents(scope, events);
    const database = openDatabase(scope);
    database.db.prepare(invalidate).run(scope.sessionId);
    const version = database.db.prepare("PRAGMA data_version");
    const before = version.get();
    const hostSql = observeHostDataSql();
    try {
      const result = await readAnchors(scope, {
        entryIds: ["question", "answer"],
        afterSeq: 0,
      });
      expect(result.anchors).toEqual([]);
      expect(result.tail?.entries.every((entry) => entry.anchor === undefined)).toBe(true);
      await expectRebuilding(
        readAnchors(scope, {
          entryIds: ["question", "answer"],
          afterSeq: 0,
          includeMessagesForRunId: "answer-run",
        }),
        scope,
      );
      const hydrate = prepareSessionTranscriptHydration(scope, { maxBytes: 4096, maxEvents: 10 });
      const retirementEntered = createDeferred();
      const releaseRetirement = createDeferred();
      let following: Promise<void> | undefined;
      const retirement = vi.spyOn(historyLane.pool, "rotate").mockImplementation(() => {
        following ??= runOpenClawAgentWriteAdmission(
          { agentId: scope.agentId, env: scope.env, path: scope.storePath },
          () => {},
        );
        retirementEntered.resolve();
        return Promise.race([following, releaseRetirement.promise]);
      });
      const reading = hydrate.readCohort!(
        { sessionKey: scope.sessionKey, entryIds: ["question"] },
        () => {
          throw new Error("Stale hydration must not publish anchors");
        },
      );
      try {
        await expectRebuilding(
          Promise.race([
            reading,
            retirementEntered.promise.then(() => {
              throw new Error("Hydration cleanup waits on the writer queued behind its cohort");
            }),
          ]),
          scope,
        );
      } finally {
        releaseRetirement.resolve();
        await Promise.allSettled([reading, following]);
        retirement.mockRestore();
      }
      expect(hostSql.queries).toEqual([]);
    } finally {
      hostSql.restore();
    }
    expect(version.get()).toEqual(before);
  });
});

it("returns a reply tail and its current watermark from one projection snapshot", async () => {
  await withTranscript("transcript-anchor-watermark", async (scope) => {
    await replaceTranscriptEvents(scope, events);
    const database = openDatabase(scope);
    const resolved = { ...scope, path: database.path };
    const selection = {
      entryIds: ["question"],
      afterSeq: 1,
      includeMessagesForRunId: "answer-run",
      includeWatermark: true,
    };
    const readMessage = await prepareMessageReader(selection);
    using statements = trackProjection(database);
    const read = () => readFacts(database, resolved, selection, readMessage);
    const initial = read();
    expect(initial.watermark?.maxSeq).toBe(4);
    expectTailMessage(initial.tail?.entries, "answer", "answer");
    expect(statements.counts).toEqual({ projection: 1, watermark: 0 });

    runSqliteImmediateTransactionSync(database.db, () =>
      appendTranscriptEventsInTransaction(database, resolved, [
        message("new-answer", "answer", "new answer", "answer-run"),
      ]),
    );
    const before = { ...statements.counts };
    const updated = read();
    expect(updated.watermark).toEqual({ ...initial.watermark, maxSeq: 5 });
    expectTailMessage(updated.tail?.entries, "new-answer", "new answer");
    expect(statements.counts.projection - before.projection).toBe(1);
    expect(statements.counts.watermark - before.watermark).toBe(0);

    runSqliteImmediateTransactionSync(database.db, () => {
      database.db
        .prepare(
          `INSERT INTO session_transcript_cold_archives
             (session_id, generation, archive_name, archive_sha256, event_count,
              raw_bytes, archive_bytes, last_seq, archived_at, storage)
             VALUES (?, 'archive-generation', 'synthetic', ?, 6, 0, 0, 5, 1, 'file')`,
        )
        .run(scope.sessionId, "0".repeat(64));
    });
    expect(read).toThrow("is in cold storage");
    runSqliteImmediateTransactionSync(database.db, () => {
      database.db
        .prepare("DELETE FROM session_transcript_cold_archives WHERE session_id = ?")
        .run(scope.sessionId);
    });
    const beforeRestoredRead = { ...statements.counts };
    expect(read().watermark).toEqual(updated.watermark);
    expect(statements.counts.projection - beforeRestoredRead.projection).toBe(1);
    expect(statements.counts.watermark - beforeRestoredRead.watermark).toBe(0);
  });
});

it("reuses bounded message payloads for presence without treating an omitted message as absent", async () => {
  await withTranscript("bounded-transcript-message-presence", async (scope) => {
    const metadata = {
      type: "custom",
      id: "metadata",
      parentId: null,
      customType: "fixture",
      data: {},
      message: { role: "user", content: "metadata is not a message event" },
    };
    await replaceTranscriptEvents(scope, [events[0], metadata]);
    const read = async (maxBytes = 4096) => {
      const sql = observeHostDataSql();
      try {
        const result = await readSessionTranscriptHydrationRequest(
          {
            kind: "transcript-hydration",
            database: { agentId: scope.agentId, path: scope.storePath },
            target: scope,
            resolvedScope: { ...scope, path: scope.storePath },
            limits: { maxBytes, maxEvents: 10 },
            transcript: {
              sessionKey: scope.sessionKey,
              entryIds: [],
              includeMessagePresence: true,
            },
          },
          undefined,
          { runNativeSection: async (run) => run(), throwIfCancelled() {} },
        );
        if (result.kind !== "bounded") {
          throw new Error("Expected bounded transcript hydration");
        }
        return {
          result,
          probed: sql.queries.some((query) =>
            query.startsWith('select "seq" from "transcript_event_identities"'),
          ),
        };
      } finally {
        sql.restore();
      }
    };
    expect((await read()).result.transcript?.messagePresence).toBe(false);
    await replaceTranscriptEvents(scope, [
      events[0],
      metadata,
      {
        type: "message",
        id: "question",
        parentId: "metadata",
        message: { role: "user", content: "message ".repeat(128) },
      },
    ]);
    const included = await read();
    expect(included.result.transcript?.messagePresence).toBe(true);
    expect(included.probed).toBe(false);
    const omitted = await read(256);
    expect(omitted.result.snapshot.events).not.toContainEqual(
      expect.objectContaining({ type: "message" }),
    );
    expect(omitted.result.transcript?.messagePresence).toBe(true);
    expect(omitted.probed).toBe(true);
    await replaceTranscriptEvents(scope, [events[0]]);
    expect((await read()).result.transcript?.messagePresence).toBe(false);
  });
});

it("borrows one ready projection for anchors and payloads without extending its source or snapshot", async () => {
  await withTranscript("transcript-anchor-projection-borrow", async (scope) => {
    await replaceTranscriptEvents(scope, events);
    const database = openDatabase(scope);
    const resolved = { ...scope, path: database.path };
    database.db
      .prepare("UPDATE session_windows SET transcript_updated_at = 41 WHERE session_id = ?")
      .run(scope.sessionId);
    const selection = {
      entryIds: ["question", "answer"],
      afterSeq: 1,
      includeMessagesForRunId: "answer-run",
      includeWatermark: true,
    };
    const readMessage = await prepareMessageReader(selection);
    using peer = new DatabaseSync(database.path);
    using statements = trackProjection(database);
    let borrowed: CurrentTranscriptProjection | undefined;
    const result = readCurrentProjectionSnapshot(database, resolved, (projection) => {
      borrowed = projection;
      expect(projection.version).toMatchObject({ rawSeq: 4, updatedAt: 41 });
      peer
        .prepare("UPDATE session_windows SET transcript_updated_at = 42 WHERE session_id = ?")
        .run(scope.sessionId);
      peer
        .prepare("UPDATE session_transcript_index_state SET needs_rebuild = 1 WHERE session_id = ?")
        .run(scope.sessionId);
      for (const target of [
        { ...resolved, sessionId: "another-transcript" },
        { ...resolved, sessionKey: "agent:main:another-key" },
        { ...resolved, agentId: "another-agent" },
      ]) {
        expect(() => readFacts(database, target, selection, readMessage, projection)).toThrow(
          "differs from its selected session snapshot",
        );
      }
      expect(() =>
        readFacts(
          { ...database, path: `${database.path}.replacement` },
          resolved,
          selection,
          readMessage,
          projection,
        ),
      ).toThrow("differs from its selected session snapshot");
      return readFacts(database, resolved, selection, readMessage, projection);
    });
    expect(result).toMatchObject({
      kind: "value",
      value: {
        watermark: { generation: borrowed?.version.generation, maxSeq: 4 },
        anchors: [
          { entryId: "question", rawSeq: 1 },
          { entryId: "answer", rawSeq: 2 },
        ],
        tail: {
          entries: [
            {
              entryId: "answer",
              message: { role: "assistant", content: "answer" },
              anchor: { entryId: "answer", activeMessagePosition: 1 },
            },
            { entryId: "alternate", role: "assistant" },
          ],
        },
      },
    });
    expect(statements.counts).toEqual({ projection: 1, watermark: 0 });
    expect(borrowed).toBeDefined();
    expect(() => readActiveTranscriptEntryAnchorFromProjection(borrowed!, "question")).toThrow(
      "requires its selected session snapshot",
    );
    expect(() => readFacts(database, resolved, selection, readMessage)).toThrow(
      "projection is rebuilding",
    );
  });
});

it("rejects a physical replacement while target discovery is suspended", async () => {
  await withTranscript("transcript-anchors-replaced", async (scope, state) => {
    await replaceTranscriptEvents(scope, events);
    await closeOpenClawAgentDatabaseByPathAsync(scope.storePath);
    const held = createDeferred();
    const release = createDeferred();
    const resolve = targetWorker.resolveSessionSqliteTargetInWorker;
    const observation = vi
      .spyOn(targetWorker, "resolveSessionSqliteTargetInWorker")
      .mockImplementation(async (...args) => {
        const result = await resolve(...args);
        held.resolve();
        await release.promise;
        return result;
      });
    const pending = readAnchor({ ...scope, entryId: "question" });
    try {
      await awaitGateBeforeSettlement(
        held.promise,
        pending,
        "Anchor read settled without awaiting target discovery",
      );
      const originalPath = state.statePath("original.sqlite");
      await fs.rename(scope.storePath, originalPath);
      await fs.copyFile(originalPath, scope.storePath);
      release.resolve();
      await expect(pending).rejects.toThrow(
        "SQLite database file identity changed before existing-only open",
      );
    } finally {
      release.resolve();
      await pending.catch(() => undefined);
      observation.mockRestore();
    }
  });
});

it("joins the retained anchor reader when closing its original logical store path", async () => {
  await withOpenClawTestState({ label: "transcript-anchors-alias-close" }, async (state) => {
    const scope = { ...transcriptScope(state), storePath: state.statePath("custom.sqlite") };
    const requestedPath = state.statePath("custom.json");
    await replaceTranscriptEvents(scope, events);
    await closeOpenClawAgentDatabaseByPathAsync(scope.storePath);
    await expect(
      readAnchor({
        ...scope,
        storePath: requestedPath,
        entryId: "question",
      }),
    ).resolves.toMatchObject({ entryId: "question", storePath: scope.storePath });

    const claimSoleCustody = () => {
      const raw = new DatabaseSync(scope.storePath);
      try {
        // A retained WAL connection prevents sole custody even between read transactions.
        raw.exec("PRAGMA busy_timeout=0; PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE; COMMIT");
      } finally {
        raw.close();
      }
    };
    expect(claimSoleCustody).toThrow(/database is locked/);
    await closeOpenClawAgentDatabaseByPathAsync(requestedPath, scope.agentId);
    expect(claimSoleCustody).not.toThrow();
  });
});

it("keeps incognito anchors with their memory owner without creating durable state", async () => {
  await withOpenClawTestState({ label: "transcript-anchors-incognito" }, async (state) => {
    const scope = incognitoScope(state);
    await initializeIncognito(scope);
    await expect(readAnchor({ ...scope, entryId: "question" })).resolves.toMatchObject({
      entryId: "question",
      rawSeq: 1,
    });
    await expect(fs.readdir(state.stateDir, { recursive: true })).resolves.toEqual([]);
    memorySessionActorOwners.closeDatabase({ agentId: scope.agentId, path: scope.storePath });
    await expect(readAnchor({ ...scope, entryId: "question" })).resolves.toBeUndefined();
    await expect(fs.readdir(state.stateDir, { recursive: true })).resolves.toEqual([]);
  });
});

it("rejects memory owner replacement while acquiring transcript read custody", async () => {
  await withOpenClawTestState({ label: "transcript-memory-anchors-replaced" }, async (state) => {
    const scope = incognitoScope(state);
    await initializeIncognito(scope);
    const held = createDeferred();
    const release = createDeferred();
    const database = { agentId: scope.agentId, path: scope.storePath };
    const owner = memorySessionActorOwners.read(database)!;
    const acquire = owner.acquireExisting.bind(owner);
    const observation = vi
      .spyOn(owner, "acquireExisting")
      .mockImplementationOnce(async (...args) => {
        const actor = await acquire(...args);
        held.resolve();
        await release.promise;
        return actor;
      });
    const pending = readAnchors(scope, {
      entryIds: ["question"],
      afterSeq: 1,
      includeMessagesForRunId: "answer-run",
    });
    try {
      await awaitGateBeforeSettlement(
        held.promise,
        pending,
        "Transcript read custody was not acquired",
      );
      memorySessionActorOwners.closeDatabase(database);
      await initializeIncognito(scope);
      release.resolve();
      await expect(pending).rejects.toThrow("closed");
    } finally {
      release.resolve();
      await pending.catch(() => undefined);
      observation.mockRestore();
    }
  });
});
