import { vi } from "vitest";
import { clearNodeSqliteKyselyCacheForDatabase } from "../../infra/kysely-sync.js";
import type { EngineConnection } from "../../infra/sql-connection.js";
import { requireNativeSqliteDatabase } from "../../test-utils/native-sqlite.js";

export function observePayloadAcquisition(
  connection: EngineConnection,
  marker: string,
  read: () => void,
) {
  const db = requireNativeSqliteDatabase(connection);
  clearNodeSqliteKyselyCacheForDatabase(db);
  const prepare = db.prepare.bind(db);
  const parse = JSON.parse;
  const restoreStatements: Array<() => void> = [];
  const pending = new Map<string, number>();
  let acquiredBytes = 0;
  let largestRowBytes = 0;
  let peakPendingBytes = 0;
  let decodedRows = 0;
  const prepareSpy = vi.spyOn(db, "prepare").mockImplementation((query) => {
    const statement = prepare(query);
    const iterate = statement.iterate.bind(statement);
    // Observe SQLite result acquisition, including payloads rejected before JSON.parse.
    const iterateSpy = vi.spyOn(statement, "iterate").mockImplementation(function* (...params) {
      for (const row of iterate(...params)) {
        for (const value of Object.values(row)) {
          if (typeof value === "string" && value.includes(marker)) {
            const bytes = Buffer.byteLength(value);
            acquiredBytes += bytes;
            pending.set(value, bytes);
            largestRowBytes = Math.max(largestRowBytes, bytes);
            peakPendingBytes = Math.max(
              peakPendingBytes,
              [...pending.values()].reduce((a, b) => a + b, 0),
            );
          }
        }
        yield row;
      }
      return undefined;
    });
    restoreStatements.push(() => iterateSpy.mockRestore());
    return statement;
  });
  const parseSpy = vi.spyOn(JSON, "parse").mockImplementation((text, reviver) => {
    if (typeof text === "string" && text.includes(marker)) {
      decodedRows++;
      pending.delete(text);
    }
    return parse(text, reviver);
  });
  try {
    read();
  } finally {
    parseSpy.mockRestore();
    prepareSpy.mockRestore();
    for (const restore of restoreStatements) {
      restore();
    }
  }
  return {
    acquiredBytes,
    largestRowBytes,
    peakPendingBytes,
    decodedRows,
    pendingRows: pending.size,
  };
}
