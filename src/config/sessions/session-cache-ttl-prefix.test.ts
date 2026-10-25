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

it.each([false, true])(
  "selects cache-TTL dependencies without scanning messages (analyzed=%s)",
  async (analyzed) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const { database, scope } = createSessionCompoundWorkerFixture();
      const checkpoint = {
        type: "custom",
        id: "checkpoint",
        parentId: null,
        customType: "openclaw.cache-ttl",
        data: {
          prunedToolResults: [{ key: "synthetic-tool", mode: "soft" }],
          ambiguousToolResultBaseKeys: [],
          frozenToolResults: [],
        },
      };
      const messages = Array.from({ length: 1_000 }, (_, index) =>
        messageEvent(`message-${index}`, index === 0 ? checkpoint.id : `message-${index - 1}`, {
          role: "user",
          content: `synthetic-${index}`,
        }),
      );
      runOpenClawAgentWriteTransaction(
        () => {
          appendTranscriptEventsInTransaction(
            database,
            scope,
            [{ type: "session", id: scope.sessionId, version: 3 }, checkpoint, ...messages],
            { scheduleProjectionReconcile: false },
          );
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
      const statements: StatementSync[] = [];
      const spy = vi.spyOn(database.db, "prepare").mockImplementation((query) => {
        const statement = prepare(query);
        if (
          query.includes('"transcript_event_identities"') &&
          statement.columns().some(({ name }) => name === "navigation_valid")
        ) {
          statements.push(statement);
        }
        return statement;
      });
      try {
        const anchor = messages.at(-1)!;
        const prefix = withCurrentProjectionSnapshot(scope, (projection) =>
          readCacheTtlProjectionPrefix(projection, {
            activePosition: messages.length,
            id: anchor.id,
            entry: anchor,
          }),
        );
        expect(prefix).toEqual({ anchorIds: [anchor.id], entries: [checkpoint] });
        expect(statements).toHaveLength(1);
        const plan = prepare(`EXPLAIN QUERY PLAN ${statements[0]!.expandedSQL}`).all();
        const drivingSearch = plan.find(
          ({ detail }) => typeof detail === "string" && detail.startsWith("SEARCH "),
        )?.detail;
        expect(drivingSearch).toMatch(/\(session_id=\? AND event_type=\?/u);
      } finally {
        spy.mockRestore();
      }
    });
  },
);

it("decodes only the live cache-TTL prefix after sorting obsolete checkpoints", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const { database, scope } = createSessionCompoundWorkerFixture();
    const data = {
      prunedToolResults: [],
      ambiguousToolResultBaseKeys: [],
      frozenToolResults: [
        {
          key: "synthetic-tool",
          sourceHash: "synthetic-hash",
          texts: ["synthetic cached result ".repeat(256)],
        },
      ],
    };
    const obsolete = Array.from({ length: 64 }, (_, index) => ({
      type: "custom",
      id: `obsolete-${index}`,
      parentId: index === 0 ? null : `obsolete-${index - 1}`,
      customType: "openclaw.cache-ttl",
      data,
    }));
    const checkpoint = {
      type: "custom",
      id: "current-checkpoint",
      parentId: obsolete.at(-1)!.id,
      customType: "openclaw.cache-ttl",
      data,
    };
    const delta = {
      type: "custom",
      id: "current-delta",
      parentId: checkpoint.id,
      customType: "openclaw.cache-ttl",
      data: {
        cacheTtlDelta: {
          prunedToolResults: { set: [{ key: "new-tool", mode: "soft" }], remove: [] },
          ambiguousToolResultBaseKeys: { set: [], remove: [] },
          frozenToolResults: { set: [], remove: [] },
        },
      },
    };
    const touch = {
      type: "custom",
      id: "current-touch",
      parentId: delta.id,
      customType: "openclaw.cache-ttl",
      data: { timestamp: 1 },
    };
    const anchor = messageEvent("current-message", touch.id, {
      role: "user",
      content: "synthetic request",
    });
    runOpenClawAgentWriteTransaction(
      () =>
        appendTranscriptEventsInTransaction(
          database,
          scope,
          [
            { type: "session", id: scope.sessionId, version: 3 },
            ...obsolete,
            checkpoint,
            delta,
            touch,
            anchor,
          ],
          { scheduleProjectionReconcile: false },
        ),
      { agentId: database.agentId, path: database.path },
    );
    expect(
      database.db
        .prepare(
          "SELECT COUNT(*) AS count FROM transcript_events WHERE session_id = ? AND event_zstd IS NOT NULL",
        )
        .get(scope.sessionId),
    ).toEqual({ count: obsolete.length + 1 });
    const decompress = vi.spyOn(resolveZstdCodec(), "decompress");
    try {
      const prefix = withCurrentProjectionSnapshot(scope, (projection) =>
        readCacheTtlProjectionPrefix(projection, {
          activePosition: projection.state.activeEventCount - 1,
          id: anchor.id,
          entry: anchor,
        }),
      );
      expect(prefix).toEqual({ anchorIds: [anchor.id], entries: [checkpoint, delta] });
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
    const data = {
      prunedToolResults: [],
      ambiguousToolResultBaseKeys: [],
      frozenToolResults: [
        {
          key: "synthetic-tool",
          sourceHash: "synthetic-hash",
          texts: ["x".repeat(2 * 1024 * 1024)],
        },
      ],
    };
    const checkpoint = {
      type: "custom",
      id: "current-checkpoint",
      parentId: `obsolete-${obsoleteCount - 1}`,
      customType: "openclaw.cache-ttl",
      data,
    };
    const anchor = messageEvent("current-message", checkpoint.id, {
      role: "user",
      content: "synthetic request",
    });
    runOpenClawAgentWriteTransaction(
      () =>
        appendTranscriptEventsInTransaction(
          database,
          scope,
          (function* () {
            yield { type: "session", id: scope.sessionId, version: 3 };
            // The append owner flushes each MiB; neither fixture memory nor disk
            // contains a materialized GiB of obsolete checkpoint text.
            for (let index = 0; index < obsoleteCount; index++) {
              yield {
                type: "custom",
                id: `obsolete-${index}`,
                parentId: index === 0 ? null : `obsolete-${index - 1}`,
                customType: "openclaw.cache-ttl",
                data,
              };
            }
            yield checkpoint;
            yield anchor;
          })(),
          { scheduleProjectionReconcile: false },
        ),
      { agentId: database.agentId, path: database.path },
    );
    expect(
      database.db
        .prepare(
          "SELECT COUNT(*) AS count FROM transcript_events WHERE session_id = ? AND event_zstd IS NOT NULL",
        )
        .get(scope.sessionId),
    ).toEqual({ count: obsoleteCount + 1 });
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
      { anchorIds: [anchor.id], entries: [checkpoint] },
    ]);
  });
});
