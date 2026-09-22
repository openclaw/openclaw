import fs from "node:fs";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { trackSqliteStatementExecutions } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import * as boardStore from "../../boards/sqlite-board-store.kernel.js";
import { requireNodeSqlite } from "../../infra/node-sqlite.js";
import { closeOpenClawAgentDatabaseByPathAsync } from "../../state/openclaw-agent-db-lifecycle.js";
import { OpenClawAgentDatabaseReadOnlyScope } from "../../state/openclaw-agent-db-readonly-scope.js";
import { withOpenClawAgentDatabaseReadOnly } from "../../state/openclaw-agent-db-readonly.js";
import {
  openOpenClawAgentDatabase,
  resolveOpenClawAgentSqlitePath,
} from "../../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { writeSessionEntry } from "./session-accessor.sqlite-entry-store.js";
import { readSessionBackingFacts } from "./session-backing-facts.js";
import { captureCanonicalSessionReaderContinuation } from "./session-canonical-key.js";
import {
  readSessionEntriesFromStoreInWorker,
  withSessionEntriesFromStoresInWorker,
} from "./session-entry-read-runtime.js";
import {
  readExactSessionEntriesWithLifecycle,
  readSessionRowDatabaseFacts,
} from "./session-entry-read.worker.js";

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
