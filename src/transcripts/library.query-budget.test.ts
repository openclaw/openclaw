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
import { createTranscriptCaptureAppends } from "./capture-appends.js";
import { activeSessions } from "./capture-startup.js";
import { exportTranscriptLibrary, getTranscriptLibrary, listTranscriptLibrary } from "./library.js";
import {
  createTranscriptLibraryStoreFixture,
  transcriptLibrarySession as session,
} from "./library.store.test-support.js";
import { readTranscriptLibraryStatus } from "./status.js";
import {
  cursorScope,
  encodeCursor,
  queryTranscriptReadEntries,
  readLatestTranscriptEntry,
  readTranscriptEntry,
  readTranscriptLibraryEntry,
} from "./store-read.js";
import {
  readTranscriptSessionMatches,
  readTranscriptSummarySnapshot,
} from "./store-sqlite-read.js";
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

function seedExportBookkeeping(db: DatabaseSync) {
  executeSqliteQuerySync(
    db,
    meetingTranscriptDb(db)
      .updateTable("meeting_transcript_sessions")
      .set({
        export_manifest_json: JSON.stringify({ "retained-export.md": "x".repeat(16_384) }),
        export_pending_json: JSON.stringify(["x".repeat(16_384)]),
      }),
  );
}

function observeArchiveReads(
  store: ReturnType<typeof createTranscriptLibraryStoreFixture>["store"],
  database: DatabaseSync,
) {
  // SQL allocation assertions use the same kernels locally; the worker fixture
  // separately proves the real facade's transport and absence of parent SQL.
  vi.spyOn(store, "listReadEntries").mockImplementation(
    new Proxy(store.listReadEntries.bind(store), {
      async apply(_target, _receiver, [options]) {
        return queryTranscriptReadEntries(database, options);
      },
    }),
  );
  vi.spyOn(store, "readEntry").mockImplementation(async (selector, purpose) =>
    readTranscriptEntry(database, selector, purpose),
  );
  vi.spyOn(store, "readLatestEntry").mockImplementation(async () =>
    readLatestTranscriptEntry(database),
  );
  vi.spyOn(store, "readLibraryEntry").mockImplementation(async (params) =>
    readTranscriptLibraryEntry(database, params),
  );
  vi.spyOn(store, "readSummarySnapshot").mockImplementation(async (descriptor, maxUtterances) =>
    readTranscriptSummarySnapshot(database, descriptor, maxUtterances),
  );
  clearNodeSqliteKyselyCacheForDatabase(database);
  const queries: Array<{
    sql: string;
    executions: number;
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
    const record = { sql, executions: 0, rows: 0, bytes: 0, maxRowBytes: 0, closed: false };
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
    const nativeAll = statement.all.bind(statement);
    vi.spyOn(statement, "all").mockImplementation((...parameters) => {
      record.executions++;
      try {
        const rows = nativeAll(...parameters);
        rows.forEach(observeRow);
        return rows;
      } finally {
        record.closed = true;
      }
    });
    const nativeGet = statement.get.bind(statement);
    vi.spyOn(statement, "get").mockImplementation(
      new Proxy(nativeGet, {
        apply(get, _receiver, parameters) {
          record.executions++;
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
      record.executions++;
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
  it.each(["session matches", "summary snapshot"])(
    "omits export bookkeeping from %s",
    async (kind) => {
      const { store, database } = fixture();
      const first = session("review");
      const later = session("review", { startedAt: "2026-08-21T10:00:00.000Z" });
      const collision = session("review?", { startedAt: "2026-08-22T10:00:00.000Z" });
      for (const target of [first, later, collision]) {
        await store.writeSession(target);
      }
      await store.appendUtteranceForSession(later, { text: "Summarize this speech" });
      const db = database();
      seedExportBookkeeping(db);
      executeSqliteQuerySync(
        db,
        meetingTranscriptDb(db)
          .insertInto("meeting_transcript_summaries")
          .values(
            [first, collision].map((target) => ({
              session_id: target.sessionId,
              session_started_at: target.startedAt,
              summary_json: "{malformed",
              utterance_count: 0,
            })),
          ),
      );
      const reads = observeArchiveReads(store, db);
      if (kind === "session matches") {
        const matches = readTranscriptSessionMatches(db, "review");
        expect(matches.qualified).toEqual([]);
        expect(matches.unqualified).toMatchObject([
          { session: later, hasSummary: false },
          { session: first, hasSummary: true },
          { session: collision, hasSummary: true },
        ]);
        expect(reads.reduce((count, read) => count + read.executions, 0)).toBeLessThanOrEqual(3);
      } else {
        expect(await store.readSummarySnapshot(later, 20)).toMatchObject({
          nextSequence: 1,
          summaryRevision: "",
          utterances: [{ text: "Summarize this speech" }],
        });
        expect(reads.some((read) => read.rows > 0)).toBe(true);
      }
      expect(reads.reduce((bytes, read) => bytes + read.bytes, 0)).toBeLessThan(2_048);
    },
  );
  it("stops active status descriptor reads when the public result budget is consumed", async () => {
    const { store, database } = fixture();
    for (let index = 0; index < 6; index++) {
      const target = session(`active-${index}`, {
        title: "x".repeat(TRANSCRIPTS_RESULT_MAX_BYTES / 2),
      });
      await store.writeSession(target);
      activeSessions.set(target.sessionId, {
        appends: createTranscriptCaptureAppends(() => {}),
        session: target,
        providerId: target.source.providerId,
        stopProvider: async () => {
          throw new Error("Reading transcript status must not stop capture");
        },
        releaseProvider: async () => {},
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

  it.each(["text", "combined speaker fields", "source and metadata", "last timestamp"])(
    "bounds %s before SQLite returns an oversized row without limiting full-store reads",
    async (field) => {
      const { store, database } = fixture();
      const descriptor = field === "source and metadata" || field === "last timestamp";
      const target = session(
        "allocation",
        field === "source and metadata"
          ? {
              source: { providerId: "manual-transcript", private: "x".repeat(600_000) },
              metadata: { private: "y".repeat(600_000) },
            }
          : {},
      );
      await store.writeSession(target);
      await store.appendUtteranceForSession(
        target,
        field === "text"
          ? { text: "é\0".repeat(TRANSCRIPTS_RESULT_MAX_BYTES / 2) }
          : field === "combined speaker fields"
            ? { text: "small", speaker: { id: "x".repeat(600_000), label: "y".repeat(600_000) } }
            : {
                text: "note",
                ...(field === "last timestamp"
                  ? { endedAt: "x".repeat(TRANSCRIPTS_RESULT_MAX_BYTES + 1) }
                  : {}),
              },
      );
      const reads = observeArchiveReads(store, database());
      const selector = transcriptSessionSelector(target);
      if (descriptor) {
        for (const read of [
          () => listTranscriptLibrary(store, {}),
          () => store.readLatestEntry(),
          () => store.readEntry(selector),
        ]) {
          await expect(read()).rejects.toThrow(
            expect.objectContaining({ type: "transcript_result_too_large" }),
          );
        }
      } else {
        await expect(
          getTranscriptLibrary(store, { selector, includeUtterances: true, limit: 1 }),
        ).rejects.toThrow(
          expect.objectContaining({
            type: "transcript_result_too_large",
            maxBytes: TRANSCRIPTS_RESULT_MAX_BYTES,
          }),
        );
        expect(reads.length).toBeGreaterThan(0);
        expect(reads.every((read) => read.closed)).toBe(true);
      }
      expect(Math.max(...reads.map((read) => read.maxRowBytes))).toBeLessThanOrEqual(
        TRANSCRIPTS_RESULT_MAX_BYTES,
      );
      if (descriptor) {
        expect(await store.readEntry(target.sessionId)).toBeUndefined();
        expect(await store.readSession(target.sessionId)).toEqual(target);
      } else {
        expect(await store.readUtterancesForSession(target)).toHaveLength(1);
      }
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

  it.each(["list", "get"])(
    "uses oversized %s lookahead only for pagination, then rejects that requested row",
    async (kind) => {
      const { store, database } = fixture();
      const target = session(kind === "list" ? "a" : "lookahead");
      await store.writeSession(target);
      const oversized = "x".repeat(TRANSCRIPTS_RESULT_MAX_BYTES + 1);
      if (kind === "list") {
        await store.writeSession(session("b", { title: oversized }));
      } else {
        await store.appendUtteranceForSession(target, { text: "first" });
        await store.appendUtteranceForSession(target, { text: oversized });
      }
      let selector = transcriptSessionSelector(target);
      const readPage = (cursor?: string) =>
        kind === "list"
          ? listTranscriptLibrary(store, cursor ? { cursor } : { limit: 1 })
          : getTranscriptLibrary(store, {
              selector,
              includeUtterances: true,
              limit: 1,
              cursor,
            });
      const reads = observeArchiveReads(store, database());
      const page = await readPage();
      if ("sessions" in page) {
        expect(page.sessions.map((entry) => entry.sessionId)).toEqual(["a"]);
      } else {
        expect(page.utterances).toEqual([{ sequence: 0, text: "first" }]);
        selector = page.session.selector;
      }
      expect(page.nextCursor).not.toBeNull();
      expect(Math.max(...reads.map((read) => read.maxRowBytes))).toBeLessThanOrEqual(
        TRANSCRIPTS_RESULT_MAX_BYTES,
      );
      await expect(readPage(page.nextCursor!)).rejects.toThrow(
        expect.objectContaining({ type: "transcript_result_too_large" }),
      );
      if (kind === "list") {
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
      }
    },
  );

  it("budgets public previews after projection while retaining raw tool bounds", async () => {
    const { store, database } = fixture();
    for (const id of ["a", "b", "c"]) {
      const target = session(id, {
        source: { providerId: "manual-transcript", private: "synthetic-private" },
        metadata: { private: "synthetic-metadata", agentId: "main" },
      });
      await store.writeSession(target);
      await store.writeSummary(
        {
          ...summarizeTranscripts({ session: target, utterances: [] }),
          overview: "x".repeat(600_000),
        },
        target,
      );
    }
    const reads = observeArchiveReads(store, database());
    const page = await listTranscriptLibrary(store, { limit: 2 });
    expect(page.sessions.map(({ overview }) => overview)).toEqual([
      "x".repeat(280),
      "x".repeat(280),
    ]);
    expect(page.nextCursor).not.toBeNull();
    expect(JSON.stringify(page)).not.toContain("synthetic-");
    expect(reads).toHaveLength(1);
    expect(reads[0]).toMatchObject({ executions: 1, rows: 3, closed: true });
    await expect(store.listReadEntries({ limit: 2 })).rejects.toThrow(
      expect.objectContaining({ type: "transcript_result_too_large" }),
    );
    await expect(
      listTranscriptLibrary(store, { limit: 1 }, () => "x".repeat(TRANSCRIPTS_RESULT_MAX_BYTES)),
    ).rejects.toThrow(expect.objectContaining({ type: "transcript_result_too_large" }));
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
