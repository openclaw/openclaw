import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { trackSqliteStatementExecutions } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { getNodeSqliteKysely } from "../../infra/kysely-sync.js";
import { requireNodeSqlite } from "../../infra/node-sqlite.js";
import { runSqliteReadOperationSync } from "../../infra/sqlite-schema-facts.js";
import { runSqliteDeferredTransactionSync } from "../../infra/sqlite-transaction.js";
import { closeOpenClawAgentDatabaseByPathAsync } from "../../state/openclaw-agent-db-lifecycle.js";
import {
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
} from "../../state/openclaw-agent-db.js";
import { requireNativeSqliteDatabase } from "../../test-utils/native-sqlite.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { captureRuntimeConfigAsyncReader } from "../io.js";
import {
  appendTranscriptEvent,
  appendTranscriptMessage,
  readSessionTranscriptWatermark as readWatermark,
  upsertSessionEntryCore,
  type TranscriptEvent,
} from "./session-accessor.js";
import { readTranscriptRawDelta } from "./session-accessor.sqlite-delta.js";
import { readCurrentProjectionSnapshot } from "./session-accessor.sqlite-projection-read.js";
import { resolveSqliteTranscriptReadScope } from "./session-accessor.sqlite-scope.js";
import {
  readTranscriptContextVersionInTransaction as readContextVersion,
  rotateTranscriptGenerationInTransaction as rotateGeneration,
} from "./session-accessor.sqlite-transcript-state.js";
import { readSessionTranscriptHotWatermark as readHot } from "./session-accessor.sqlite-transcript-watermark-read.js";
import { readSessionTranscriptWatermarkInDatabase as readInDatabase } from "./session-accessor.sqlite-transcript-watermark.js";
import { replaceTranscriptEvents } from "./session-accessor.sqlite-transcript-write.test-support.js";
import { assertSessionTranscriptHot } from "./session-cold-storage-state.js";

function transcriptMessages(count: number): TranscriptEvent[] {
  return Array.from({ length: count }, (_, index) => ({
    type: "message",
    id: `message-${index}`,
    parentId: index === 0 ? null : `message-${index - 1}`,
    message: { role: "user", content: `Message ${index}` },
  }));
}

const isHotWatermarkQuery = (sql: string) =>
  sql.includes('from "transcript_events"') && sql.includes('from "transcript_rewrite_watermarks"');

function rawPage(target: Parameters<typeof readTranscriptRawDelta>[0]) {
  const page = readTranscriptRawDelta(target);
  if (page.kind !== "page") {
    throw new Error("expected a raw page");
  }
  return page;
}

function trackQueries(
  database: ReturnType<typeof openOpenClawAgentDatabase>,
  matches: (sql: string) => boolean,
) {
  const queries = trackSqliteStatementExecutions(
    requireNativeSqliteDatabase(database.db),
    ["matched"],
    (sql) => (matches(sql) ? "matched" : null),
  );
  cleanup.push(queries.restore);
  return () => queries.counts.matched;
}

function compiledQueries(
  database: ReturnType<typeof openOpenClawAgentDatabase>,
  matches: (sql: string) => boolean,
) {
  const compile = vi.spyOn(getNodeSqliteKysely(database.db).getExecutor(), "compileQuery");
  cleanup.push(() => compile.mockRestore());
  return () =>
    compile.mock.results.filter((result) => result.type === "return" && matches(result.value.sql));
}

function writeArchive(
  connection: Parameters<typeof getNodeSqliteKysely>[0],
  sessionId: string,
  lastSeq: number,
  generation = "archive-generation",
) {
  connection
    .prepare(`INSERT INTO session_transcript_cold_archives
    (session_id, generation, archive_name, archive_sha256, archive_blob,
     event_count, raw_bytes, archive_bytes, last_seq, archived_at, storage)
    VALUES (?, ?, 'synthetic-archive', ?, NULL, ?, 0, 0, ?, 1, 'file')`)
    .run(sessionId, generation, "0".repeat(64), lastSeq + 1, lastSeq);
}

function writeGeneration(
  connection: Parameters<typeof getNodeSqliteKysely>[0],
  sessionId: string,
  generation: string,
) {
  connection
    .prepare("UPDATE transcript_rewrite_watermarks SET generation = ? WHERE session_id = ?")
    .run(generation, sessionId);
}

let state: OpenClawTestState;
const cleanup: Array<() => void> = [];
const scope = (sessionId: string) => ({
  agentId: "main",
  env: state.env,
  sessionId,
  sessionKey: `agent:main:${sessionId}`,
});

beforeEach(async () => {
  state = await createOpenClawTestState({ scenario: "minimal" });
  await captureRuntimeConfigAsyncReader()();
  for (const [sessionId, count] of [
    ["first", 1],
    ["second", 2],
  ] as const) {
    await upsertSessionEntryCore(scope(sessionId), { sessionId, updatedAt: 1 });
    await replaceTranscriptEvents(scope(sessionId), transcriptMessages(count));
  }
});

afterEach(async () => {
  for (const restore of cleanup.splice(0).toReversed()) {
    restore();
  }
  await state.cleanup();
});

it("binds each session again after appends, rewrites, and missing-session reads", async () => {
  const first = readWatermark(scope("first"));
  const second = readWatermark(scope("second"));
  await appendTranscriptMessage(scope("first"), {
    eventId: "appended",
    parentId: "message-0",
    message: { role: "assistant", content: "Appended message" },
  });
  expect(readWatermark(scope("first"))).toEqual({ ...first, maxSeq: 1 });
  expect(readWatermark(scope("second"))).toEqual(second);

  await replaceTranscriptEvents(scope("first"), transcriptMessages(3));
  const rewritten = readWatermark(scope("first"));
  expect(rewritten.maxSeq).toBe(2);
  expect(rewritten.generation).not.toBe(first.generation);
  expect(readWatermark(scope("missing"))).toEqual({
    generation: null,
    maxSeq: null,
  });
  expect(readWatermark(scope("second"))).toEqual(second);
  expect(readWatermark(scope("first"))).toEqual(rewritten);
});

it("shares projection facts until a native write changes their snapshot", () => {
  const target = scope("first");
  const database = openOpenClawAgentDatabase(target);
  const resolved = resolveSqliteTranscriptReadScope(target);
  const reads = trackQueries(database, (sql) => sql.toLowerCase().startsWith("select"));
  runSqliteReadOperationSync(database.db, () =>
    runSqliteDeferredTransactionSync(database.db, () => {
      const result = readCurrentProjectionSnapshot(database, resolved, (projection) => {
        const before = reads();
        expect(readContextVersion(database, target.sessionId)).toEqual(projection.version);
        const expected = {
          generation: projection.version.generation,
          maxSeq: projection.version.rawSeq,
        };
        expect(readInDatabase(database, target.sessionId)).toEqual(expected);
        expect(readHot(database, target.sessionId)).toEqual(expected);
        assertSessionTranscriptHot(database.db, target.sessionId);
        expect(reads()).toBe(before);
        writeGeneration(database.db, target.sessionId, "rewritten");
        expect(readInDatabase(database, target.sessionId).generation).toBe("rewritten");
        writeArchive(database.db, target.sessionId, 0, "rewritten");
        expect(() => assertSessionTranscriptHot(database.db, target.sessionId)).toThrow(
          "cold storage",
        );
      });
      expect(result.kind).toBe("value");
    }),
  );
});

it("reads raw page watermarks once without recompiling tiny or empty reads", () => {
  const targets = [scope("first"), scope("second")];
  const pages = targets.map((target) => {
    const page = rawPage(target);
    expect(page).toMatchObject({ kind: "page", hasMore: false });
    return page;
  });
  expect(pages.map((page) => page.events.length)).toEqual([1, 2]);
  const database = openOpenClawAgentDatabase(scope("first"));
  const isVersionQuery = (sql: string) =>
    sql.includes('from "transcript_rewrite_watermarks"') ||
    (sql.includes('from "transcript_events"') && !sql.includes("event_json"));
  const reads = trackQueries(database, isVersionQuery);
  const compiled = compiledQueries(database, isVersionQuery);
  for (const [index, target] of targets.entries()) {
    const page = pages[index]!;
    for (let attempt = 0; attempt < 3; attempt++) {
      expect(readTranscriptRawDelta(target)).toEqual(page);
      expect(readTranscriptRawDelta(target, { cursor: page.cursor })).toEqual({
        kind: "page",
        cursor: page.cursor,
        events: [],
        hasMore: false,
        serializedBytes: 0,
      });
    }
  }
  expect(reads()).toBe(12);
  expect(compiled()).toHaveLength(0);
});

it("keeps a raw empty frontier distinct from a missing transcript after replacement", async () => {
  const target = scope("first");
  expect(readTranscriptRawDelta(scope("missing"))).toEqual({ kind: "missing" });
  const populated = rawPage(target);
  await replaceTranscriptEvents(target, []);
  expect(readTranscriptRawDelta(target, { cursor: populated.cursor })).toMatchObject({
    kind: "reset",
    reason: "generation_mismatch",
  });
  const empty = rawPage(target);
  expect(empty).toMatchObject({ kind: "page", events: [], hasMore: false, serializedBytes: 0 });
  const cursor = JSON.parse(Buffer.from(empty.cursor, "base64url").toString("utf8")) as object;
  expect(cursor).toMatchObject({ lastSeq: -1 });
  const beyondEmpty = Buffer.from(JSON.stringify({ ...cursor, lastSeq: 0 })).toString("base64url");
  expect(readTranscriptRawDelta(target, { cursor: beyondEmpty })).toMatchObject({
    kind: "reset",
    reason: "invalid_cursor",
  });
  const appended = { type: "custom", id: "after-empty" };
  await appendTranscriptEvent(target, appended);
  expect(readTranscriptRawDelta(target, { cursor: empty.cursor })).toMatchObject({
    kind: "page",
    events: [{ event: appended, seq: 0 }],
    hasMore: false,
  });
});

it.each([false, true])("keeps public reads committed through writer rollback=%s", (rollback) => {
  const target = scope("first");
  const before = readWatermark(target);
  const database = openOpenClawAgentDatabase(target);
  const failure = new Error("rollback watermark generation");
  let generation = before.generation;
  const write = () =>
    runOpenClawAgentWriteTransaction((writer) => {
      generation = rotateGeneration(writer, target.sessionId);
      expect(readHot(writer, target.sessionId)).toEqual({
        ...before,
        generation,
      });
      expect(readWatermark(target)).toEqual(before);
      if (rollback) {
        throw failure;
      }
    }, target);
  if (rollback) {
    expect(write).toThrow(failure);
  } else {
    write();
  }
  expect(generation).not.toBe(before.generation);
  expect(database.db.isTransaction).toBe(false);
  expect(readWatermark(target)).toEqual({
    ...before,
    generation: rollback ? before.generation : generation,
  });
});

it("reads hot and cold watermarks once while preserving a WAL snapshot and foreign commits", () => {
  const target = scope("second");
  const database = openOpenClawAgentDatabase(target);
  const before = readWatermark(target);
  const peer = new (requireNodeSqlite().DatabaseSync)(database.path);
  const reads = trackQueries(database, (sql) =>
    /\b(?:transcript_events|transcript_rewrite_watermarks|session_transcript_cold_archives)\b/.test(
      sql,
    ),
  );
  const read = (sessionId = target.sessionId) => {
    const executions = reads();
    const watermark = readInDatabase(database, sessionId);
    expect(reads() - executions).toBe(1);
    return watermark;
  };
  try {
    const exec = vi.spyOn(database.db, "exec");
    try {
      expect(read()).toEqual(before);
      expect(
        exec.mock.calls.filter(([sql]) =>
          /^(?:BEGIN|COMMIT|SAVEPOINT|RELEASE|ROLLBACK)\b/iu.test(sql),
        ),
      ).toEqual([]);
    } finally {
      exec.mockRestore();
    }
    expect(peer.prepare("PRAGMA journal_mode").get()).toEqual({ journal_mode: "wal" });
    runSqliteDeferredTransactionSync(database.db, () => {
      expect(read()).toEqual(before);
      expect(read("missing")).toEqual({ generation: null, maxSeq: null });
      peer.exec("BEGIN IMMEDIATE");
      writeGeneration(peer, target.sessionId, "peer-generation");
      writeArchive(peer, target.sessionId, 0);
      peer.exec("COMMIT");
      expect(read()).toEqual(before);
    });
    const archived = { generation: "peer-generation", maxSeq: 0 };
    expect(read()).toEqual(archived);
    expect(readWatermark(target)).toEqual(archived);
    expect(readHot(database, target.sessionId)).toEqual({
      ...before,
      generation: "peer-generation",
    });
    peer
      .prepare("DELETE FROM session_transcript_cold_archives WHERE session_id = ?")
      .run(target.sessionId);
    expect(read()).toEqual({ ...before, generation: "peer-generation" });
    expect(database.db.isTransaction).toBe(false);
  } finally {
    cleanup.pop()?.();
    peer.close();
  }
});

it("prepares for the reopened native handle and rejects the closed one", async () => {
  const target = scope("first");
  const database = openOpenClawAgentDatabase(target);
  const before = readWatermark(target);
  await closeOpenClawAgentDatabaseByPathAsync(database.path, target.agentId);
  expect(database.db.isOpen).toBe(false);
  expect(() => readHot(database, target.sessionId)).toThrow();
  const reopened = openOpenClawAgentDatabase(target);
  expect(Object.is(reopened.db, database.db)).toBe(false);
  const compiled = compiledQueries(reopened, isHotWatermarkQuery);
  expect(readWatermark(target)).toEqual(before);
  expect(readWatermark(target)).toEqual(before);
  expect(compiled()).toHaveLength(1);
});
