import { channel } from "node:diagnostics_channel";
import path from "node:path";
import { assert, expect, it } from "vitest";
import { awaitGateBeforeSettlement } from "../../../test/helpers/promise.js";
import { observeSqliteReadSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { requireNodeSqlite } from "../../infra/node-sqlite.js";
import { runOpenClawAgentWriteTransaction } from "../../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { replaceSessionEntrySync } from "./session-accessor.sqlite-entry.js";
import { readActiveTranscriptEntryAnchor } from "./session-accessor.sqlite-transcript-admitted-read.js";
import { appendTranscriptMessageSync } from "./session-accessor.sqlite-transcript-write.kernel.js";
import { replaceTranscriptEventsSync } from "./session-accessor.sqlite-transcript-write.test-support.js";
import { collectSessionMemoryEntries } from "./session-memory-entry.worker.test-support.js";

type Scope = Parameters<typeof replaceTranscriptEventsSync>[0];
function userEvent(id: string, content: string) {
  return { type: "message", id, message: { role: "user", content } };
}
function replace(scope: Scope, events: ReturnType<typeof userEvent>[]) {
  expect(replaceTranscriptEventsSync(scope, events)).toBe(true);
}
function scopeFor(storePath: string, sessionId: string) {
  return { agentId: "main", sessionId, sessionKey: `agent:main:chat:${sessionId}`, storePath };
}
const contentEntry = (content: string) => ({ entry: { content } });
const bodyReads = (queries: readonly string[]) =>
  queries.filter((sql) => sql.includes(' as "event_json"'));
function observeReads() {
  const observer = observeSqliteReadSql(requireNodeSqlite().StatementSync.prototype);
  return Object.assign(observer, { [Symbol.dispose]: () => observer.restore() });
}

it("batches export metadata while observing committed appends, rewrites and cold transitions", async () => {
  await withOpenClawTestState({ label: "session-memory-entry-batch" }, async (state) => {
    const storePath = path.join(state.sessionsDir(), "sessions.json");
    const scopes = Array.from({ length: 12 }, (_, index) =>
      scopeFor(storePath, `session-${index}`),
    );
    for (const [index, scope] of scopes.entries()) {
      replaceSessionEntrySync(scope, { sessionId: scope.sessionId, updatedAt: 1 });
      replace(scope, [userEvent(`question-${index}`, `Preference ${index}.`)]);
    }
    const requests = scopes.map((scope) => ({ absPath: scope.sessionKey, options: scope }));
    const readBatch = async (expectedPayloadReads = 1) => {
      using observer = observeReads();
      const entries = await collectSessionMemoryEntries(requests);
      const count = (pattern: RegExp) => observer.queries.filter((sql) => pattern.test(sql)).length;
      expect({
        counts: observer.queries.filter(
          (sql) => /\bcount\(/i.test(sql) && /transcript_events/i.test(sql),
        ).length,
        cold: count(/\bfrom\s+"session_transcript_cold_archives"/i),
        bodies: bodyReads(observer.queries).length,
      }).toEqual({ counts: 2, cold: 0, bodies: expectedPayloadReads });
      return entries;
    };

    const initial = await readBatch();
    expect(initial).toMatchObject(
      scopes.map((_, index) => contentEntry(`User: Preference ${index}.`)),
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
    replace(scopes[1]!, [userEvent("replacement", "The rewritten preference.")]);
    // This owner consumes the cold marker; archive restoration is covered by its own tests.
    runOpenClawAgentWriteTransaction(
      (database) => {
        const db = database.db;
        db.prepare(
          `INSERT INTO session_transcript_cold_archives
            (session_id, generation, archive_name, archive_sha256, event_count, raw_bytes,
             archive_bytes, last_seq, archived_at, storage)
           VALUES (?, 'cold-generation', 'fixture.jsonl.zst', ?, 1, 1, 1, 0, 1, 'file')`,
        ).run(scopes[2]!.sessionId, "0".repeat(64));
        db.prepare("DELETE FROM transcript_events WHERE session_id = ?").run(scopes[2]!.sessionId);
      },
      { agentId: "main", env: state.env },
    );

    expect(await readBatch()).toMatchObject([
      contentEntry("User: Preference 0.\nAssistant: The committed answer."),
      contentEntry("User: The rewritten preference."),
      { cold: true },
      ...scopes.slice(3).map((_, index) => contentEntry(`User: Preference ${index + 3}.`)),
    ]);
  });
});

it("keeps repeated sessions isolated by their admitted input bounds", async () => {
  await withOpenClawTestState({ label: "session-memory-entry-fences" }, async (state) => {
    const scope = scopeFor(path.join(state.sessionsDir(), "sessions.json"), "shared");
    replaceSessionEntrySync(scope, { sessionId: scope.sessionId, updatedAt: 1 });
    replace(scope, [
      userEvent("first", "First."),
      userEvent("second", "Second."),
      userEvent("third", "Third."),
    ]);
    const request = { absPath: scope.sessionKey, options: scope };
    const requests = ["second", "third"].map((entryId) => {
      const anchor = readActiveTranscriptEntryAnchor({ ...scope, entryId });
      assert(anchor, `Expected persisted input anchor for ${entryId}`);
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
        contentEntry("User: First."),
        contentEntry("User: First.\nUser: Second."),
      ]);
      expect(bodyReads(observer.queries)).toHaveLength(1);
      // Each admission range needs at most one session and one sequence bound.
      expect(payloadBindings).toBeLessThanOrEqual(4);
    } finally {
      observer.restore();
    }
  });
});

it("waits for delivery before reading later export batches and retries a failed delivery", async () => {
  await withOpenClawTestState({ label: "session-memory-entry-delivery" }, async (state) => {
    const requests = Array.from({ length: 3 }, (_, index) => {
      const options = scopeFor(
        path.join(state.sessionsDir(), "sessions.json"),
        `delivery-${index}`,
      );
      return { absPath: options.sessionKey, options };
    });
    const body = "bounded fixture ".repeat(150_000);
    for (const { options } of requests) {
      replaceSessionEntrySync(options, { sessionId: options.sessionId, updatedAt: 1 });
      replace(options, [userEvent("initial", body)]);
    }
    const entered = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    const observer = observeSqliteReadSql(requireNodeSqlite().StatementSync.prototype);
    const pending = collectSessionMemoryEntries(requests, async (index, value) => {
      expect(index).toBe(0);
      assert("entry" in value && value.entry, "Expected a hot export");
      expect(value.entry.content).toMatch(/^User: bounded fixture .*fixture$/s);
      entered.resolve();
      await resume.promise;
      throw new Error("delivery unavailable");
    });
    const observed = pending.catch((error: unknown) => error);
    try {
      await awaitGateBeforeSettlement(
        entered.promise,
        pending,
        "Export finished before delivery was acknowledged",
      );
      // Two sources exceed the byte group: none of the later bodies may be prefetched.
      expect(bodyReads(observer.queries)).toHaveLength(1);
      resume.resolve();
      await expect(pending).rejects.toThrow("delivery unavailable");
    } finally {
      resume.resolve();
      await observed;
      observer.restore();
    }
    replace(requests[2]!.options, [userEvent("newer", "Committed after failure.")]);
    const delivered: number[] = [];
    expect(
      await collectSessionMemoryEntries(requests, async (index, value) => {
        delivered.push(index);
        if (index === 2) {
          expect(value).toMatchObject(contentEntry("User: Committed after failure."));
        }
      }),
    ).toHaveLength(3);
    expect(delivered).toEqual([0, 1, 2]);
  });
});
