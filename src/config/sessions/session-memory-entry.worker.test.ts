import path from "node:path";
import { expect, it } from "vitest";
import { observeSqliteReadSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { requireNodeSqlite } from "../../infra/node-sqlite.js";
import { runOpenClawAgentWriteTransaction } from "../../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { replaceSessionEntrySync } from "./session-accessor.sqlite-entry.js";
import { readActiveTranscriptEntryAnchor } from "./session-accessor.sqlite-transcript-anchor.js";
import { appendTranscriptMessageSync } from "./session-accessor.sqlite-transcript-write.js";
import { replaceTranscriptEventsSync } from "./session-accessor.sqlite-transcript-write.test-support.js";
import { prepareSessionMemoryEntries } from "./session-memory-entry.worker.js";

it("batches export metadata while observing committed appends, rewrites and cold transitions", async () => {
  await withOpenClawTestState({ label: "session-memory-entry-batch" }, async (state) => {
    const storePath = path.join(state.sessionsDir(), "sessions.json");
    const scopes = Array.from({ length: 12 }, (_, index) => ({
      agentId: "main",
      sessionId: `session-${index}`,
      sessionKey: `agent:main:chat:session-${index}`,
      storePath,
    }));
    for (const [index, scope] of scopes.entries()) {
      replaceSessionEntrySync(scope, { sessionId: scope.sessionId, updatedAt: 1 });
      expect(
        replaceTranscriptEventsSync(scope, [
          {
            type: "message",
            id: `question-${index}`,
            message: { role: "user", content: `Preference ${index}.` },
          },
        ]),
      ).toBe(true);
    }
    const requests = scopes.map((scope) => ({ absPath: scope.sessionKey, options: scope }));
    const readBatch = async () => {
      const observer = observeSqliteReadSql(requireNodeSqlite().StatementSync.prototype);
      try {
        const entries = await prepareSessionMemoryEntries(requests);
        expect(
          observer.queries.filter(
            (sql) => /\bcount\(/i.test(sql) && /transcript_events/i.test(sql),
          ),
        ).toHaveLength(1);
        expect(
          observer.queries.filter((sql) =>
            /\bfrom\s+"session_transcript_cold_archives"/i.test(sql),
          ),
        ).toHaveLength(0);
        expect(observer.queries.filter((sql) => sql.includes(' as "event_json"'))).toHaveLength(1);
        return entries;
      } finally {
        observer.restore();
      }
    };

    expect(await readBatch()).toMatchObject(
      scopes.map((_, index) => ({ entry: { content: `User: Preference ${index}.` } })),
    );

    expect(
      appendTranscriptMessageSync(scopes[0]!, {
        eventId: "answer",
        message: { role: "assistant", content: "The committed answer." },
      }),
    ).toMatchObject({ ok: true });
    expect(
      replaceTranscriptEventsSync(scopes[1]!, [
        {
          type: "message",
          id: "replacement",
          message: { role: "user", content: "The rewritten preference." },
        },
      ]),
    ).toBe(true);
    // This owner consumes the cold marker; archive restoration is covered by its own tests.
    runOpenClawAgentWriteTransaction(
      (database) => {
        database.db
          .prepare(
            `INSERT INTO session_transcript_cold_archives
            (session_id, generation, archive_name, archive_sha256, event_count, raw_bytes,
             archive_bytes, last_seq, archived_at, storage)
           VALUES (?, 'cold-generation', 'fixture.jsonl.zst', ?, 1, 1, 1, 0, 1, 'file')`,
          )
          .run(scopes[2]!.sessionId, "0".repeat(64));
        database.db
          .prepare("DELETE FROM transcript_events WHERE session_id = ?")
          .run(scopes[2]!.sessionId);
      },
      { agentId: "main", env: state.env },
    );

    expect(await readBatch()).toMatchObject([
      { entry: { content: "User: Preference 0.\nAssistant: The committed answer." } },
      { entry: { content: "User: The rewritten preference." } },
      { cold: true },
      ...scopes
        .slice(3)
        .map((_, index) => ({ entry: { content: `User: Preference ${index + 3}.` } })),
    ]);
  });
});

it("keeps repeated sessions isolated by their admitted input bounds", async () => {
  await withOpenClawTestState({ label: "session-memory-entry-fences" }, async (state) => {
    const scope = {
      agentId: "main",
      sessionId: "shared",
      sessionKey: "agent:main:chat:shared",
      storePath: path.join(state.sessionsDir(), "sessions.json"),
    };
    replaceSessionEntrySync(scope, { sessionId: scope.sessionId, updatedAt: 1 });
    expect(
      replaceTranscriptEventsSync(scope, [
        { type: "message", id: "first", message: { role: "user", content: "First." } },
        { type: "message", id: "second", message: { role: "user", content: "Second." } },
        { type: "message", id: "third", message: { role: "user", content: "Third." } },
      ]),
    ).toBe(true);
    const request = { absPath: scope.sessionKey, options: scope };
    expect(await prepareSessionMemoryEntries([request])).toMatchObject([
      { entry: { content: "User: First.\nUser: Second.\nUser: Third." } },
    ]);
    const requests = ["second", "third"].map((entryId) => {
      const anchor = readActiveTranscriptEntryAnchor({ ...scope, entryId });
      if (!anchor) {
        throw new Error(`Expected persisted input anchor for ${entryId}`);
      }
      return {
        absPath: request.absPath,
        options: request.options,
        admission: { ...anchor, logicalTurnId: entryId, role: "user" as const },
      };
    });
    const observer = observeSqliteReadSql(requireNodeSqlite().StatementSync.prototype);
    try {
      expect(await prepareSessionMemoryEntries(requests)).toMatchObject([
        { entry: { content: "User: First." } },
        { entry: { content: "User: First.\nUser: Second." } },
      ]);
      expect(observer.queries.filter((sql) => sql.includes(' as "event_json"'))).toHaveLength(1);
    } finally {
      observer.restore();
    }
  });
});
