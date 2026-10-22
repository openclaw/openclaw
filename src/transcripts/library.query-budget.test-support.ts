import type { DatabaseSync } from "node:sqlite";
import { vi } from "vitest";
import { clearNodeSqliteKyselyCacheForDatabase } from "../infra/kysely-sync.js";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import type { EngineConnection } from "../infra/sql-connection.js";
import { requireNativeSqliteDatabase } from "../test-utils/native-sqlite.js";
import type { createTranscriptLibraryStoreFixture } from "./library.store.test-support.js";
import {
  iterateTranscriptExport,
  queryTranscriptReadEntries,
  readLatestTranscriptEntry,
  readTranscriptEntry,
  readTranscriptLibraryEntry,
} from "./store-read.js";
import { readTranscriptSummarySnapshot } from "./store-sqlite-read.js";

function queryObservation(sql: string) {
  return { sql, executions: 0, rows: 0, bytes: 0, maxRowBytes: 0, closed: false };
}

export function observeArchiveReads(
  store: ReturnType<typeof createTranscriptLibraryStoreFixture>["store"],
  connection: EngineConnection,
) {
  const database = requireNativeSqliteDatabase(connection);
  // SQL allocation assertions use the same kernels locally; the worker fixture
  // separately proves the real facade's transport and absence of parent SQL.
  vi.spyOn(store, "listReadEntries").mockImplementation(
    new Proxy(store.listReadEntries.bind(store), {
      async apply(_target, _receiver, [options]) {
        return queryTranscriptReadEntries(database, options);
      },
    }),
  );
  const localRead =
    <A extends unknown[], R>(read: (db: typeof database, ...args: A) => R) =>
    async (...args: A) =>
      read(database, ...args);
  vi.spyOn(store, "readEntry").mockImplementation(localRead(readTranscriptEntry));
  vi.spyOn(store, "readLatestEntry").mockImplementation(localRead(readLatestTranscriptEntry));
  vi.spyOn(store, "readLibraryEntry").mockImplementation(localRead(readTranscriptLibraryEntry));
  vi.spyOn(store, "streamExport").mockImplementation(async (selector, includeNotes, consume) => {
    const rows = iterateTranscriptExport(database, selector, includeNotes);
    try {
      for (let step = rows.next(); ; step = rows.next()) {
        if (step.done) {
          return step.value;
        }
        await consume([step.value]);
      }
    } catch (error) {
      rows.throw(error);
      throw error;
    }
  });
  vi.spyOn(store, "readSummarySnapshot").mockImplementation(
    localRead(readTranscriptSummarySnapshot),
  );
  clearNodeSqliteKyselyCacheForDatabase(database);
  const queries: ReturnType<typeof queryObservation>[] = [];
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
    const record = queryObservation(sql);
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
    type Row = Record<string, unknown>;
    const observeCall = <T extends (...args: never[]) => Row | Row[] | undefined>(call: T): T =>
      new Proxy(call, {
        apply(invoke, receiver, args) {
          record.executions++;
          try {
            const result: Row | Row[] | undefined = Reflect.apply(invoke, receiver, args);
            (Array.isArray(result) ? result : result ? [result] : []).forEach(observeRow);
            return result;
          } finally {
            record.closed = true;
          }
        },
      });
    vi.spyOn(statement, "all").mockImplementation(observeCall(statement.all.bind(statement)));
    vi.spyOn(statement, "get").mockImplementation(observeCall(statement.get.bind(statement)));
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
