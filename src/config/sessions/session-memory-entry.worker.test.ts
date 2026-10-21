import { channel } from "node:diagnostics_channel";
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
import { collectSessionMemoryEntries } from "./session-memory-entry.worker.test-support.js";

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
    const readBatch = async (expectedPayloadReads = 1) => {
      const observer = observeSqliteReadSql(requireNodeSqlite().StatementSync.prototype);
      try {
        const entries = await collectSessionMemoryEntries(requests);
        expect(
          observer.queries.filter(
            (sql) => /\bcount\(/i.test(sql) && /transcript_events/i.test(sql),
          ),
        ).toHaveLength(2);
        expect(
          observer.queries.filter((sql) =>
            /\bfrom\s+"session_transcript_cold_archives"/i.test(sql),
          ),
        ).toHaveLength(0);
        expect(observer.queries.filter((sql) => sql.includes(' as "event_json"'))).toHaveLength(
          expectedPayloadReads,
        );
        return entries;
      } finally {
        observer.restore();
      }
    };

    const initial = await readBatch();
    expect(initial).toMatchObject(
      scopes.map((_, index) => ({ entry: { content: `User: Preference ${index}.` } })),
    );
    expect(await readBatch(0)).toEqual(initial);
    channel("openclaw.memory.critical").publish(undefined);
    expect(await readBatch()).toEqual(initial);
    expect(await readBatch(0)).toEqual(initial);

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
    expect(await collectSessionMemoryEntries([request])).toMatchObject([
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
    let payloadBindings = 0;
    const observer = observeSqliteReadSql(
      requireNodeSqlite().StatementSync.prototype,
      (sql, bindings) => {
        if (sql.includes(' as "event_json"')) {
          payloadBindings += bindings.length;
        }
      },
    );
    try {
      expect(await collectSessionMemoryEntries(requests)).toMatchObject([
        { entry: { content: "User: First." } },
        { entry: { content: "User: First.\nUser: Second." } },
      ]);
      expect(observer.queries.filter((sql) => sql.includes(' as "event_json"'))).toHaveLength(1);
      // Each admission range needs at most one session and one sequence bound.
      expect(payloadBindings).toBeLessThanOrEqual(4);
    } finally {
      observer.restore();
    }
  });
});

it("waits for delivery before reading later export batches and retries a failed delivery", async () => {
  await withOpenClawTestState({ label: "session-memory-entry-delivery" }, async (state) => {
    const requests = Array.from({ length: 3 }, (_, index) => ({
      absPath: "agent:main:chat:delivery-" + index,
      options: {
        agentId: "main",
        sessionId: "delivery-" + index,
        sessionKey: "agent:main:chat:delivery-" + index,
        storePath: path.join(state.sessionsDir(), "sessions.json"),
      },
    }));
    const body = "bounded fixture ".repeat(150_000);
    for (const { options } of requests) {
      replaceSessionEntrySync(options, { sessionId: options.sessionId, updatedAt: 1 });
      expect(
        replaceTranscriptEventsSync(options, [
          {
            type: "message",
            id: "initial",
            message: { role: "user", content: body },
          },
        ]),
      ).toBe(true);
    }
    const entered = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    const observer = observeSqliteReadSql(requireNodeSqlite().StatementSync.prototype);
    const pending = collectSessionMemoryEntries(requests, async (index, value) => {
      expect(index).toBe(0);
      if (!("entry" in value) || !value.entry) {
        throw new Error("Expected a hot export");
      }
      expect(value.entry.content.startsWith("User: bounded fixture ")).toBe(true);
      expect(value.entry.content.endsWith("fixture")).toBe(true);
      entered.resolve();
      await resume.promise;
      throw new Error("delivery unavailable");
    });
    const observed = pending.catch((error: unknown) => error);
    try {
      await Promise.race([
        entered.promise,
        pending.then(() => {
          throw new Error("Export finished before delivery was acknowledged");
        }),
      ]);
      // Two sources exceed the byte group: none of the later bodies may be prefetched.
      expect(observer.queries.filter((sql) => sql.includes(' as "event_json"'))).toHaveLength(1);
      resume.resolve();
      await expect(pending).rejects.toThrow("delivery unavailable");
    } finally {
      resume.resolve();
      await observed;
      observer.restore();
    }
    expect(
      replaceTranscriptEventsSync(requests[2]!.options, [
        {
          type: "message",
          id: "newer",
          message: { role: "user", content: "Committed after failure." },
        },
      ]),
    ).toBe(true);
    const delivered: number[] = [];
    expect(
      await collectSessionMemoryEntries(requests, async (index, value) => {
        delivered.push(index);
        if (index === 2) {
          expect(value).toMatchObject({ entry: { content: "User: Committed after failure." } });
        }
      }),
    ).toHaveLength(3);
    expect(delivered).toEqual([0, 1, 2]);
  });
});
