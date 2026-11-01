import type { StatementSync } from "node:sqlite";
import { expect, it, vi } from "vitest";
import { resolveZstdCodec } from "../../infra/zstd-codec.js";
import { runOpenClawAgentWriteTransaction } from "../../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { withCurrentProjectionSnapshot } from "./session-accessor.sqlite-active-projection.js";
import { appendTranscriptEventsInTransaction } from "./session-accessor.sqlite-transcript-store.js";
import { readCacheTtlProjectionPrefix } from "./session-cache-ttl-prefix.js";
import { createSessionCompoundWorkerFixture } from "./session-compound-worker.test-support.js";
import { reconcileSessionTranscriptIndexes } from "./session-transcript-reconcile.js";
import { withSessionHistoryWorkerDatabase } from "./session-transcript-worker-runtime.js";
import { messageEvent } from "./transcript-message.test-support.js";

type Fixture = Pick<ReturnType<typeof createSessionCompoundWorkerFixture>, "database" | "scope">;
function checkpoint(id: string, parentId: string | null, data: Record<string, unknown>) {
  return { type: "custom", id, parentId, customType: "openclaw.cache-ttl", data };
}
function frozenData(text: string) {
  return {
    prunedToolResults: [],
    ambiguousToolResultBaseKeys: [],
    frozenToolResults: [{ key: "synthetic-tool", sourceHash: "synthetic-hash", texts: [text] }],
  };
}
function append(
  { database, scope }: Fixture,
  events: Parameters<typeof appendTranscriptEventsInTransaction>[2],
) {
  runOpenClawAgentWriteTransaction(
    () =>
      appendTranscriptEventsInTransaction(database, scope, events, {
        scheduleProjectionReconcile: false,
      }),
    { agentId: database.agentId, path: database.path },
  );
}
function expectCompressed({ database, scope }: Fixture, count: number) {
  expect(
    database.db
      .prepare(
        "SELECT COUNT(*) AS count FROM transcript_events WHERE session_id = ? AND event_zstd IS NOT NULL",
      )
      .get(scope.sessionId),
  ).toEqual({ count });
}
function prefixAt(
  scope: Fixture["scope"],
  anchor: ReturnType<typeof messageEvent>,
  activePosition?: number,
) {
  return withCurrentProjectionSnapshot(scope, (projection) =>
    readCacheTtlProjectionPrefix(projection, {
      activePosition: activePosition ?? projection.state.activeEventCount - 1,
      id: anchor.id,
      entry: anchor,
    }),
  );
}

it.each([
  [false, false],
  [true, false],
  [false, true],
  [true, true],
])(
  "selects cache-TTL dependencies without repeated identity scans (analyzed=%s, legacy=%s)",
  async (analyzed, legacy) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const { database, scope } = createSessionCompoundWorkerFixture();
      const marker = checkpoint("checkpoint", null, {
        prunedToolResults: [{ key: "synthetic-tool", mode: "soft" }],
        ambiguousToolResultBaseKeys: [],
        frozenToolResults: [],
      });
      const messages = Array.from({ length: 1_000 }, (_, index) =>
        messageEvent(`message-${index}`, index === 0 ? marker.id : `message-${index - 1}`, {
          role: "user",
          content: `synthetic-${index}`,
        }),
      );
      runOpenClawAgentWriteTransaction(
        () => {
          appendTranscriptEventsInTransaction(
            database,
            scope,
            [{ type: "session", id: scope.sessionId, version: 3 }, marker, ...messages],
            { scheduleProjectionReconcile: false },
          );
          if (legacy) {
            // Imported prefixes can have a canonical header without an auxiliary identity.
            database.db
              .prepare("DELETE FROM transcript_event_identities WHERE session_id = ? AND seq = 0")
              .run(scope.sessionId);
          }
          if (analyzed) {
            // The same type-index seek must cover transcripts admitted without a backfill.
            database.db
              .prepare(`UPDATE transcript_events
              SET navigation_type = NULL, navigation_custom_type = NULL,
                  navigation_display = 0, message_role = NULL, navigation_last_type = NULL,
                  navigation_last_custom_type = NULL, navigation_valid = 1
              WHERE session_id = ?`)
              .run(scope.sessionId);
          }
        },
        { agentId: database.agentId, path: database.path },
      );
      if (analyzed) {
        database.db.exec("ANALYZE");
      }
      const prepare = database.db.prepare.bind(database.db);
      const statements = new Map<StatementSync, string>();
      const spy = vi.spyOn(database.db, "prepare").mockImplementation((query) => {
        const statement = prepare(query);
        if (
          query.includes('"transcript_event_identities"') &&
          statement.columns().some(({ name }) => name === "navigation_valid")
        ) {
          statements.set(statement, statement.expandedSQL);
          const observe = <Method extends "all" | "get" | "iterate">(
            observed: Pick<StatementSync, Method | "expandedSQL">,
            method: Method,
          ) => {
            observed[method] = new Proxy(observed[method], {
              apply(invoke, receiver: StatementSync, args) {
                const result = Reflect.apply(invoke, receiver, args);
                // Capture bindings before the executor releases the statement.
                statements.set(statement, observed.expandedSQL);
                return result;
              },
            });
          };
          for (const method of ["all", "get", "iterate"] as const) {
            observe(statement, method);
          }
        }
        return statement;
      });
      try {
        const anchor = messages.at(-1)!;
        expect(prefixAt(scope, anchor, messages.length)).toEqual({
          anchorIds: [anchor.id],
          entries: [marker],
        });
        expect(statements.size).toBe(1);
        const plan = prepare(`EXPLAIN QUERY PLAN ${statements.values().next().value!}`).all();
        const drivingSearch = plan.find(
          ({ detail }) => typeof detail === "string" && detail.startsWith("SEARCH "),
        )?.detail;
        if (legacy) {
          expect(
            plan.some(
              ({ detail }) =>
                typeof detail === "string" && detail.includes("(session_id=? AND seq=?) LEFT-JOIN"),
            ),
          ).toBe(true);
        } else {
          expect(drivingSearch).toMatch(/\(session_id=\? AND event_type=\?/u);
        }
      } finally {
        spy.mockRestore();
      }
    });
  },
);

it("decodes only the live cache-TTL prefix after sorting obsolete checkpoints", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const { database, scope } = createSessionCompoundWorkerFixture();
    const data = frozenData("synthetic cached result ".repeat(256));
    const obsolete = Array.from({ length: 64 }, (_, index) =>
      checkpoint(`obsolete-${index}`, index === 0 ? null : `obsolete-${index - 1}`, data),
    );
    const marker = checkpoint("current-checkpoint", obsolete.at(-1)!.id, data);
    const delta = checkpoint("current-delta", marker.id, {
      cacheTtlDelta: {
        prunedToolResults: { set: [{ key: "new-tool", mode: "soft" }], remove: [] },
        ambiguousToolResultBaseKeys: { set: [], remove: [] },
        frozenToolResults: { set: [], remove: [] },
      },
    });
    const touch = checkpoint("current-touch", delta.id, { timestamp: 1 });
    const anchor = messageEvent("current-message", touch.id, {
      role: "user",
      content: "synthetic request",
    });
    append({ database, scope }, [
      { type: "session", id: scope.sessionId, version: 3 },
      ...obsolete,
      marker,
      delta,
      touch,
      anchor,
    ]);
    expectCompressed({ database, scope }, obsolete.length + 1);
    const decompress = vi.spyOn(resolveZstdCodec(), "decompress");
    try {
      expect(prefixAt(scope, anchor)).toEqual({ anchorIds: [anchor.id], entries: [marker, delta] });
      expect(decompress).toHaveBeenCalledTimes(1);
    } finally {
      decompress.mockRestore();
    }
  });
});

it("hydrates a checkpoint-heavy transcript within the native worker heap limit", async ({
  signal,
}) => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const { database, scope } = createSessionCompoundWorkerFixture();
    const obsoleteCount = 512;
    const data = frozenData("x".repeat(2 * 1024 * 1024));
    const marker = checkpoint("current-checkpoint", `obsolete-${obsoleteCount - 1}`, data);
    const anchor = messageEvent("current-message", marker.id, {
      role: "user",
      content: "synthetic request",
    });
    append(
      { database, scope },
      (function* () {
        yield { type: "session", id: scope.sessionId, version: 3 };
        // The append owner flushes each MiB; neither fixture memory nor disk
        // contains a materialized GiB of obsolete checkpoint text.
        for (let index = 0; index < obsoleteCount; index++) {
          yield checkpoint(`obsolete-${index}`, index === 0 ? null : `obsolete-${index - 1}`, data);
        }
        yield marker;
        yield anchor;
      })(),
    );
    expectCompressed({ database, scope }, obsoleteCount + 1);
    await reconcileSessionTranscriptIndexes({
      agentId: scope.agentId,
      path: database.path,
      env: state.env,
      preferredSessionId: scope.sessionId,
      signal,
    });

    // The production owner launches its real transcript worker with unchanged
    // resourceLimits; only the newest checkpoint belongs in this small read.
    const result = await withSessionHistoryWorkerDatabase(
      { agentId: scope.agentId, path: database.path, env: state.env },
      (owner) =>
        owner.readTranscript(
          {
            target: scope,
            resolvedScope: {
              agentId: scope.agentId,
              path: database.path,
              sessionId: scope.sessionId,
              sessionKey: scope.sessionKey,
            },
            limits: { maxBytes: 1024, maxEvents: 1 },
          },
          signal,
        ),
    );
    if (result.kind !== "bounded") {
      throw new Error("Expected bounded worker hydration");
    }
    expect(result.snapshot.events).toHaveLength(2);
    expect(result.snapshot.events).toContainEqual(anchor);
    expect(result.snapshot.cacheTtlProjectionPrefixes).toEqual([
      { anchorIds: [anchor.id], entries: [marker] },
    ]);
  });
});
