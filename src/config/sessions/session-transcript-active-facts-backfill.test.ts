import { expect, it } from "vitest";
import {
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
} from "../../state/openclaw-agent-db.js";
import { requireNativeSqliteDatabase } from "../../test-utils/native-sqlite.js";
import { withOpenClawTestState as withState } from "../../test-utils/openclaw-test-state.js";
import { readRecentSessionTranscriptActiveEvents } from "./session-accessor.sqlite-active-events.js";
import { updateSqliteTranscriptEventJsonInTransaction } from "./session-accessor.sqlite-transcript-rewrite.js";
import { appendTranscriptEventsInTransaction } from "./session-accessor.sqlite-transcript-store.js";
import { replaceTranscriptEvents } from "./session-accessor.sqlite-transcript-write.test-support.js";
import {
  restoreSessionColdTranscript,
  runSessionColdStorageMaintenance,
} from "./session-cold-storage.js";
import {
  createSessionColdStorageFixture,
  historicalId,
  maintenanceConfig,
} from "./session-cold-storage.test-support.js";
import {
  backfillTranscriptActiveFactsBatchInTransaction as backfill,
  discoverTranscriptActiveFactsBackfillSessions as discover,
} from "./session-transcript-active-facts-backfill.worker.js";
import { createSessionTranscriptFactsBackfill } from "./session-transcript-facts-backfill.js";
import { waitForSessionTranscriptIndexReconcile } from "./session-transcript-reconcile.js";
import { messageEvent } from "./transcript-message.test-support.js";
import { createTranscriptPayloadUpdater, prepareTranscriptPayload } from "./transcript-payload.js";

function fixture(env: NodeJS.ProcessEnv) {
  const scope = { agentId: "main", env, sessionId: "backfill", sessionKey: "agent:main:backfill" };
  const db = () => requireNativeSqliteDatabase(openOpenClawAgentDatabase(scope).db);
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
  return { scope, db, write, batch, drain, facts, forgetFacts, events };
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
    const first = f.batch();
    expect(first.rowsFilled).toBeGreaterThan(0);
    expect(first.rowsFilled).toBeLessThanOrEqual(16);
    expect(first.done).toBe(false);
    // Losing the process cursor starts an index-only coverage scan, not another payload fill.
    const resume = createSessionTranscriptFactsBackfill({
      database: f.scope,
      assertCurrent: () => signal.throwIfAborted(),
      log: { info() {} },
    });
    while (!(await resume(signal))) {
      signal.throwIfAborted();
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
