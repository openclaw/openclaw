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
import { readSessionTranscriptBoundedActiveContextCore } from "./session-accessor.sqlite-active-context.js";
import type { TranscriptEvent } from "./session-accessor.sqlite-contract.js";
import {
  readCurrentProjectionSnapshot,
  type CurrentTranscriptProjection,
} from "./session-accessor.sqlite-projection-read.js";
import {
  appendTranscriptEventsInTransaction,
  rewriteSqliteTranscriptEventRowsInTransaction,
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
import { withSessionActorTransactionState } from "./session-actor-transaction.js";
import { SessionTranscriptColdError } from "./session-cold-storage-state.js";
import { createSessionCompoundWorkerFixture } from "./session-compound-worker.test-support.js";
import { readSessionTranscriptAccountingFromProjection } from "./session-transcript-accounting.js";
import {
  markSessionTranscriptIndexDirtyInTransaction,
  reconcileSessionTranscriptIndexInTransaction,
} from "./session-transcript-index.js";
import { withSessionTranscriptProjectionReceipt } from "./session-transcript-projection-facts-scope.js";
import type { SessionTranscriptProjectionReceipt } from "./session-transcript-projection-facts.types.js";
import { runWithSessionTranscriptReadFence } from "./session-transcript-read-fence.js";
import { collectSessionEntryLookupKeys } from "./store-entry.js";

// mock-isolation: These owner transactions do not exercise background entry maintenance.
vi.mock("./session-accessor.sqlite-maintenance-kick.js", () => ({
  kickSessionEntryMaintenanceAfterWrite() {},
}));
// mock-isolation: Keep background disk-budget eviction outside the projection-receipt proof.
vi.mock("./session-history-eviction.js", () => ({ kickSessionHistoryDiskBudgetMaintenance() {} }));

const user = {
  type: "message",
  id: "user",
  parentId: null,
  message: { role: "user", content: "question" },
};
const assistant = {
  type: "message",
  id: "assistant",
  parentId: "user",
  message: { role: "assistant", content: "answer" },
};

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
  if (typeof identity.identity !== "string") {
    throw new Error("Projection receipt proof requires a physical database");
  }
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
    if (value === undefined) {
      throw new Error("Projection receipt proof requires an admitted write token");
    }
    return value;
  };
  const hydrate = () =>
    hydrateSessionActorState(database, target, { epoch: "projection-proof", sequence: 0 }, token());
  const receipt = (
    state: SessionActorStoredState = hydrate(),
  ): SessionTranscriptProjectionReceipt => {
    const facts = projectSessionActorHotState(state).transcript.projection;
    if (!facts) {
      throw new Error("Hydrated actor did not publish projection facts");
    }
    return {
      path: database.path,
      sessionId: scope.sessionId,
      writeScopes,
      writeToken: token(),
      facts,
    };
  };
  const read = (facts?: SessionTranscriptProjectionReceipt) =>
    withSessionTranscriptProjectionReceipt(facts, () =>
      readCurrentProjectionSnapshot(database, scope, (projection) => ({
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
      expect(replica.beginRead().install(f.hydrate().hot)).toBe(true);
      const receipt = readSessionActorProjectionReceipt(locator);
      if (!receipt) {
        throw new Error("Installed actor projection was not available to the history reader");
      }
      expect(
        readSessionActorProjectionReceipt({ ...locator, sessionId: "another-session" }),
      ).toBeUndefined();
      const observed = f.observe();
      try {
        expect(f.read(receipt)).toMatchObject({
          kind: "value",
          value: { version: { rawSeq: 1 }, state: { activeMessageCount: 2 } },
        });
        expect(observed.counts.snapshot).toBe(0);
        f.write(() => f.append([{ ...user, id: "next", parentId: "assistant" }]));
        expect(f.read(receipt)).toMatchObject({
          kind: "value",
          value: { version: { rawSeq: 2 }, state: { activeMessageCount: 3 } },
        });
        expect(observed.counts.snapshot).toBe(1);
      } finally {
        observed.restore();
      }
    } finally {
      replica.close();
    }
  });
});

it("keeps transcript receipts through unrelated trajectory append and trim", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const f = fixture();
    const receipt = f.receipt();
    const observed = f.observe();
    try {
      for (const id of ["first", "replacement"]) {
        appendSqliteTrajectoryRuntimeEventsWithWriter(
          {
            sessionId: f.scope.sessionId,
            events: [{ runId: id, ts: "2026-10-12T00:00:00Z", line: JSON.stringify({ id }) }],
            discardPrevious: true,
          },
          (_label, write) => f.write(() => write(f.database)),
        );
        expect(f.read(receipt)).toMatchObject({
          kind: "value",
          value: { version: { rawSeq: 1 }, state: { activeMessageCount: 2 } },
        });
      }
      expect(observed.counts.snapshot).toBe(0);
      expect(
        f.database.db
          .prepare("SELECT event_json FROM trajectory_runtime_events WHERE session_id = ?")
          .all(f.scope.sessionId),
      ).toEqual([{ event_json: JSON.stringify({ id: "replacement" }) }]);
      f.write(() => f.append([{ ...user, id: "next", parentId: "assistant" }]));
      expect(f.read(receipt)).toMatchObject({
        kind: "value",
        value: { version: { rawSeq: 2 }, state: { activeMessageCount: 3 } },
      });
      expect(observed.counts.snapshot).toBe(1);
    } finally {
      observed.restore();
    }
  });
});

it("serves committed actor postimages without projection SQL and confines facts to the request", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const f = fixture();
    const actor = f.hydrate();
    const initial = f.receipt(actor);
    const observed = f.observe();
    try {
      expect(f.read(initial)).toMatchObject({
        kind: "value",
        value: {
          version: { rawSeq: 1 },
          state: { activeMessageCount: 2, leafEventId: "assistant" },
        },
      });
      expect(f.read(initial)).toMatchObject({ kind: "value" });
      expect(observed.counts.snapshot).toBe(0);

      f.write(() =>
        withSessionActorTransactionState(f.database, actor, () =>
          f.append([{ ...user, id: "next", parentId: "assistant" }]),
        ),
      );
      const committed = f.receipt(actor);
      observed.counts.snapshot = 0;
      expect(f.read(committed)).toMatchObject({
        kind: "value",
        value: { version: { rawSeq: 2 }, state: { activeMessageCount: 3, leafEventId: "next" } },
      });
      expect(observed.counts.snapshot).toBe(0);

      expect(() =>
        withSessionTranscriptProjectionReceipt(committed, () => {
          throw new Error("request canceled");
        }),
      ).toThrow("request canceled");
      expect(f.read()).toMatchObject({ kind: "value", value: { version: { rawSeq: 2 } } });
      expect(observed.counts.snapshot).toBe(1);
      withSessionTranscriptProjectionReceipt(committed, () => {
        expect(f.read()).toMatchObject({ kind: "value" });
        readCurrentProjectionSnapshot(f.database, f.scope, () => undefined);
      });
      expect(observed.counts.snapshot).toBe(2);
    } finally {
      observed.restore();
    }
  });
});

it.each([
  { kind: "append", event: { ...user, id: "next", parentId: "assistant" }, leaf: "next" },
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
        f.write(() =>
          reconcileSessionTranscriptIndexInTransaction(f.database.db, f.scope.sessionId),
        );
      }
      const observed = f.observe();
      try {
        expect(f.read(retained)).toMatchObject({
          kind: "value",
          value: { version: { rawSeq: 2 }, state: { indexedSeq: 2, leafEventId: leaf } },
        });
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
        }
      } finally {
        observed.restore();
      }
    });
  },
);

it("invalidates exact rewrites and dirty/rebuilt projections even when the latest sequence is unchanged", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const f = fixture();
    const retained = f.receipt();
    f.write(() =>
      rewriteSqliteTranscriptEventRowsInTransaction(f.database, f.scope, [
        {
          seq: 1,
          expectedEventJson: JSON.stringify(assistant),
          event: { ...assistant, message: { role: "assistant", content: "corrected" } },
        },
      ]),
    );
    const rewritten = f.read(retained);
    expect(rewritten).toMatchObject({ kind: "value", value: { version: { rawSeq: 1 } } });
    if (rewritten.kind !== "value") {
      throw new Error("Exact rewrite left the projection unavailable");
    }
    expect(rewritten.value.version.generation).not.toBe(retained.facts.generation);
    const beforeDirty = f.receipt();
    f.write(() => {
      markSessionTranscriptIndexDirtyInTransaction(f.database.db, f.scope.sessionId);
      expect(f.read(beforeDirty)).toEqual({ kind: "unavailable" });
    });
    expect(f.read(beforeDirty)).toEqual({ kind: "unavailable" });
    const dirty = f.receipt();
    f.write(() => reconcileSessionTranscriptIndexInTransaction(f.database.db, f.scope.sessionId));
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

it("does not let a snapshot consumer mutate the next reader's retained facts", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const f = fixture();
    f.write(() => f.append([{ type: "reset", id: "reset", parentId: "assistant", reason: "new" }]));
    const receipt = f.receipt();
    withSessionTranscriptProjectionReceipt(receipt, () => {
      readCurrentProjectionSnapshot(
        f.database,
        f.scope,
        (projection: CurrentTranscriptProjection) => {
          projection.state.activeMessageCount = 999;
          if (projection.latestIndexedReset) {
            projection.latestIndexedReset.seq = 999;
          }
        },
      );
      expect(f.read(receipt)).toMatchObject({
        kind: "value",
        value: { state: { activeMessageCount: 2 }, latestIndexedReset: { seq: 2 } },
      });
    });
  });
});

it("covers the first append after hydrating an empty actor", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const f = fixture([]);
    const actor = f.hydrate();
    f.write(() => withSessionActorTransactionState(f.database, actor, () => f.append([user])));
    const receipt = f.receipt(actor);
    expect(receipt.facts.contextMetadata).toMatchObject({
      eventCount: 1,
      sizeBytes: Buffer.byteLength(JSON.stringify(user)) + 1,
    });
    expect(
      withSessionTranscriptProjectionReceipt(receipt, () =>
        readSessionTranscriptBoundedActiveContextCore(f.scope, {
          maxBytes: 1_000_000,
          maxEvents: 100,
        }),
      ).events,
    ).toEqual([user]);
  });
});

it("uses committed bounded metadata for context selection and accounting without rereading it", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const f = fixture();
    const actor = f.hydrate();
    const readContext = (receipt: SessionTranscriptProjectionReceipt, maxEvents = 100) =>
      withSessionTranscriptProjectionReceipt(receipt, () =>
        readSessionTranscriptBoundedActiveContextCore(f.scope, { maxBytes: 1_000_000, maxEvents }),
      );
    const readAccounting = (receipt: SessionTranscriptProjectionReceipt) =>
      withSessionTranscriptProjectionReceipt({ ...receipt, contextOnly: true }, () =>
        readCurrentProjectionSnapshot(f.database, f.scope, (projection) =>
          readSessionTranscriptAccountingFromProjection(projection, {
            includeByteSize: true,
            includeUsage: true,
            includeTurnTaint: true,
          }),
        ),
      );
    const receipt = f.receipt(actor);
    const withoutMetadata = {
      ...receipt,
      facts: { ...receipt.facts, contextMetadata: undefined },
    };
    const reads = trackSqliteStatementExecutions(
      f.database.db,
      ["header", "boundary", "rows", "injection", "aggregate", "projection", "payload"],
      (query) => {
        if (query.includes('"reset_active_position"')) {
          return "projection";
        }
        if (query.includes('"boundary_count"')) {
          return "injection";
        }
        if (query.startsWith('select "active"."active_position", "identity"."event_type"')) {
          return "boundary";
        }
        if (query.startsWith('select "seq", "navigation_valid"')) {
          return "header";
        }
        if (query.includes('as "size_bytes"')) {
          return "aggregate";
        }
        if (
          query.startsWith('select "active"."event_seq", "active"."active_position"') &&
          query.includes('as "serialized_bytes"')
        ) {
          return "rows";
        }
        if (query.includes('as "event_json"')) {
          return "payload";
        }
        return null;
      },
    );
    try {
      const expected = readContext(withoutMetadata);
      expect(reads.counts).toMatchObject({ header: 1, boundary: 1, rows: 1, injection: 1 });
      const expectedAccounting = readAccounting(withoutMetadata);
      const before = { ...reads.counts };
      expect(readContext(receipt)).toEqual(expected);
      expect(readAccounting(receipt)).toEqual(expectedAccounting);
      expect(reads.counts).toMatchObject({
        header: before.header,
        boundary: before.boundary,
        rows: before.rows,
        injection: before.injection,
        aggregate: before.aggregate,
        projection: before.projection + 1,
      });
      expect(reads.counts.payload).toBeGreaterThan(before.payload);
      expect(readContext(receipt, 1)).toMatchObject({ events: [assistant], truncated: true });

      const next = {
        ...user,
        id: "next",
        parentId: "assistant",
        message: { role: "user", content: "é🦞" },
      };
      f.write(() => withSessionActorTransactionState(f.database, actor, () => f.append([next])));
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
    } finally {
      reads.restore();
    }
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
      withSessionTranscriptProjectionReceipt(receipt, () =>
        readSessionTranscriptBoundedActiveContextCore(f.scope, { maxBytes, maxEvents: 100 }),
      );
    expect(read(headerBytes + answerBytes)).toMatchObject({
      events: [header, assistant],
      serializedBytes: headerBytes + answerBytes,
      truncated: true,
    });
    expect(() => read(headerBytes - 1)).toThrow("header exceeds");
    if (!receipt.facts.generation) {
      throw new Error("Transcript fixture requires a generation");
    }
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
