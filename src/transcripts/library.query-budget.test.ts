import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  TRANSCRIPTS_EXPORT_MAX_BYTES,
  TRANSCRIPTS_RESULT_MAX_BYTES,
} from "../../packages/gateway-protocol/src/schema/transcripts.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  clearNodeSqliteKyselyCacheForDatabase,
  executeSqliteQuerySync,
} from "../infra/kysely-sync.js";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
} from "../state/openclaw-state-db.js";
import { activeSessions } from "./capture.js";
import { exportTranscriptLibrary, getTranscriptLibrary, listTranscriptLibrary } from "./library.js";
import {
  createTranscriptLibraryStoreFixture,
  transcriptLibrarySession as session,
} from "./library.store.test-support.js";
import { readTranscriptLibraryStatus } from "./status.js";
import {
  cursorScope,
  encodeCursor,
  readLatestTranscriptEntry,
  readTranscriptEntry,
  readTranscriptLibraryEntry,
} from "./store-read.js";
import { meetingTranscriptDb } from "./store-sqlite.js";
import { transcriptSessionSelector } from "./store.js";
import { summarizeTranscripts } from "./summary.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(async () => {
  vi.restoreAllMocks();
  activeSessions.clear();
  await closeOpenClawStateDatabaseAsync();
  closeOpenClawStateDatabaseForTest();
});

function fixture() {
  return createTranscriptLibraryStoreFixture(tempDirs.make("transcript-library-query-budget-"));
}

function observeArchiveReads(
  store: ReturnType<typeof createTranscriptLibraryStoreFixture>["store"],
  database: DatabaseSync,
) {
  // SQL allocation assertions use the same kernels locally; the worker fixture
  // separately proves the real facade's transport and absence of parent SQL.
  vi.spyOn(store, "readEntry").mockImplementation(async (selector, purpose) =>
    readTranscriptEntry(database, selector, purpose),
  );
  vi.spyOn(store, "readLatestEntry").mockImplementation(async () =>
    readLatestTranscriptEntry(database),
  );
  vi.spyOn(store, "readLibraryEntry").mockImplementation(async (params) =>
    readTranscriptLibraryEntry(database, params),
  );
  clearNodeSqliteKyselyCacheForDatabase(database);
  const queries: Array<{
    sql: string;
    rows: number;
    bytes: number;
    maxRowBytes: number;
    closed: boolean;
  }> = [];
  const location = database.location();
  const prototype = requireNodeSqlite().DatabaseSync.prototype;
  // oxlint-disable-next-line typescript/unbound-method -- Called below with the intercepted native database receiver.
  const prepare = prototype.prepare;
  const prepareSpy = vi.spyOn(prototype, "prepare");
  prepareSpy.mockImplementation(function (this: DatabaseSync, sql) {
    const statement = prepare.call(this, sql);
    if (
      this.location() !== location ||
      !/^(?:select|with)\b/iu.test(sql) ||
      !sql.includes("meeting_transcript_")
    ) {
      return statement;
    }
    const record = { sql, rows: 0, bytes: 0, maxRowBytes: 0, closed: false };
    queries.push(record);
    const observeRow = (row: Record<string, unknown>) => {
      const bytes = Object.values(row).reduce<number>(
        (total, value) => total + (typeof value === "string" ? Buffer.byteLength(value) : 0),
        0,
      );
      record.rows++;
      record.bytes += bytes;
      record.maxRowBytes = Math.max(record.maxRowBytes, bytes);
    };
    const nativeGet = statement.get.bind(statement);
    vi.spyOn(statement, "get").mockImplementation(
      new Proxy(nativeGet, {
        apply(get, _receiver, parameters) {
          try {
            const row = get(...parameters);
            if (row) {
              observeRow(row);
            }
            return row;
          } finally {
            record.closed = true;
          }
        },
      }),
    );
    const iterate = statement.iterate.bind(statement);
    vi.spyOn(statement, "iterate").mockImplementation((...parameters) => {
      const iterator = iterate(...parameters);
      const next = iterator.next.bind(iterator);
      vi.spyOn(iterator, "next").mockImplementation(() => {
        const result = next();
        if (result.done) {
          record.closed = true;
        } else {
          observeRow(result.value);
        }
        return result;
      });
      if (iterator.return) {
        const finish = iterator.return.bind(iterator);
        vi.spyOn(iterator, "return").mockImplementation(() => {
          record.closed = true;
          return finish();
        });
      }
      return iterator;
    });
    return statement;
  });
  return queries;
}

describe("transcript library SQLite query budgets", () => {
  it("stops active status descriptor reads when the public result budget is consumed", async () => {
    const { store, database } = fixture();
    for (let index = 0; index < 6; index++) {
      const target = session(`active-${index}`, {
        title: "x".repeat(TRANSCRIPTS_RESULT_MAX_BYTES / 2),
      });
      await store.writeSession(target);
      activeSessions.set(target.sessionId, {
        session: target,
        providerId: target.source.providerId,
        provider: {},
        phase: "active",
      });
    }
    const reads = observeArchiveReads(store, database());
    await expect(readTranscriptLibraryStatus(store, {})).rejects.toThrow(
      expect.objectContaining({ type: "transcript_result_too_large" }),
    );
    expect(
      reads.filter((read) => read.sql.includes('from "meeting_transcript_sessions"')).length,
    ).toBeLessThanOrEqual(3);
  });

  it.each(["text", "combined speaker fields"])(
    "bounds %s before SQLite returns an oversized row",
    async (kind) => {
      const { store, database } = fixture();
      const target = session("allocation");
      await store.writeSession(target);
      const payload = "é\0".repeat(TRANSCRIPTS_RESULT_MAX_BYTES / 2);
      await store.appendUtteranceForSession(
        target,
        kind === "text"
          ? { text: payload }
          : {
              text: "small",
              speaker: { id: "x".repeat(600_000), label: "y".repeat(600_000) },
            },
      );
      const reads = observeArchiveReads(store, database());
      await expect(
        getTranscriptLibrary(store, {
          selector: transcriptSessionSelector(target),
          includeUtterances: true,
          limit: 1,
        }),
      ).rejects.toThrow(
        expect.objectContaining({
          type: "transcript_result_too_large",
          maxBytes: TRANSCRIPTS_RESULT_MAX_BYTES,
        }),
      );
      expect(reads.length).toBeGreaterThan(0);
      expect(Math.max(...reads.map((read) => read.maxRowBytes))).toBeLessThanOrEqual(
        TRANSCRIPTS_RESULT_MAX_BYTES,
      );
      expect(reads.every((read) => read.closed)).toBe(true);
      expect(await store.readUtterancesForSession(target)).toHaveLength(1);
    },
  );

  it("stops a cumulative page before consuming the remaining rows and releases its iterator", async () => {
    const { store, database } = fixture();
    const target = session("cumulative");
    const selector = transcriptSessionSelector(target);
    await store.writeSession(target);
    for (let index = 0; index < 6; index++) {
      await store.appendUtteranceForSession(target, {
        text: "x".repeat(TRANSCRIPTS_RESULT_MAX_BYTES / 2),
      });
    }
    const reads = observeArchiveReads(store, database());
    await expect(
      getTranscriptLibrary(store, { selector, includeUtterances: true, limit: 6 }),
    ).rejects.toThrow(expect.objectContaining({ type: "transcript_result_too_large" }));
    const page = reads.find(
      (read) =>
        read.sql.includes("meeting_transcript_utterances") &&
        !read.sql.includes("meeting_transcript_sessions"),
    )!;
    expect(page.rows).toBeLessThanOrEqual(3);
    expect(page.bytes).toBeLessThanOrEqual(2 * TRANSCRIPTS_RESULT_MAX_BYTES);
    expect(page.closed).toBe(true);
    await store.appendUtteranceForSession(target, { text: "after rejection" });
    const recovered = await getTranscriptLibrary(store, {
      selector,
      includeUtterances: true,
      cursor: encodeCursor(cursorScope(["get", selector, undefined]), [5]),
    });
    expect(recovered.utterances).toMatchObject([{ text: "after rejection", sequence: 6 }]);
  });

  it("uses oversized lookahead only for pagination, then rejects that requested row", async () => {
    const { store, database } = fixture();
    const target = session("lookahead");
    await store.writeSession(target);
    await store.appendUtteranceForSession(target, { text: "first" });
    await store.appendUtteranceForSession(target, {
      text: "x".repeat(TRANSCRIPTS_RESULT_MAX_BYTES + 1),
    });
    const reads = observeArchiveReads(store, database());
    const first = await getTranscriptLibrary(store, {
      selector: transcriptSessionSelector(target),
      includeUtterances: true,
      limit: 1,
    });
    expect(first.utterances).toEqual([{ sequence: 0, text: "first" }]);
    expect(first.nextCursor).not.toBeNull();
    expect(Math.max(...reads.map((read) => read.maxRowBytes))).toBeLessThanOrEqual(
      TRANSCRIPTS_RESULT_MAX_BYTES,
    );
    await expect(
      getTranscriptLibrary(store, {
        selector: first.session.selector,
        includeUtterances: true,
        limit: 1,
        cursor: first.nextCursor!,
      }),
    ).rejects.toThrow(expect.objectContaining({ type: "transcript_result_too_large" }));
  });

  it.each(["title", "source and metadata", "last timestamp"])(
    "bounds %s in list, selector and latest descriptors without limiting full-store reads",
    async (field) => {
      const { store, database } = fixture();
      const target = session(
        "descriptor",
        field === "title"
          ? { title: "x".repeat(TRANSCRIPTS_RESULT_MAX_BYTES + 1) }
          : field === "source and metadata"
            ? {
                source: { providerId: "manual-transcript", private: "x".repeat(600_000) },
                metadata: { private: "y".repeat(600_000) },
              }
            : {},
      );
      await store.writeSession(target);
      await store.appendUtteranceForSession(target, {
        text: "note",
        ...(field === "last timestamp"
          ? { endedAt: "x".repeat(TRANSCRIPTS_RESULT_MAX_BYTES + 1) }
          : {}),
      });
      const reads = observeArchiveReads(store, database());
      await expect(listTranscriptLibrary(store, {})).rejects.toThrow(
        expect.objectContaining({ type: "transcript_result_too_large" }),
      );
      await expect(store.readLatestEntry()).rejects.toThrow(
        expect.objectContaining({ type: "transcript_result_too_large" }),
      );
      await expect(store.readEntry(transcriptSessionSelector(target))).rejects.toThrow(
        expect.objectContaining({ type: "transcript_result_too_large" }),
      );
      expect(Math.max(...reads.map((read) => read.maxRowBytes))).toBeLessThanOrEqual(
        TRANSCRIPTS_RESULT_MAX_BYTES,
      );
      expect(await store.readEntry(target.sessionId)).toBeUndefined();
      expect(await store.readSession(target.sessionId)).toEqual(target);
    },
  );

  it("streams list projections, preserves oversized lookahead and does not retain private metadata across rows", async () => {
    const { store, database } = fixture();
    const first = session("a");
    const second = session("b", { title: "x".repeat(TRANSCRIPTS_RESULT_MAX_BYTES + 1) });
    await store.writeSession(first);
    await store.writeSession(second);
    const reads = observeArchiveReads(store, database());
    const page = await listTranscriptLibrary(store, { limit: 1 });
    expect(page.sessions.map((entry) => entry.sessionId)).toEqual(["a"]);
    expect(page.nextCursor).not.toBeNull();
    expect(Math.max(...reads.map((read) => read.maxRowBytes))).toBeLessThanOrEqual(
      TRANSCRIPTS_RESULT_MAX_BYTES,
    );
    await expect(listTranscriptLibrary(store, { cursor: page.nextCursor! })).rejects.toThrow(
      expect.objectContaining({ type: "transcript_result_too_large" }),
    );
    for (const id of ["b", "c", "d"]) {
      await store.writeSession(session(id, { title: "x".repeat(600_000) }));
    }
    reads.length = 0;
    await expect(listTranscriptLibrary(store, { query: "x" })).rejects.toThrow(
      expect.objectContaining({ type: "transcript_result_too_large" }),
    );
    expect(reads[0]?.rows).toBe(2);
    expect(reads.every((read) => read.closed)).toBe(true);
    for (const id of ["b", "c", "d"]) {
      await store.writeSession(session(id, { metadata: { private: "x".repeat(600_000) } }));
    }
    expect(
      (await listTranscriptLibrary(store, {})).sessions.map((entry) => entry.sessionId),
    ).toEqual(["a", "b", "c", "d"]);
  });

  it("bounds summary transfer after omitting duplicated history and keeps the larger export budget", async () => {
    const { store, database } = fixture();
    const target = session("summary-bound");
    await store.writeSession(target);
    await store.appendUtteranceForSession(target, { text: "saved note" });
    const summary = {
      ...summarizeTranscripts({ session: target, utterances: [] }),
      transcript: ["x".repeat(TRANSCRIPTS_EXPORT_MAX_BYTES + 1)],
    };
    await store.writeSummary({ ...summary, transcript: [] }, target);
    const db = database();
    executeSqliteQuerySync(
      db,
      meetingTranscriptDb(db)
        .updateTable("meeting_transcript_summaries")
        .set({ summary_json: JSON.stringify(summary) })
        .where("session_id", "=", target.sessionId)
        .where("session_started_at", "=", target.startedAt),
    );
    const reads = observeArchiveReads(store, database());
    expect(
      (await getTranscriptLibrary(store, { selector: transcriptSessionSelector(target) })).summary
        ?.overview,
    ).toBe(summary.overview);
    expect(Math.max(...reads.map((read) => read.maxRowBytes))).toBeLessThanOrEqual(
      TRANSCRIPTS_RESULT_MAX_BYTES,
    );
    await store.writeSummary(
      { ...summary, transcript: [], overview: "é".repeat(TRANSCRIPTS_RESULT_MAX_BYTES / 2 + 1) },
      target,
    );
    reads.length = 0;
    await expect(
      getTranscriptLibrary(store, { selector: transcriptSessionSelector(target), limit: 50 }),
    ).rejects.toThrow(expect.objectContaining({ type: "transcript_result_too_large" }));
    expect(Math.max(...reads.map((read) => read.maxRowBytes))).toBeLessThanOrEqual(
      TRANSCRIPTS_RESULT_MAX_BYTES,
    );
    const legacy = await getTranscriptLibrary(store, {
      selector: transcriptSessionSelector(target),
    });
    expect(Buffer.byteLength(JSON.stringify(legacy))).toBeGreaterThan(TRANSCRIPTS_RESULT_MAX_BYTES);
    expect(legacy.summary?.overview).toBe("é".repeat(TRANSCRIPTS_RESULT_MAX_BYTES / 2 + 1));
    const exported = await exportTranscriptLibrary(store, {
      selector: transcriptSessionSelector(target),
      format: "markdown",
    });
    expect(exported.sizeBytes).toBeGreaterThan(TRANSCRIPTS_RESULT_MAX_BYTES);
    expect(exported.sizeBytes).toBeLessThan(TRANSCRIPTS_EXPORT_MAX_BYTES);
    expect(Buffer.from(exported.data, "base64").toString("utf8")).toContain("saved note");
  });

  it("keeps exact JSON escaping checks and exports valid content above the reader limit", async () => {
    const { store, database } = fixture();
    const target = session("escaping");
    await store.writeSession(target);
    const text = '"'.repeat(600_000) + "é🦞";
    await store.appendUtteranceForSession(target, { text });
    const reads = observeArchiveReads(store, database());
    await expect(
      getTranscriptLibrary(store, {
        selector: transcriptSessionSelector(target),
        includeUtterances: true,
        limit: 1,
      }),
    ).rejects.toThrow(expect.objectContaining({ type: "transcript_result_too_large" }));
    const exported = await exportTranscriptLibrary(store, {
      selector: transcriptSessionSelector(target),
      format: "jsonl",
    });
    expect(exported.sizeBytes).toBeGreaterThan(TRANSCRIPTS_RESULT_MAX_BYTES);
    expect(exported.sizeBytes).toBeLessThan(TRANSCRIPTS_EXPORT_MAX_BYTES);
    expect(JSON.parse(Buffer.from(exported.data, "base64").toString("utf8"))).toEqual({
      sequence: 0,
      text,
    });
    await store.appendUtteranceForSession(target, {
      text: "x".repeat(TRANSCRIPTS_EXPORT_MAX_BYTES + 1),
    });
    reads.length = 0;
    await expect(
      exportTranscriptLibrary(store, {
        selector: transcriptSessionSelector(target),
        format: "jsonl",
      }),
    ).rejects.toThrow(
      expect.objectContaining({
        type: "transcript_export_too_large",
        maxBytes: TRANSCRIPTS_EXPORT_MAX_BYTES,
      }),
    );
    expect(Math.max(...reads.map((read) => read.maxRowBytes))).toBeLessThanOrEqual(
      TRANSCRIPTS_EXPORT_MAX_BYTES,
    );
    expect(reads.every((read) => read.closed)).toBe(true);
  });
});
