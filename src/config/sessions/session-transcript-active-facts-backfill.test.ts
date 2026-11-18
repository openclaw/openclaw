import { channel } from "node:diagnostics_channel";
import fs from "node:fs";
import { expect, it, vi } from "vitest";
import { createDeferred, withinTest } from "../../../test/helpers/promise.js";
import {
  readSqliteDatabaseScopedWriteToken,
  readSqliteDatabaseWriteTokenForPath,
  sqliteSessionIdWriteScope,
} from "../../infra/sqlite-database-admission.js";
import {
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
} from "../../state/openclaw-agent-db.js";
import * as workerStores from "../../state/openclaw-agent-worker-store.js";
import { runOpenClawAgentWorkerWrite } from "../../state/openclaw-agent-write-admission.js";
import { requireNativeSqliteDatabase } from "../../test-utils/native-sqlite.js";
import { withOpenClawTestState as withState } from "../../test-utils/openclaw-test-state.js";
import { readRecentSessionTranscriptActiveEvents } from "./session-accessor.sqlite-active-events.js";
import { writeSessionEntry } from "./session-accessor.sqlite-entry-store.js";
import { updateSqliteTranscriptEventJsonInTransaction } from "./session-accessor.sqlite-transcript-rewrite.js";
import { appendTranscriptEventsInTransaction } from "./session-accessor.sqlite-transcript-store.js";
import { replaceTranscriptEvents } from "./session-accessor.sqlite-transcript-write.test-support.js";
import { createSessionActorFactory } from "./session-actor-durable.js";
import { resolveSessionColdArchivePath } from "./session-cold-storage-codec.js";
import {
  restoreSessionColdTranscript,
  runSessionColdStorageMaintenance,
} from "./session-cold-storage.js";
import {
  createSessionColdStorageFixture,
  currentId,
  historicalId,
  maintenanceConfig,
} from "./session-cold-storage.test-support.js";
import {
  backfillTranscriptActiveFactsBatchInTransaction as backfill,
  discoverTranscriptActiveFactsBackfillSessions as discover,
  probeTranscriptActiveFactsBackfill as probe,
} from "./session-transcript-active-facts-backfill.worker.js";
import { createSessionTranscriptFactsBackfill } from "./session-transcript-facts-backfill.js";
import { waitForSessionTranscriptIndexReconcile } from "./session-transcript-reconcile.js";
import { messageEvent } from "./transcript-message.test-support.js";
import { createTranscriptPayloadUpdater, prepareTranscriptPayload } from "./transcript-payload.js";

it.for(["missing", "corrupt"] as const)(
  "leaves a %s archive pending but completes healthy archives later in the same pass",
  (failure, { signal }) =>
    withState({ label: "cold-navigation-invalid", scenario: "minimal" }, async (state) => {
      const f = await createSessionColdStorageFixture(
        state.statePath("agents", "main", "agent", "openclaw-agent.sqlite"),
      );
      await runSessionColdStorageMaintenance({ config: maintenanceConfig(f.scope.storePath) });
      runOpenClawAgentWriteTransaction(({ db }) => {
        db.prepare("DELETE FROM transcript_events WHERE session_id = ?").run(historicalId);
        db.prepare("DELETE FROM session_transcript_index_state WHERE session_id = ?").run(
          historicalId,
        );
        db.prepare(
          "INSERT INTO session_windows(session_id,session_key,created_at,updated_at) VALUES('aaa-invalid',?,1,1)",
        ).run(f.scope.sessionKey);
        db.prepare(
          "INSERT INTO session_transcript_cold_archives " +
            "(session_id,generation,archive_name,archive_sha256,event_count,raw_bytes,archive_bytes,last_seq,archived_at,storage,archive_blob) " +
            "SELECT 'aaa-invalid',generation,?,?,event_count,raw_bytes,archive_bytes,last_seq,archived_at,storage,archive_blob " +
            "FROM session_transcript_cold_archives WHERE session_id = ?",
        ).run("0".repeat(64) + ".jsonl.zst", "0".repeat(64), historicalId);
      }, f.options);
      if (failure === "corrupt") {
        fs.writeFileSync(
          resolveSessionColdArchivePath(f.scope.storePath, "0".repeat(64) + ".jsonl.zst"),
          "invalid archive",
        );
      }
      const warn = vi.fn();
      const pass = createSessionTranscriptFactsBackfill({
        database: f.options,
        assertCurrent: () => signal.throwIfAborted(),
        signal,
        log: { info() {}, warn },
      });
      try {
        while (!(await pass.runBatch()).complete) {
          signal.throwIfAborted();
        }
        expect(warn).toHaveBeenCalledOnce();
        expect(
          discover(f.database())
            .filter((row) => row.coldNavigation)
            .map((row) => row.sessionId),
        ).toEqual(["aaa-invalid"]);
        expect(
          f
            .database()
            .prepare(
              "SELECT count(*) AS count FROM transcript_events WHERE session_id = 'aaa-invalid'",
            )
            .get(),
        ).toEqual({ count: 0 });
        expect(f.database().prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      } finally {
        await pass.close();
      }
    }),
);

it.for(["before", "after"] as const)(
  "restores old cold archives exactly %s background completion and resumes a cancelled pass",
  (when, { signal }) =>
    withState({ label: "cold-navigation-backfill", scenario: "minimal" }, async (state) => {
      const f = await createSessionColdStorageFixture(
        state.statePath("agents", "main", "agent", "openclaw-agent.sqlite"),
      );
      await runSessionColdStorageMaintenance({ config: maintenanceConfig(f.scope.storePath) });
      // Released archives predate retained navigation. The archive remains canonical.
      runOpenClawAgentWriteTransaction(({ db }) => {
        db.prepare("DELETE FROM transcript_events WHERE session_id = ?").run(historicalId);
        db.prepare("DELETE FROM session_transcript_index_state WHERE session_id = ?").run(
          historicalId,
        );
      }, f.options);
      const archives = () =>
        f.database().prepare("SELECT * FROM session_transcript_cold_archives").all();
      const originalArchives = archives();
      expect(discover(f.database())).toContainEqual(
        expect.objectContaining({
          sessionId: historicalId,
          coldNavigation: true,
        }),
      );
      const makePass = (passSignal: AbortSignal) =>
        createSessionTranscriptFactsBackfill({
          database: f.options,
          assertCurrent: () => signal.throwIfAborted(),
          signal: passSignal,
          log: { info() {}, warn() {} },
        });
      const cancellation = new AbortController();
      const cancelled = makePass(cancellation.signal);
      expect((await cancelled.runBatch()).complete).toBe(false);
      cancellation.abort();
      await cancelled.close();
      // A new owner rediscovers pending SQL state; it never depends on the lost cursor.
      const resumed = makePass(signal);
      try {
        expect((await resumed.runBatch()).complete).toBe(false);
        if (when === "after") {
          // Covered hot probes do not reserve the writer. Stop just before the cold batch.
          for (const session of discover(f.database()).filter((row) => !row.coldNavigation)) {
            expect(session.activeEventCount).toBeLessThan(8192);
            await resumed.runBatch();
          }
          const assertCurrent = () => signal.throwIfAborted();
          const authority = { assertCurrent, authorize: assertCurrent };
          const actor = await createSessionActorFactory(f.options).acquire(
            { database: { kind: "file" }, sessionKey: f.scope.sessionKey },
            { assertCurrent, assertReadable: assertCurrent },
          );
          const entered = createDeferred();
          const release = createDeferred();
          const order: string[] = [];
          let held: Promise<void> | undefined;
          let foreground: ReturnType<typeof actor.appendTranscriptEvent> | undefined;
          let background: ReturnType<typeof resumed.runBatch> | undefined;
          try {
            await actor.read(authority);
            held = runOpenClawAgentWorkerWrite(f.options, async () => {
              entered.resolve();
              await release.promise;
            });
            await withinTest(entered.promise, signal);
            foreground = actor
              .appendTranscriptEvent(
                {
                  commandId: "foreground-with-cold-backlog",
                  phaseId: "synthetic",
                  sessionId: currentId,
                  lifecycleRevision: null,
                  eventJson: JSON.stringify({
                    type: "model_change",
                    id: "foreground",
                    parentId: null,
                    timestamp: "2026-11-17T00:00:00.000Z",
                    provider: "synthetic",
                    modelId: "synthetic",
                  }),
                },
                authority,
              )
              .then((result) => {
                order.push("foreground");
                return result;
              });
            background = resumed.runBatch().then((result) => {
              order.push("background");
              return result;
            });
            release.resolve();
            await held;
            const appended = await foreground;
            expect(appended, JSON.stringify(appended)).toMatchObject({ kind: "committed" });
            await background;
            expect(order).toEqual(["foreground", "background"]);
          } finally {
            release.resolve();
            await Promise.allSettled([held, foreground, background]);
            await actor.release();
          }
        }
        if (when === "before") {
          // The already discovered cold target becomes hot before its queued publication.
          await restoreSessionColdTranscript(f.scope);
        }
        while (!(await resumed.runBatch()).complete) {
          signal.throwIfAborted();
        }
        if (when === "after") {
          expect(archives()).toEqual(originalArchives);
          expect(
            f
              .database()
              .prepare(
                "SELECT count(*) AS count FROM transcript_events WHERE session_id = ? AND event_json IS NULL AND event_zstd IS NULL",
              )
              .get(historicalId),
          ).toEqual({ count: 2 });
          expect(discover(f.database()).some((row) => row.coldNavigation)).toBe(false);
          // Losing the process cursor after publication does not duplicate completed work.
          const repeated = makePass(signal);
          try {
            while (!(await repeated.runBatch()).complete) {
              signal.throwIfAborted();
            }
          } finally {
            await repeated.close();
          }
          expect(archives()).toEqual(originalArchives);
          await restoreSessionColdTranscript(f.scope);
        }
        const restored = f.snapshot();
        for (const key of ["events", "identities", "active", "index"] as const) {
          expect(restored[key].filter((row) => row.session_id === historicalId)).toEqual(
            f.original[key].filter((row) => row.session_id === historicalId),
          );
        }
        expect(f.database().prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      } finally {
        await resumed.close();
      }
    }),
);

function fixture(env: NodeJS.ProcessEnv) {
  const scope = { agentId: "main", env, sessionId: "backfill", sessionKey: "agent:main:backfill" };
  const db = () => requireNativeSqliteDatabase(openOpenClawAgentDatabase(scope).db);
  const sessionToken = () =>
    readSqliteDatabaseScopedWriteToken(db(), [sqliteSessionIdWriteScope(scope.sessionId)]);
  const databaseToken = () =>
    readSqliteDatabaseWriteTokenForPath(openOpenClawAgentDatabase(scope).path);
  const write = <T>(run: Parameters<typeof runOpenClawAgentWriteTransaction<T>>[0]) =>
    runOpenClawAgentWriteTransaction(run, scope);
  const batch = (afterPosition = -1) =>
    write(({ db: database }) => backfill(database, { sessionId: scope.sessionId, afterPosition }));
  const drain = (afterPosition = -1) => {
    let result;
    let position = afterPosition;
    let rowsFilled = 0;
    let bytesRead = 0;
    do {
      result = batch(position);
      position = result.afterPosition;
      rowsFilled += result.rowsFilled;
      bytesRead += result.bytesRead;
    } while (!result.done);
    return { ...result, rowsFilled, bytesRead };
  };
  const facts = () =>
    db()
      .prepare(
        "SELECT seq, serialized_bytes, dependency_navigation_json FROM session_transcript_active_event_facts WHERE session_id = ? ORDER BY seq",
      )
      .all(scope.sessionId);
  const forgetFacts = () =>
    write(({ db: database }) =>
      database
        .prepare("DELETE FROM session_transcript_active_event_facts WHERE session_id = ?")
        .run(scope.sessionId),
    );
  const events = Array.from({ length: 40 }, (_, index) =>
    messageEvent(`entry-${index}`, index ? `entry-${index - 1}` : null, {
      role: "user",
      content: `message ${index}`,
    }),
  );
  return {
    scope,
    db,
    write,
    batch,
    drain,
    facts,
    forgetFacts,
    events,
    sessionToken,
    databaseToken,
  };
}

it("fills historical active facts exactly and resumes without rereading covered payloads", ({
  signal,
}) =>
  withState({ label: "active-facts-backfill", scenario: "minimal" }, async ({ env }) => {
    const f = fixture(env);
    await replaceTranscriptEvents(f.scope, f.events);
    f.forgetFacts();
    expect(f.facts()).toEqual([]);
    const before = readRecentSessionTranscriptActiveEvents(f.scope, 40);
    expect(discover(f.db())).toEqual([
      expect.objectContaining({ sessionId: f.scope.sessionId, activeEventCount: 40 }),
    ]);
    const sessionToken = f.sessionToken();
    const databaseToken = f.databaseToken();
    expect(sessionToken).toBeDefined();
    expect(databaseToken).toBeDefined();
    const first = f.batch();
    expect(f.sessionToken()).toBe(sessionToken);
    expect(f.databaseToken()).not.toBe(databaseToken);
    expect(first.rowsFilled).toBeGreaterThan(0);
    expect(first.rowsFilled).toBeLessThanOrEqual(16);
    expect(first.done).toBe(false);
    // Losing the process cursor starts an index-only coverage scan, not another payload fill.
    const openStore = workerStores.openOpenClawAgentSqliteWorkerStoreV2;
    // The first write can wait on worker boot and IO before its reply lands.
    let chargedMs = 27_000;
    const open = vi
      .spyOn(workerStores, "openOpenClawAgentSqliteWorkerStoreV2")
      .mockImplementation((options, authority, publication) =>
        openStore(options, authority, {
          ...publication,
          observeWriteExecution: (elapsedMs) => {
            publication.observeWriteExecution?.(Math.max(chargedMs, elapsedMs));
            chargedMs = 100;
          },
        }),
      );
    const resume = createSessionTranscriptFactsBackfill({
      database: f.scope,
      assertCurrent: () => signal.throwIfAborted(),
      signal,
      log: { info() {}, warn() {} },
    });
    try {
      await resume.runBatch();
      // A contended write yields a bounded pause, not 20x its charge.
      expect((await resume.runBatch()).delayMs).toBe(30_000);
      // A short native transaction still charges the writer's preparation/reply occupancy.
      expect((await resume.runBatch()).delayMs).toBeGreaterThanOrEqual(2_000);
      while (!(await resume.runBatch()).complete) {
        signal.throwIfAborted();
      }
      expect(open).toHaveBeenCalledOnce();
      expect(f.sessionToken()).toBe(sessionToken);
    } finally {
      await resume.close();
      open.mockRestore();
    }
    expect(f.facts()).toEqual(
      f.events.map((event, seq) => ({
        seq,
        serialized_bytes: Buffer.byteLength(JSON.stringify(event)) + 1,
        dependency_navigation_json: "{}",
      })),
    );
    expect(readRecentSessionTranscriptActiveEvents(f.scope, 40)).toEqual(before);
    expect(f.drain()).toMatchObject({ done: true, rowsFilled: 0, bytesRead: 0 });
  }));

it("probes covered windows without a writer and stops at the first uncovered row", () =>
  withState({ label: "active-facts-probe", scenario: "minimal" }, async ({ env }) => {
    const f = fixture(env);
    await replaceTranscriptEvents(f.scope, f.events);
    const cursor = { sessionId: f.scope.sessionId, afterPosition: -1 };
    const position = (seq: number) =>
      (
        f
          .db()
          .prepare(
            "SELECT active_position FROM session_transcript_active_events WHERE session_id = ? AND event_seq = ?",
          )
          .get(f.scope.sessionId, seq) as { active_position: number }
      ).active_position;
    // Ordinary writers already filled every fact: one probe retires the session.
    expect(probe(f.db(), cursor)).toMatchObject({ done: true, uncovered: false });
    f.write(({ db }) =>
      db
        .prepare(
          "DELETE FROM session_transcript_active_event_facts WHERE session_id = ? AND seq >= 25",
        )
        .run(f.scope.sessionId),
    );
    expect(probe(f.db(), cursor)).toEqual(
      expect.objectContaining({ done: false, uncovered: true, afterPosition: position(24) }),
    );
    // The write batch picks up exactly where the probe stopped.
    const filled = f.drain(position(24));
    expect(filled).toMatchObject({ done: true, rowsFilled: 15 });
    expect(probe(f.db(), cursor)).toMatchObject({ done: true, uncovered: false });
  }));

it("finishes covered probes without reserving the writer ahead of a queued actor append", ({
  signal,
}) =>
  withState({ label: "active-facts-restart", scenario: "minimal" }, async ({ env }) => {
    const f = fixture(env);
    for (const sessionId of ["covered-a", "covered-b", "covered-c"]) {
      f.write((database) =>
        writeSessionEntry(database, `agent:main:${sessionId}`, {
          sessionId,
          updatedAt: 1,
        }),
      );
      await replaceTranscriptEvents(
        { ...f.scope, sessionId, sessionKey: `agent:main:${sessionId}` },
        f.events,
      );
    }
    const reservations: unknown[] = [];
    const diagnostic = channel("openclaw.agent-database.reservation");
    const observe = (value: unknown) => reservations.push(value);
    const assertCurrent = () => signal.throwIfAborted();
    const authority = { assertCurrent, authorize: assertCurrent };
    const actor = await createSessionActorFactory({
      ...f.scope,
      path: openOpenClawAgentDatabase(f.scope).path,
    }).acquire(
      { database: { kind: "file" }, sessionKey: "agent:main:covered-a" },
      { assertCurrent, assertReadable: assertCurrent },
    );
    expect((await actor.read(authority)).entry?.sessionId).toBe("covered-a");
    const entered = createDeferred();
    const release = createDeferred();
    let held: Promise<void> | undefined;
    let append: ReturnType<typeof actor.appendTranscriptEvent> | undefined;
    const resume = createSessionTranscriptFactsBackfill({
      database: f.scope,
      assertCurrent: () => signal.throwIfAborted(),
      signal,
      log: { info() {}, warn() {} },
    });
    try {
      diagnostic.subscribe(observe);
      expect((await resume.runBatch()).complete).toBe(false);
      expect(reservations).toEqual([]);
      held = runOpenClawAgentWorkerWrite(f.scope, async () => {
        entered.resolve();
        await release.promise;
      });
      await withinTest(entered.promise, signal);
      append = actor.appendTranscriptEvent(
        {
          commandId: "foreground-append",
          phaseId: "synthetic",
          sessionId: "covered-a",
          lifecycleRevision: null,
          eventJson: JSON.stringify({
            type: "model_change",
            id: "foreground",
            parentId: "entry-39",
            timestamp: "2026-11-05T00:00:00.000Z",
            provider: "synthetic",
            modelId: "synthetic",
          }),
        },
        authority,
      );
      let result;
      do {
        signal.throwIfAborted();
        result = await withinTest(resume.runBatch(), signal);
      } while (!result.complete);
      expect(reservations).toEqual([]);
      release.resolve();
      await held;
      const appended = await append;
      expect(appended, JSON.stringify(appended)).toMatchObject({ kind: "committed" });
    } finally {
      diagnostic.unsubscribe(observe);
      release.resolve();
      await Promise.allSettled([held, append]);
      await resume.close();
      await actor.release();
    }
  }));

it("prioritizes recent active paths by size before larger inactive paths", () =>
  withState({ label: "active-facts-order", scenario: "minimal" }, async ({ env }) => {
    const f = fixture(env);
    const now = Date.now();
    for (const [sessionId, count, ageDays] of [
      ["old-large", 4, 9],
      ["recent-small", 1, 1],
      ["old-small", 2, 8],
      ["recent-large", 3, 6],
    ] as const) {
      await replaceTranscriptEvents(
        { ...f.scope, sessionId, sessionKey: `agent:main:${sessionId}` },
        f.events.slice(0, count),
      );
      f.write(({ db }) =>
        db
          .prepare("UPDATE session_transcript_index_state SET updated_at = ? WHERE session_id = ?")
          .run(now - ageDays * 86_400_000, sessionId),
      );
    }
    expect(discover(f.db()).map((row) => row.sessionId)).toEqual([
      "recent-large",
      "recent-small",
      "old-large",
      "old-small",
    ]);
  }));

it("leaves malformed historical rows unknown instead of inventing noncandidate facts", () =>
  withState({ label: "active-facts-malformed", scenario: "minimal" }, async ({ env }) => {
    const f = fixture(env);
    await replaceTranscriptEvents(f.scope, f.events.slice(0, 2));
    f.forgetFacts();
    f.write(({ db }) =>
      createTranscriptPayloadUpdater(
        db,
        f.scope.sessionId,
      )({ seq: 1, ...prepareTranscriptPayload(db, "{") }),
    );
    const result = f.drain();
    expect(result.rowsFilled).toBe(1);
    expect(f.facts()).toEqual([
      {
        seq: 0,
        serialized_bytes: Buffer.byteLength(JSON.stringify(f.events[0])) + 1,
        dependency_navigation_json: "{}",
      },
    ]);
  }));

it("uses current payloads after interleaved rewrites and appends and never resurrects deleted rows", () =>
  withState({ label: "active-facts-interleaving", scenario: "minimal" }, async ({ env }) => {
    const f = fixture(env);
    await replaceTranscriptEvents(f.scope, f.events);
    f.forgetFacts();
    const first = f.batch();
    const rewritten = {
      ...f.events[39]!,
      message: { role: "user", content: "rewritten historical payload" },
    };
    const appended = messageEvent("appended", "entry-39", {
      role: "assistant",
      content: "new reply",
    });
    f.write((database) => {
      updateSqliteTranscriptEventJsonInTransaction(
        database,
        f.scope.sessionId,
        [{ seq: 39, eventJson: JSON.stringify(rewritten) }],
        { indexUnchanged: true },
      );
      appendTranscriptEventsInTransaction(database, f.scope, [appended]);
    });
    f.drain(first.afterPosition);
    expect(f.facts()).toHaveLength(41);
    expect(f.facts()[39]).toMatchObject({
      seq: 39,
      serialized_bytes: Buffer.byteLength(JSON.stringify(rewritten)) + 1,
    });
    expect(f.facts()[40]).toMatchObject({
      seq: 40,
      serialized_bytes: Buffer.byteLength(JSON.stringify(appended)) + 1,
    });
    // A later rewrite of an already visited position clears its fact; a fresh pass
    // must fill the replacement, without trusting the old in-memory cursor.
    const sessionToken = f.sessionToken();
    expect(sessionToken).toBeDefined();
    f.write((database) =>
      updateSqliteTranscriptEventJsonInTransaction(
        database,
        f.scope.sessionId,
        [
          {
            seq: 0,
            eventJson: JSON.stringify({
              ...f.events[0]!,
              message: { role: "user", content: "earlier rewrite" },
            }),
          },
        ],
        { indexUnchanged: true },
      ),
    );
    expect(f.facts()).toHaveLength(40);
    expect(f.sessionToken()).not.toBe(sessionToken);
    f.drain();
    expect(f.facts()).toHaveLength(41);
    f.write((database) =>
      appendTranscriptEventsInTransaction(database, f.scope, [
        messageEvent("new-branch", null, { role: "user", content: "new branch" }),
      ]),
    );
    await waitForSessionTranscriptIndexReconcile(f.scope);
    f.batch(first.afterPosition);
    expect(f.facts().map((row) => row.seq)).toEqual([41]);
    await replaceTranscriptEvents(f.scope, []);
    expect(f.batch(first.afterPosition)).toMatchObject({ done: true, rowsFilled: 0 });
    expect(f.facts()).toEqual([]);
  }));

it("does not backfill cold navigation and resumes from canonical payloads after restoration", () =>
  withState({ label: "active-facts-cold", scenario: "minimal" }, async (state) => {
    const f = await createSessionColdStorageFixture(
      state.statePath("agents", "main", "agent", "openclaw-agent.sqlite"),
    );
    const batch = (afterPosition = -1) =>
      runOpenClawAgentWriteTransaction(
        ({ db }) => backfill(db, { sessionId: historicalId, afterPosition }),
        f.options,
      );
    runOpenClawAgentWriteTransaction(
      ({ db }) =>
        db
          .prepare("DELETE FROM session_transcript_active_event_facts WHERE session_id = ?")
          .run(historicalId),
      f.options,
    );
    const first = batch();
    expect(first.rowsFilled).toBe(1);
    await expect(
      runSessionColdStorageMaintenance({ config: maintenanceConfig(f.scope.storePath) }),
    ).resolves.toMatchObject({ archivedTranscripts: 1 });
    expect(batch(first.afterPosition)).toMatchObject({
      done: true,
      unavailable: true,
      rowsFilled: 0,
    });
    expect(discover(f.database()).map((row) => row.sessionId)).not.toContain(historicalId);
    expect(
      f
        .database()
        .prepare(
          "SELECT count(*) AS count FROM session_transcript_active_event_facts WHERE session_id = ?",
        )
        .get(historicalId),
    ).toEqual({ count: 0 });
    await restoreSessionColdTranscript(f.scope);
    let result = batch();
    while (!result.done) {
      result = batch(result.afterPosition);
    }
    expect(
      f
        .database()
        .prepare(
          "SELECT count(*) AS count FROM session_transcript_active_event_facts WHERE session_id = ?",
        )
        .get(historicalId),
    ).toEqual({ count: 2 });
  }));
