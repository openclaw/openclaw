import fs from "node:fs";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { trackSqliteStatementExecutions } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import * as boardStore from "../../boards/sqlite-board-store.kernel.js";
import { requireNodeSqlite } from "../../infra/node-sqlite.js";
import { runExclusiveSessionLifecycleMutation } from "../../sessions/session-lifecycle-admission.js";
import { closeOpenClawAgentDatabaseByPathAsync } from "../../state/openclaw-agent-db-lifecycle.js";
import { OpenClawAgentDatabaseReadOnlyScope } from "../../state/openclaw-agent-db-readonly-scope.js";
import { withOpenClawAgentDatabaseReadOnly } from "../../state/openclaw-agent-db-readonly.js";
import {
  openOpenClawAgentDatabase,
  resolveOpenClawAgentSqlitePath,
} from "../../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { normalizeSessionDeliveryState } from "../../utils/delivery-context.shared.js";
import * as entryCache from "./session-accessor.sqlite-entry-cache.js";
import {
  deleteSessionEntryRows,
  writeSessionEntry,
} from "./session-accessor.sqlite-entry-store.js";
import { replaceSessionEntrySync } from "./session-accessor.sqlite-entry.js";
import { resolveSqliteScope, toDatabaseOptions } from "./session-accessor.sqlite-scope.js";
import { readSessionBackingFacts } from "./session-backing-facts.js";
import { captureCanonicalSessionReaderContinuation } from "./session-canonical-key.js";
import { prepareSessionDeliveryGeneration } from "./session-delivery-generation.js";
import {
  readSessionEntriesFromStoreInWorker,
  withSessionEntriesFromStoresInWorker,
} from "./session-entry-read-runtime.js";
import {
  readExactSessionEntriesWithLifecycle,
  readSessionRowDatabaseFacts,
} from "./session-entry-read.worker.js";
import * as sharingKernel from "./session-sharing-store.kernel.js";
import { addSessionMember } from "./session-sharing-store.native.js";

it("publishes exact-read admission only after commit and reuses it on the retained reader", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async ({ env }) => {
    const database = openOpenClawAgentDatabase({ agentId: "main", env });
    const sessionKey = "agent:main:cron:admission";
    writeSessionEntry(database, sessionKey, { sessionId: "admitted-session", updatedAt: 1 });
    const target = { agentId: database.agentId, path: database.path };
    await closeOpenClawAgentDatabaseByPathAsync(database.path, database.agentId);
    const retained = new OpenClawAgentDatabaseReadOnlyScope();
    try {
      retained.run(target, () => {
        const opened = withOpenClawAgentDatabaseReadOnly((reader) => reader, { ...target, env });
        if (!opened.found) {
          throw new Error("Expected the seeded read-only database");
        }
        const reader = opened.value;
        const read = () =>
          readExactSessionEntriesWithLifecycle({
            kind: "session-exact-entries",
            database: target,
            env,
            sessionKeys: [sessionKey],
          });
        const commitFailure = new Error("Injected snapshot commit failure");
        const exec = reader.db.exec.bind(reader.db);
        const failingCommit = vi.spyOn(reader.db, "exec").mockImplementation((sql) => {
          if (sql === "COMMIT") {
            throw commitFailure;
          }
          return exec(sql);
        });
        try {
          expect(read).toThrow(commitFailure);
          expect(reader.db.isTransaction).toBe(false);
          expect(captureCanonicalSessionReaderContinuation(reader)).toBeUndefined();
        } finally {
          failingCommit.mockRestore();
        }
        const queries = trackSqliteStatementExecutions(reader.db, ["validation"], (sql) =>
          sql.includes("retained_window") ||
          sql.includes('from "session_canonical_validation_pending"')
            ? "validation"
            : null,
        );
        try {
          expect(read().entries[0]?.entry.sessionId).toBe("admitted-session");
          expect(queries.counts.validation).toBeGreaterThan(0);
          const admission = captureCanonicalSessionReaderContinuation(reader);
          expect(admission).toBeDefined();
          admission?.release();
          queries.counts.validation = 0;
          expect(read().entries[0]?.entry.sessionId).toBe("admitted-session");
          expect(queries.counts.validation).toBe(0);
        } finally {
          queries.restore();
        }
      });
    } finally {
      retained.close();
    }
  });
});

it("keeps pending archive facts in the lifecycle snapshot and observes later commits", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async ({ env }) => {
    const database = openOpenClawAgentDatabase({ agentId: "main", env });
    const sessionKey = "agent:main:archive-admission";
    writeSessionEntry(database, sessionKey, { sessionId: "live-session", updatedAt: 1 });
    const target = { agentId: database.agentId, path: database.path };
    await closeOpenClawAgentDatabaseByPathAsync(database.path, database.agentId);
    const peer = new (requireNodeSqlite().DatabaseSync)(target.path);
    const retained = new OpenClawAgentDatabaseReadOnlyScope();
    const readEntries = entryCache.readExactSessionEntryCandidatesInDatabase;
    const concurrentCommit = vi
      .spyOn(entryCache, "readExactSessionEntryCandidatesInDatabase")
      .mockImplementationOnce((...args) => {
        const selected = readEntries(...args);
        peer
          .prepare(
            "INSERT INTO session_transcript_archives (session_id, generation, session_key, reason, encoding, archive_blob, archive_sha256, archive_name, created_at) VALUES ('deleted-session', 'generation', ?, 'deleted', 'identity', X'', ?, 'pending.jsonl', 1)",
          )
          .run(sessionKey, "0".repeat(64));
        return selected;
      });
    try {
      retained.run(target, () => {
        const read = () =>
          readExactSessionEntriesWithLifecycle({
            kind: "session-exact-entries",
            database: target,
            env,
            sessionKeys: [sessionKey],
            projection: "lifecycle",
          });
        expect(read()).toMatchObject({
          entries: [{ sessionKey, entry: { sessionId: "live-session" } }],
          pendingArchives: false,
        });
        expect(read().pendingArchives).toBe(true);
        peer.exec("UPDATE session_transcript_archives SET published_at = 2");
        expect(read().pendingArchives).toBe(false);
      });
    } finally {
      concurrentCommit.mockRestore();
      retained.close();
      peer.close();
    }
  });
});

it("reads row metadata, board presence, and cold summary position from one snapshot", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async ({ env }) => {
    const database = openOpenClawAgentDatabase({ agentId: "main", env });
    const sessionKey = "agent:main:cron:row-facts";
    const sessionId = "row-facts-session";
    const siblingKey = "agent:main:cron:without-summary";
    writeSessionEntry(database, sessionKey, {
      sessionId,
      updatedAt: 1,
      label: "before",
      activitySummary: {
        version: 1,
        text: "Stored summary",
        updatedAt: 1,
        sessionId,
        generation: "hot-generation",
        maxSeq: 41,
        leafEntryId: null,
        coveredMessages: 1,
        totalMessages: 1,
        omittedContent: false,
      },
    });
    writeSessionEntry(database, siblingKey, { sessionId: "without-summary", updatedAt: 1 });
    database.db
      .prepare(
        "INSERT INTO board_tabs (session_key, tab_id, title, position, created_by, revision) VALUES (?, 'tab', 'Board', 0, 'user', 0)",
      )
      .run(sessionKey);
    database.db
      .prepare(
        "INSERT INTO transcript_rewrite_watermarks (session_id, generation, updated_at) VALUES (?, 'hot-generation', 1)",
      )
      .run(sessionId);
    database.db
      .prepare(
        "INSERT INTO session_transcript_cold_archives (session_id, generation, archive_name, archive_sha256, event_count, raw_bytes, archive_bytes, last_seq, archived_at, storage) VALUES (?, 'archive-generation', 'synthetic-archive', ?, 1, 0, 0, 41, 1, 'file')",
      )
      .run(sessionId, "0".repeat(64));
    const target = { agentId: database.agentId, path: database.path };
    await closeOpenClawAgentDatabaseByPathAsync(database.path, database.agentId);
    const peer = new (requireNodeSqlite().DatabaseSync)(target.path);
    const retained = new OpenClawAgentDatabaseReadOnlyScope();
    const readBoards = boardStore.readBoardSessionKeys;
    const concurrentCommit = vi
      .spyOn(boardStore, "readBoardSessionKeys")
      .mockImplementationOnce((reader, key) => {
        // Commit after entry decoding; the remaining facts must retain its original snapshot.
        peer.exec("BEGIN IMMEDIATE");
        try {
          peer
            .prepare(
              "UPDATE session_nodes SET entry_json = json_set(entry_json, '$.label', 'after') WHERE session_key = ?",
            )
            .run(sessionKey);
          peer.prepare("DELETE FROM board_tabs WHERE session_key = ?").run(sessionKey);
          peer
            .prepare(
              "UPDATE transcript_rewrite_watermarks SET generation = 'next-generation' WHERE session_id = ?",
            )
            .run(sessionId);
          peer
            .prepare(
              "UPDATE session_transcript_cold_archives SET last_seq = 42 WHERE session_id = ?",
            )
            .run(sessionId);
          peer.exec("COMMIT");
        } catch (error) {
          peer.exec("ROLLBACK");
          throw error;
        }
        return readBoards(reader, key);
      });
    try {
      retained.run(target, () => {
        const read = () =>
          readSessionRowDatabaseFacts({
            kind: "session-row-facts",
            database: target,
            env,
            sessionKeys: [sessionKey, siblingKey, "agent:main:cron:absent"],
          });
        const first = read();
        expect(first.rows).toHaveLength(2);
        expect(first.rows[0]).toMatchObject({
          sessionKey,
          entry: { label: "before" },
          hasBoard: true,
          activitySummaryWatermark: { generation: "hot-generation", maxSeq: 41 },
        });
        expect(first.rows[1]).toMatchObject({
          sessionKey: siblingKey,
          hasBoard: false,
        });
        expect(first.rows[1]).not.toHaveProperty("activitySummaryWatermark");
        expect(read().rows[0]).toMatchObject({
          entry: { label: "after" },
          hasBoard: false,
          activitySummaryWatermark: { generation: "next-generation", maxSeq: 42 },
        });
      });
    } finally {
      concurrentCommit.mockRestore();
      retained.close();
      peer.close();
    }
  });
});

it.each(["worker", "synchronous", "row-facts"] as const)(
  "refuses unavailable backing metadata in the %s reader instead of reporting missing sessions",
  async (reader) => {
    await withOpenClawTestState({ scenario: "minimal" }, async ({ env }) => {
      const storePath = resolveOpenClawAgentSqlitePath({ agentId: "main", env });
      const sessionKeys = ["agent:main:subagent:retained"];
      const read = () =>
        reader === "row-facts"
          ? readSessionRowDatabaseFacts({
              kind: "session-row-facts",
              database: { agentId: "main", path: storePath },
              env,
              sessionKeys,
            }).rows
          : reader === "worker"
            ? readExactSessionEntriesWithLifecycle({
                kind: "session-exact-entries",
                database: { agentId: "main", path: storePath },
                env,
                sessionKeys,
                projection: "backing",
              }).entries
            : readSessionBackingFacts({ storePath, sessionKeys, env });
      expect(read()).toEqual([]);
      fs.mkdirSync(path.dirname(storePath), { recursive: true });
      fs.writeFileSync(storePath, "");
      expect(read).toThrow("Session metadata unavailable (schema-missing)");
    });
  },
);

it("closes worker-prepared authority synchronously before queued consumers can reuse it", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async ({ env }) => {
    const database = openOpenClawAgentDatabase({ agentId: "main", env });
    const sessionKey = "agent:main:consumer";
    writeSessionEntry(database, sessionKey, { sessionId: "consumer-session", updatedAt: 1 });
    const input = { agentId: "main", storePath: database.path, sessionKeys: [sessionKey], env };
    const order: string[] = [];
    await withSessionEntriesFromStoresInWorker(
      [input],
      ([read]) => {
        order.push("consume");
        read!.assertCurrent();
      },
      {
        beforeConsume: async () => {
          order.push("prepare");
          await Promise.resolve();
        },
      },
    );
    expect(order).toEqual(["prepare", "consume"]);
    let queued: Promise<void> | undefined;
    await withSessionEntriesFromStoresInWorker([input], ([read]) => {
      expect(read!.result.entries[0]?.entry.sessionId).toBe("consumer-session");
      read!.assertCurrent();
      queued = Promise.resolve().then(() => {
        expect(read!.assertCurrent).toThrow("consumer is no longer active");
      });
    });
    await queued;
    const result = await readSessionEntriesFromStoreInWorker(input);
    expect(Object.keys(result).toSorted()).toEqual(["entries", "kind", "lifecycleTimestamps"]);
    await expect(withSessionEntriesFromStoresInWorker([input], async () => {})).rejects.toThrow(
      "consumers must remain synchronous",
    );
  });
});

function seedRetainedSessionHeader(
  database: ReturnType<typeof openOpenClawAgentDatabase>,
  sessionKey: string,
  sessionId: string,
) {
  writeSessionEntry(database, sessionKey, { sessionId, updatedAt: 1 });
  database.db
    .prepare("UPDATE session_nodes SET entry_json = '{}' WHERE session_key = ?")
    .run(sessionKey);
  database.db
    .prepare("UPDATE session_nodes SET entry_valid = -1 WHERE session_key = ?")
    .run(sessionKey);
}

it.each(["sharing", "list"] as const)(
  "returns %s metadata through the worker boundary",
  async (projection) => {
    await withOpenClawTestState({ scenario: "minimal" }, async ({ env }) => {
      const database = openOpenClawAgentDatabase({ agentId: "main", env });
      const sessionKey = "agent:main:retained-header";
      seedRetainedSessionHeader(database, sessionKey, "retained-session");
      writeSessionEntry(database, "agent:main:ordinary", {
        sessionId: "ordinary-session",
        updatedAt: 1,
        skillsSnapshot: { prompt: "saved prompt stays in storage", skills: [] },
      });
      const result = await readSessionEntriesFromStoreInWorker({
        agentId: "main",
        storePath: database.path,
        env,
        sessionKeys: [sessionKey, "agent:main:ordinary", "agent:main:absent"],
        projection,
      });
      expect(result.entries.map((row) => row.sessionKey)).toEqual(["agent:main:ordinary"]);
      expect(result.entries[0]?.entry).not.toHaveProperty("skillsSnapshot");
      if (projection === "sharing") {
        expect(result.sharing?.placeholders).toEqual([
          { sessionKey, sessionId: "retained-session" },
        ]);
        expect(result.sharing?.members).toEqual([
          { sessionKey: "agent:main:ordinary", identityIds: [] },
        ]);
      } else {
        expect(result.sharing).toBeUndefined();
      }
    });
  },
);

it("preserves listing validation of dirty siblings in selected worker reads", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async ({ env }) => {
    const database = openOpenClawAgentDatabase({ agentId: "main", env });
    const sessionKey = "agent:main:selected";
    const sibling = "agent:main:matrix:channel:!mixed:example.org";
    for (const key of [sessionKey, sibling]) {
      writeSessionEntry(database, key, { sessionId: key, updatedAt: 1 });
    }
    const read = (projection: "list" | "backing") =>
      readSessionEntriesFromStoreInWorker({
        agentId: "main",
        storePath: database.path,
        env,
        sessionKeys: [sessionKey],
        projection,
      });
    for (const projection of ["list", "backing"] as const) {
      expect((await read(projection)).entries).toHaveLength(1);
    }
    database.db.prepare("UPDATE session_nodes SET entry_json = ? WHERE session_key = ?").run(
      JSON.stringify({
        sessionId: sibling,
        updatedAt: 1,
        delivery: normalizeSessionDeliveryState({
          context: { channel: "matrix", to: "!Mixed:example.org" },
        }),
      }),
      sibling,
    );
    database.db
      .prepare("UPDATE session_nodes SET entry_valid = 1 WHERE session_key = ?")
      .run(sibling);
    for (const projection of ["list", "backing"] as const) {
      await expect(read(projection)).rejects.toThrow("non-canonical persisted row");
    }
  });
});

it("reads retained headers and entries from one committed sharing snapshot", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async ({ env }) => {
    const database = openOpenClawAgentDatabase({ agentId: "main", env });
    const sessionKey = "agent:main:retained-snapshot";
    seedRetainedSessionHeader(database, sessionKey, "retained-session");
    const target = { agentId: database.agentId, path: database.path };
    await closeOpenClawAgentDatabaseByPathAsync(database.path, database.agentId);
    const peer = new (requireNodeSqlite().DatabaseSync)(target.path);
    const retained = new OpenClawAgentDatabaseReadOnlyScope();
    const readEntries = entryCache.readExactSessionEntryCandidatesInDatabase;
    const concurrentCommit = vi
      .spyOn(entryCache, "readExactSessionEntryCandidatesInDatabase")
      .mockImplementationOnce((...args) => {
        const selected = readEntries(...args);
        peer.exec("BEGIN IMMEDIATE");
        try {
          peer
            .prepare("UPDATE session_nodes SET entry_json = ? WHERE session_key = ?")
            .run(JSON.stringify({ sessionId: "retained-session", updatedAt: 1 }), sessionKey);
          peer
            .prepare("UPDATE session_nodes SET entry_valid = 1 WHERE session_key = ?")
            .run(sessionKey);
          peer.exec("COMMIT");
        } catch (error) {
          peer.exec("ROLLBACK");
          throw error;
        }
        return selected;
      });
    try {
      retained.run(target, () => {
        const read = () =>
          readExactSessionEntriesWithLifecycle({
            kind: "session-exact-entries",
            database: target,
            env,
            sessionKeys: [sessionKey],
            projection: "sharing",
          });
        const first = read();
        expect(first.entries).toEqual([]);
        expect(first.sharing?.placeholders).toEqual([
          { sessionKey, sessionId: "retained-session" },
        ]);
        const next = read();
        expect(next.entries).toMatchObject([
          { sessionKey, entry: { sessionId: "retained-session" } },
        ]);
        expect(next.sharing?.placeholders).toEqual([]);
      });
    } finally {
      concurrentCommit.mockRestore();
      retained.close();
      peer.close();
    }
  });
});

it.each(["unsettled marker", "missing window"] as const)(
  "refuses an uncertified retained header with %s instead of reporting absence",
  async (defect) => {
    await withOpenClawTestState({ scenario: "minimal" }, async ({ env }) => {
      const database = openOpenClawAgentDatabase({ agentId: "main", env });
      const sessionKey = "agent:main:uncertified-header";
      seedRetainedSessionHeader(database, sessionKey, "uncertified-session");
      if (defect === "unsettled marker") {
        database.db
          .prepare("UPDATE session_nodes SET entry_valid = 0 WHERE session_key = ?")
          .run(sessionKey);
      } else {
        database.db.prepare("DELETE FROM session_windows WHERE session_key = ?").run(sessionKey);
      }
      await expect(
        readSessionEntriesFromStoreInWorker({
          agentId: "main",
          storePath: database.path,
          env,
          sessionKeys: [sessionKey],
          projection: "sharing",
        }),
      ).rejects.toThrow();
    });
  },
);

it.each(["durable", "incognito"] as const)(
  "keeps %s delivery generations live only through same-generation writes",
  async (kind) => {
    await withOpenClawTestState({ scenario: "minimal" }, async ({ env }) => {
      const sessionKey =
        kind === "incognito" ? "agent:main:dashboard:incognito-delivery" : "agent:main:delivery";
      const scope = { agentId: "main", sessionKey, env };
      const entry = { sessionId: "original", updatedAt: 1 };
      replaceSessionEntrySync(scope, entry);
      const database = openOpenClawAgentDatabase(toDatabaseOptions(resolveSqliteScope(scope)));
      const descriptor = {
        agentId: "main",
        storePath: database.path,
        sessionKey,
        sessionId: entry.sessionId,
        lifecycleRevision: null,
      };
      let other: ReturnType<typeof openOpenClawAgentDatabase> | undefined;
      if (kind === "durable") {
        other = openOpenClawAgentDatabase({
          agentId: "main",
          env,
          path: path.join(path.dirname(database.path), "other", "openclaw-agent.sqlite"),
        });
        writeSessionEntry(other, sessionKey, { sessionId: "another-store-session", updatedAt: 1 });
      }
      const authority = await prepareSessionDeliveryGeneration(descriptor);
      try {
        await runExclusiveSessionLifecycleMutation({
          scope: database.path,
          identities: [sessionKey, entry.sessionId],
          prepare: async () => {
            expect(authority.assertCurrent).toThrow(
              expect.objectContaining({ code: "SESSION_DELIVERY_GENERATION_UNAVAILABLE" }),
            );
          },
          run: async () => {
            expect(authority.assertCurrent).toThrow(
              expect.objectContaining({ code: "SESSION_DELIVERY_GENERATION_UNAVAILABLE" }),
            );
          },
        });
        authority.assertCurrent();
        replaceSessionEntrySync(scope, {
          ...entry,
          updatedAt: 2,
          delivery: {
            kind: "external",
            route: {
              channel: "matrix",
              accountId: "another-account",
              target: { to: "!ordinary:example" },
            },
            context: { channel: "matrix", accountId: "another-account", to: "!ordinary:example" },
            origin: { provider: "matrix", accountId: "another-account", to: "!ordinary:example" },
          },
          activeWriterRunId: "new-ordinary-run",
        });
        addSessionMember(
          { ...scope, storePath: database.path },
          { identityId: "ordinary-member", addedBy: "owner", addedAt: 2 },
        );
        const queries = trackSqliteStatementExecutions(database.db, ["all"], () => "all");
        try {
          authority.assertCurrent();
          expect(queries.counts.all).toBe(0);
        } finally {
          queries.restore();
        }
        if (other) {
          await expect(
            prepareSessionDeliveryGeneration({ ...descriptor, storePath: other.path }),
          ).rejects.toThrow(
            expect.objectContaining({ code: "SESSION_DELIVERY_GENERATION_REVOKED" }),
          );
          authority.assertCurrent();
        }
        replaceSessionEntrySync(scope, { ...entry, lifecycleRevision: "reset-generation" });
        expect(authority.assertCurrent).toThrow(
          expect.objectContaining({ code: "SESSION_DELIVERY_GENERATION_REVOKED" }),
        );
        await expect(prepareSessionDeliveryGeneration(descriptor)).rejects.toThrow(
          expect.objectContaining({ code: "SESSION_DELIVERY_GENERATION_REVOKED" }),
        );
        const replay = await prepareSessionDeliveryGeneration({
          ...descriptor,
          lifecycleRevision: "reset-generation",
        });
        try {
          replay.assertCurrent();
          deleteSessionEntryRows(database, sessionKey);
          writeSessionEntry(database, sessionKey, { sessionId: "replacement", updatedAt: 3 });
          expect(replay.assertCurrent).toThrow(
            expect.objectContaining({ code: "SESSION_DELIVERY_GENERATION_REVOKED" }),
          );
          await expect(prepareSessionDeliveryGeneration(descriptor)).rejects.toThrow(
            expect.objectContaining({ code: "SESSION_DELIVERY_GENERATION_REVOKED" }),
          );
          const replacement = await prepareSessionDeliveryGeneration({
            ...descriptor,
            sessionId: "replacement",
          });
          replacement.assertCurrent();
          replacement.release();
          expect(replacement.assertCurrent).toThrow(
            expect.objectContaining({ code: "SESSION_DELIVERY_GENERATION_UNAVAILABLE" }),
          );
          if (kind === "incognito") {
            const current = { ...descriptor, sessionId: "replacement" };
            const held = await prepareSessionDeliveryGeneration(current);
            const failedProjection = vi
              .spyOn(sharingKernel, "listSessionMembersInDatabase")
              .mockImplementationOnce(() => {
                throw new Error("synthetic projection failure");
              });
            try {
              writeSessionEntry(database, sessionKey, { sessionId: "replacement", updatedAt: 4 });
              expect(held.assertCurrent).toThrow(
                expect.objectContaining({ code: "SESSION_DELIVERY_GENERATION_UNAVAILABLE" }),
              );
              await expect(prepareSessionDeliveryGeneration(current)).rejects.toThrow(
                expect.objectContaining({ code: "SESSION_DELIVERY_GENERATION_UNAVAILABLE" }),
              );
            } finally {
              failedProjection.mockRestore();
              held.release();
            }
            writeSessionEntry(database, sessionKey, { sessionId: "replacement", updatedAt: 5 });
            const repaired = await prepareSessionDeliveryGeneration(current);
            repaired.assertCurrent();
            repaired.release();
          }
        } finally {
          replay.release();
        }
      } finally {
        authority.release();
      }
    });
  },
);
