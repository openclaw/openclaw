import assert from "node:assert/strict";
import { expect, it, vi } from "vitest";
import { trackSqliteStatementExecutions } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import {
  readSqliteDatabaseScopedWriteToken,
  sqliteSessionIdWriteScope,
  withSqliteDatabaseWriteScope,
} from "../../infra/sqlite-database-admission.js";
import { readOpenClawAgentDatabaseIdentity } from "../../state/openclaw-agent-db-identity.js";
import { runOpenClawAgentWriteTransaction } from "../../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { appendSqliteTrajectoryRuntimeEventsWithWriter } from "../../trajectory/runtime-store.sqlite.js";
import { readSessionTranscriptBoundedActiveContextCore as readBoundedContext } from "./session-accessor.sqlite-active-context.js";
import type { TranscriptEvent } from "./session-accessor.sqlite-contract.js";
import {
  readCurrentProjectionSnapshot as readProjection,
  type CurrentTranscriptProjection,
} from "./session-accessor.sqlite-projection-read.js";
import {
  appendTranscriptEventsInTransaction,
  rewriteSqliteTranscriptEventRowsInTransaction as rewriteEvents,
} from "./session-accessor.sqlite-transcript-store.js";
import type { SessionActorTarget } from "./session-actor-contract.js";
import type { SessionActorStoredState } from "./session-actor-hydration.types.js";
import {
  hydrateSessionActorState,
  projectSessionActorHotState,
} from "./session-actor-hydration.worker.js";
import {
  createSessionActorReplica,
  readSessionActorProjectionReceipt,
} from "./session-actor-replica.js";
import { withSessionActorTransactionState as withActorTransaction } from "./session-actor-transaction.js";
import { SessionTranscriptColdError } from "./session-cold-storage-state.js";
import { createSessionCompoundWorkerFixture } from "./session-compound-worker.test-support.js";
import { readSessionTranscriptAccountingFromProjection } from "./session-transcript-accounting.js";
import {
  markSessionTranscriptIndexDirtyInTransaction as markIndexDirty,
  reconcileSessionTranscriptIndexInTransaction as reconcileIndex,
} from "./session-transcript-index.js";
import { withSessionTranscriptProjectionReceipt as withReceipt } from "./session-transcript-projection-facts-scope.js";
import type { SessionTranscriptProjectionReceipt } from "./session-transcript-projection-facts.types.js";
import { runWithSessionTranscriptReadFence } from "./session-transcript-read-fence.js";
import { collectSessionEntryLookupKeys } from "./store-entry.js";
import { messageEvent } from "./transcript-message.test-support.js";

// mock-isolation: These owner transactions do not exercise background entry maintenance.
vi.mock("./session-accessor.sqlite-maintenance-kick.js", () => ({
  kickSessionEntryMaintenanceAfterWrite() {},
}));
// mock-isolation: Keep background disk-budget eviction outside the projection-receipt proof.
vi.mock("./session-history-eviction.js", () => ({ kickSessionHistoryDiskBudgetMaintenance() {} }));

const expectedProjection = (rawSeq: number, state: Record<string, unknown>) => ({
  kind: "value",
  value: { version: { rawSeq }, state },
});

const user = messageEvent("user", null, { role: "user", content: "question" });
const assistant = messageEvent("assistant", "user", { role: "assistant", content: "answer" });

function fixture(initialEvents: TranscriptEvent[] = [user, assistant]) {
  const { database, scope: originalScope } = createSessionCompoundWorkerFixture();
  const scope = { ...originalScope, path: database.path };
  const options = { agentId: database.agentId, path: database.path };
  const write = <T>(run: () => T) => runOpenClawAgentWriteTransaction(run, options);
  const append = (events: TranscriptEvent[]) =>
    appendTranscriptEventsInTransaction(database, scope, events, {
      scheduleProjectionReconcile: false,
    });
  write(() => append(initialEvents));
  const identity = readOpenClawAgentDatabaseIdentity(database);
  assert(
    typeof identity.identity === "string",
    "Projection receipt proof requires a physical database",
  );
  const target = {
    sessionKey: scope.sessionKey,
    database: {
      kind: "file",
      physicalIdentity: identity.identity,
      birthtime: identity.birthtime,
      nativeLocation: database.path,
    },
  } satisfies SessionActorTarget;
  const writeScopes = [
    ...collectSessionEntryLookupKeys(scope.sessionKey),
    sqliteSessionIdWriteScope(scope.sessionId),
  ];
  const token = () => {
    const value = readSqliteDatabaseScopedWriteToken(database.db, writeScopes);
    assert(value !== undefined, "Projection receipt proof requires an admitted write token");
    return value;
  };
  const hydrate = () =>
    hydrateSessionActorState(database, target, { epoch: "projection-proof", sequence: 0 }, token());
  const receipt = (
    state: SessionActorStoredState = hydrate(),
  ): SessionTranscriptProjectionReceipt => {
    const facts = projectSessionActorHotState(state).transcript.projection;
    assert(facts, "Hydrated actor did not publish projection facts");
    return {
      sessionId: scope.sessionId,
      writeScopes,
      writeToken: token(),
      facts,
    };
  };
  const read = (facts?: SessionTranscriptProjectionReceipt) =>
    withReceipt(facts, () =>
      readProjection(database, scope, (projection) => ({
        version: projection.version,
        state: projection.state,
        latestIndexedReset: projection.latestIndexedReset,
        hasUnindexedPrefix: projection.hasUnindexedPrefix,
      })),
    );
  const observe = () =>
    trackSqliteStatementExecutions(database.db, ["snapshot"], (query) =>
      query.includes('"reset_active_position"') ? "snapshot" : null,
    );
  return { database, scope, target, identity, write, append, hydrate, receipt, read, observe };
}

function withObservedSnapshot(
  f: ReturnType<typeof fixture>,
  run: (observed: ReturnType<ReturnType<typeof fixture>["observe"]>) => void,
) {
  const observed = f.observe();
  try {
    run(observed);
  } finally {
    observed.restore();
  }
}

it("carries a retained actor projection into the history reader and rejects it after a write", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const f = fixture();
    const replica = createSessionActorReplica({
      target: f.target,
      lifetime: { assertCurrent() {}, assertReadable() {} },
      currentGeneration: () => f.identity.incarnation,
    });
    const locator = {
      path: f.database.path,
      sessionKey: f.scope.sessionKey,
      sessionId: f.scope.sessionId,
    };
    try {
      expect(replica.beginRead()(f.hydrate().hot)).toBe(true);
      const receipt = readSessionActorProjectionReceipt(locator);
      assert(receipt, "Installed actor projection was not available to the history reader");
      expect(
        readSessionActorProjectionReceipt({ ...locator, sessionId: "another-session" }),
      ).toBeUndefined();
      withObservedSnapshot(f, (observed) => {
        expect(f.read(receipt)).toMatchObject(expectedProjection(1, { activeMessageCount: 2 }));
        expect(observed.counts.snapshot).toBe(0);
        f.write(() => f.append([{ ...user, id: "next", parentId: "assistant" }]));
        expect(f.read(receipt)).toMatchObject(expectedProjection(2, { activeMessageCount: 3 }));
        expect(observed.counts.snapshot).toBe(1);
      });
    } finally {
      replica.close();
    }
  });
});

it("keeps transcript receipts through unrelated trajectory append and trim", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const f = fixture();
    const receipt = f.receipt();
    withObservedSnapshot(f, (observed) => {
      for (const id of ["first", "replacement"]) {
        appendSqliteTrajectoryRuntimeEventsWithWriter(
          {
            sessionId: f.scope.sessionId,
            events: [{ runId: id, ts: "2026-10-12T00:00:00Z", line: JSON.stringify({ id }) }],
            discardPrevious: true,
          },
          f.database,
          (_label, write) => f.write(() => write(f.database)),
        );
        expect(f.read(receipt)).toMatchObject(expectedProjection(1, { activeMessageCount: 2 }));
      }
      expect(observed.counts.snapshot).toBe(0);
      expect(
        f.database.db
          .prepare("SELECT event_json FROM trajectory_runtime_events WHERE session_id = ?")
          .all(f.scope.sessionId),
      ).toEqual([{ event_json: JSON.stringify({ id: "replacement" }) }]);
      f.write(() => f.append([{ ...user, id: "next", parentId: "assistant" }]));
      expect(f.read(receipt)).toMatchObject(expectedProjection(2, { activeMessageCount: 3 }));
      expect(observed.counts.snapshot).toBe(1);
    });
  });
});

it("serves committed actor postimages without projection SQL and confines facts to the request", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const f = fixture();
    const actor = f.hydrate();
    const initial = f.receipt(actor);
    withObservedSnapshot(f, (observed) => {
      expect(f.read(initial)).toMatchObject(
        expectedProjection(1, { activeMessageCount: 2, leafEventId: "assistant" }),
      );
      expect(f.read(initial)).toMatchObject({ kind: "value" });
      expect(observed.counts.snapshot).toBe(0);

      f.write(() =>
        withActorTransaction(f.database, actor, () =>
          f.append([{ ...user, id: "next", parentId: "assistant" }]),
        ),
      );
      const committed = f.receipt(actor);
      observed.counts.snapshot = 0;
      expect(f.read(committed)).toMatchObject(
        expectedProjection(2, { activeMessageCount: 3, leafEventId: "next" }),
      );
      expect(observed.counts.snapshot).toBe(0);

      expect(() =>
        withReceipt(committed, () => {
          throw new Error("request canceled");
        }),
      ).toThrow("request canceled");
      expect(f.read()).toMatchObject({ kind: "value", value: { version: { rawSeq: 2 } } });
      expect(observed.counts.snapshot).toBe(1);
      withReceipt(committed, () => {
        expect(f.read()).toMatchObject({ kind: "value" });
        readProjection(f.database, f.scope, () => undefined);
      });
      expect(observed.counts.snapshot).toBe(2);
    });
  });
});

it.each([
  {
    kind: "rewind",
    event: { type: "leaf", id: "rewind", parentId: "assistant", targetId: "user" },
    leaf: "user",
  },
  {
    kind: "reset",
    event: { type: "reset", id: "reset", parentId: "assistant", reason: "new" },
    leaf: "reset",
  },
  {
    kind: "compaction",
    event: {
      type: "compaction",
      id: "compact",
      parentId: "assistant",
      summary: "summary",
      firstKeptEntryId: "user",
      tokensBefore: 10,
    },
    leaf: "compact",
  },
])(
  "discards pre-$kind receipts after the transcript writer commits",
  async ({ kind, event, leaf }) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const f = fixture();
      const retained = f.receipt();
      f.write(() => f.append([event]));
      if (kind === "rewind") {
        expect(f.read(retained)).toEqual({ kind: "unavailable" });
        f.write(() => reconcileIndex(f.database.db, f.scope.sessionId));
      }
      withObservedSnapshot(f, (observed) => {
        expect(f.read(retained)).toMatchObject(
          expectedProjection(2, { indexedSeq: 2, leafEventId: leaf }),
        );
        expect(observed.counts.snapshot).toBe(1);
        const refreshed = f.receipt();
        expect(f.read(refreshed)).toMatchObject({
          kind: "value",
          value: { state: { indexedSeq: 2, leafEventId: leaf } },
        });
        expect(observed.counts.snapshot).toBe(1);
        if (kind === "reset") {
          expect(f.read(refreshed)).toMatchObject({
            value: { latestIndexedReset: { seq: 2, active_position: 2, event_type: "reset" } },
          });
          withReceipt(refreshed, () => {
            readProjection(f.database, f.scope, (projection: CurrentTranscriptProjection) => {
              projection.state.activeMessageCount = 999;
              if (projection.latestIndexedReset) {
                projection.latestIndexedReset.seq = 999;
              }
            });
            expect(f.read(refreshed)).toMatchObject({
              kind: "value",
              value: { state: { activeMessageCount: 2 }, latestIndexedReset: { seq: 2 } },
            });
          });
        }
      });
    });
  },
);

it("invalidates exact rewrites and dirty/rebuilt projections even when the latest sequence is unchanged", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const f = fixture();
    const retained = f.receipt();
    f.write(() =>
      rewriteEvents(f.database, f.scope, [
        {
          seq: 1,
          expectedEventJson: JSON.stringify(assistant),
          event: { ...assistant, message: { role: "assistant", content: "corrected" } },
        },
      ]),
    );
    const rewritten = f.read(retained);
    expect(rewritten).toMatchObject({ kind: "value", value: { version: { rawSeq: 1 } } });
    assert(rewritten.kind === "value", "Exact rewrite left the projection unavailable");
    expect(rewritten.value.version.generation).not.toBe(retained.facts?.generation);
    const beforeDirty = f.receipt();
    f.write(() => {
      markIndexDirty(f.database.db, f.scope.sessionId);
      expect(f.read(beforeDirty)).toEqual({ kind: "unavailable" });
    });
    expect(f.read(beforeDirty)).toEqual({ kind: "unavailable" });
    const dirty = f.receipt();
    f.write(() => reconcileIndex(f.database.db, f.scope.sessionId));
    expect(f.read(dirty)).toMatchObject({
      kind: "value",
      value: { state: { needsRebuild: false, activeMessageCount: 2, indexedSeq: 1 } },
    });
  });
});

it("rejects stale hot and cold receipts after archive-marker writes and restore", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const f = fixture();
    const hot = f.receipt();
    // The cold-storage writer owns this scoped marker effect; codec/file custody is tested there.
    const writeMarker = (write: () => void) =>
      f.write(() =>
        withSqliteDatabaseWriteScope(
          f.database.db,
          [sqliteSessionIdWriteScope(f.scope.sessionId)],
          write,
        ),
      );
    writeMarker(() => {
      f.database.db
        .prepare(`INSERT INTO session_transcript_cold_archives
        (session_id, generation, archive_name, archive_sha256, event_count, raw_bytes,
         archive_bytes, last_seq, archived_at, storage, archive_blob)
        VALUES (?, 'generation', 'archive.zst', ?, 2, 1, 1, 1, 1, 'file', NULL)`)
        .run(f.scope.sessionId, "0".repeat(64));
    });
    expect(() => f.read(hot)).toThrow(SessionTranscriptColdError);
    const cold = f.receipt();
    expect(() => f.read(cold)).toThrow(SessionTranscriptColdError);
    writeMarker(() => {
      f.database.db
        .prepare("DELETE FROM session_transcript_cold_archives WHERE session_id = ?")
        .run(f.scope.sessionId);
    });
    expect(f.read(cold)).toMatchObject({
      kind: "value",
      value: { state: { activeMessageCount: 2 } },
    });
  });
});

it("covers the first append after hydrating an empty actor", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const f = fixture([]);
    const actor = f.hydrate();
    f.write(() => withActorTransaction(f.database, actor, () => f.append([user])));
    const receipt = f.receipt(actor);
    expect(receipt.facts?.contextMetadata).toBeUndefined();
    expect(
      withReceipt(receipt, () =>
        readBoundedContext(f.scope, {
          maxBytes: 1_000_000,
          maxEvents: 100,
        }),
      ),
    ).toMatchObject({
      events: [user],
      serializedBytes: Buffer.byteLength(JSON.stringify(user)) + 1,
    });
  });
});

it("preserves bounded context and accounting with compact committed receipts", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const f = fixture();
    const actor = f.hydrate();
    const readContext = (receipt?: SessionTranscriptProjectionReceipt, maxEvents = 100) =>
      withReceipt(receipt, () => readBoundedContext(f.scope, { maxBytes: 1_000_000, maxEvents }));
    const readAccounting = (receipt?: SessionTranscriptProjectionReceipt) =>
      withReceipt(receipt && { ...receipt, contextOnly: true }, () =>
        readProjection(f.database, f.scope, (projection) =>
          readSessionTranscriptAccountingFromProjection(projection, {
            includeByteSize: true,
            includeUsage: true,
            includeTurnTaint: true,
          }),
        ),
      );
    const receipt = f.receipt(actor);
    expect(readContext(receipt)).toEqual(readContext());
    expect(readAccounting(receipt)).toEqual(readAccounting());
    expect(readContext(receipt, 1)).toMatchObject({ events: [assistant], truncated: true });

    const next = {
      ...user,
      id: "next",
      parentId: "assistant",
      message: { role: "user", content: "é🦞" },
    };
    f.write(() => withActorTransaction(f.database, actor, () => f.append([next])));
    const committed = f.receipt(actor);
    expect(readContext(committed).events).toEqual([user, assistant, next]);
    expect(readAccounting(committed)).toMatchObject({
      kind: "value",
      value: {
        eventCount: 3,
        byteSize: [user, assistant, next].reduce(
          (bytes, event) => bytes + Buffer.byteLength(JSON.stringify(event)) + 1,
          0,
        ),
      },
    });
  });
});

it("keeps stored header bytes, event limits and admitted-turn fences in the covered reader", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const header = { type: "session", version: 3, id: "header", cwd: "/synthetic/é" };
    const f = fixture([header, user, assistant]);
    const receipt = f.receipt();
    const headerBytes = Buffer.byteLength(JSON.stringify(header)) + 1;
    const answerBytes = Buffer.byteLength(JSON.stringify(assistant)) + 1;
    const read = (maxBytes: number) =>
      withReceipt(receipt, () => readBoundedContext(f.scope, { maxBytes, maxEvents: 100 }));
    expect(read(headerBytes + answerBytes)).toMatchObject({
      events: [header, assistant],
      serializedBytes: headerBytes + answerBytes,
      truncated: true,
    });
    expect(() => read(headerBytes - 1)).toThrow("header exceeds");
    assert(receipt.facts?.generation, "Transcript fixture requires a generation");
    const fence = {
      agentId: f.database.agentId,
      sessionKey: f.scope.sessionKey,
      sessionId: f.scope.sessionId,
      storePath: f.database.path,
      role: "user" as const,
      entryId: "user",
      logicalTurnId: "user-turn",
      rawSeq: 1,
      activeMessagePosition: 0,
      effectiveParentId: null,
      generation: receipt.facts.generation,
    };
    expect(runWithSessionTranscriptReadFence(fence, () => read(1_000_000))).toMatchObject({
      events: [header],
      serializedBytes: headerBytes,
    });
  });
});
