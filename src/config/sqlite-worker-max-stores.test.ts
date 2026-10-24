import { describe, expect, it } from "vitest";
import {
  SQLITE_WORKER_DEFAULT_MAX_STORES,
  SQLITE_WORKER_MAX_STORES_LIMIT,
  assertSqliteWorkerMaxStores,
  setSqliteWorkerMaxStores,
} from "../infra/sqlite-worker-broker-limits.js";
import { resolveSqliteWorkerMaxStores } from "./sqlite-worker-max-stores.js";
import type { OpenClawConfig } from "./types.openclaw.js";

describe("SQLite worker store budget", () => {
  it("keeps the historical default without a config", () => {
    expect(resolveSqliteWorkerMaxStores()).toBe(SQLITE_WORKER_DEFAULT_MAX_STORES);
  });

  it("scales the default to twice the configured agent count", () => {
    const config = {
      agents: {
        entries: Object.fromEntries(
          Array.from({ length: 110 }, (_, index) => ["agent-" + index, { id: "agent-" + index }]),
        ),
      },
    } as OpenClawConfig;
    expect(resolveSqliteWorkerMaxStores(config)).toBe(220);
  });

  it("prefers an explicit operator limit", () => {
    const config = {
      database: { sqlite: { maxStores: 192 } },
    } as OpenClawConfig;
    expect(resolveSqliteWorkerMaxStores(config)).toBe(192);
  });

  it.each([0, -1, 1.5, SQLITE_WORKER_MAX_STORES_LIMIT + 1])(
    "rejects an invalid store limit %s",
    (value) => {
      expect(() => assertSqliteWorkerMaxStores(value)).toThrow(RangeError);
    },
  );

  it("publishes a bounded budget", () => {
    setSqliteWorkerMaxStores(2);
    expect(() => setSqliteWorkerMaxStores(0)).toThrow(RangeError);
    setSqliteWorkerMaxStores(SQLITE_WORKER_DEFAULT_MAX_STORES);
  });
});
