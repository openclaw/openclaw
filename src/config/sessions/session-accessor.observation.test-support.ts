import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, vi } from "vitest";
import { observeHostDataSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import * as sqliteQueries from "../../infra/kysely-sync.js";

export async function withoutHostSql<T>(operation: () => Promise<T>): Promise<T> {
  const sql = observeHostDataSql();
  try {
    const result = await operation();
    expect(sql.queries, "caller-thread SQL").toEqual([]);
    return result;
  } finally {
    sql.restore();
  }
}

export async function withoutPayloadReads(
  column: "entry_json" | "event_json",
  payload: string,
  operation: () => Promise<unknown>,
) {
  const iterate = sqliteQueries.iterateSqliteQuerySync;
  let acquired = 0;
  const reads = vi.spyOn(sqliteQueries, "iterateSqliteQuerySync").mockImplementation(function* <
    Row,
  >(...args: Parameters<typeof sqliteQueries.iterateSqliteQuerySync<Row>>) {
    for (const row of iterate<Row>(...args)) {
      const value = isRecord(row) ? row[column] : undefined;
      if (typeof value === "string" && value.includes(payload)) {
        acquired++;
      }
      yield row;
    }
  });
  try {
    await operation();
  } finally {
    reads.mockRestore();
  }
  expect(acquired).toBe(0);
}
