import { expect, it } from "vitest";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import {
  forbidMainThreadSql,
  observeMainThreadReads,
  observeMainThreadSql,
} from "./main-thread-sql-spies.test-support.js";

it("observes every native SQL method and restores observation and refusal scopes", () => {
  const { DatabaseSync } = requireNodeSqlite();
  const database = new DatabaseSync(":memory:");
  database.exec("CREATE TABLE fixture (value INTEGER)");
  const read = database.prepare("SELECT value FROM fixture");
  const write = database.prepare("INSERT INTO fixture VALUES (?)");
  const operations = [
    { run: () => database.prepare("SELECT 1"), reads: false },
    { run: () => database.exec("SELECT 1"), reads: false },
    { run: () => read.get(), reads: true },
    { run: () => read.all(), reads: true },
    { run: () => write.run(1), reads: false },
    { run: () => [...read.iterate()], reads: true },
  ];
  const observer = observeMainThreadSql();
  let forbidden: ReturnType<typeof forbidMainThreadSql> | undefined;
  let closing: ReturnType<typeof observeMainThreadSql> | undefined;
  let reads: ReturnType<typeof observeMainThreadReads> | undefined;
  try {
    observer.calibrate();
    observer.expectIdle();
    for (const { run: operation } of operations) {
      operation();
      expect(observer.count()).toBe(1);
      observer.clear();
      observer.expectIdle();
    }
    observer.restore();
    reads = observeMainThreadReads();
    for (const operation of operations) {
      operation.run();
      expect(reads.count()).toBe(operation.reads ? 1 : 0);
      reads.clear();
    }
    reads.restore();
    forbidden = forbidMainThreadSql("Synthetic host SQL refusal");
    for (const { run: operation } of operations) {
      expect(operation).toThrow("Synthetic host SQL refusal");
    }
    forbidden.restore();
    for (const { run: operation } of operations) {
      operation();
    }
    expect(observer.count()).toBe(0);
    closing = observeMainThreadSql({ includeClose: true });
    database.close();
    expect(closing.count()).toBe(1);
  } finally {
    observer.restore();
    reads?.restore();
    forbidden?.restore();
    closing?.restore();
    if (database.isOpen) {
      database.close();
    }
  }
});
