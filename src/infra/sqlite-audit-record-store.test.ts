import { afterEach, describe, expect, it } from "vitest";
import { closeOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { withTempDir } from "../test-helpers/temp-dir.js";
import { createSqliteAuditRecordStore } from "./sqlite-audit-record-store.js";

describe("SQLite audit record store", () => {
  afterEach(() => {
    closeOpenClawStateDatabase();
  });

  it("keeps the newest configured number of rows per scope", async () => {
    await withTempDir({ prefix: "openclaw-audit-store-" }, async (stateDir) => {
      const store = createSqliteAuditRecordStore<{ value: number }>({
        scope: "bounded-test",
        maxEntries: 2,
        env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
      });

      store.register("one", { value: 1 }, 1);
      store.register("two", { value: 2 }, 2);
      store.register("three", { value: 3 }, 3);

      expect(store.size()).toBe(2);
      expect(store.entries().map((entry) => entry.key)).toEqual(["two", "three"]);
    });
  });

  it("preserves insertion order and prunes the oldest row when timestamps tie", async () => {
    await withTempDir({ prefix: "openclaw-audit-store-ties-" }, async (stateDir) => {
      const store = createSqliteAuditRecordStore<{ value: number }>({
        scope: "tied-timestamps",
        maxEntries: 2,
        env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
      });

      store.register("z-first", { value: 1 }, 1);
      store.register("a-second", { value: 2 }, 1);
      expect(store.entries().map((entry) => entry.key)).toEqual(["z-first", "a-second"]);

      store.register("m-third", { value: 3 }, 1);
      expect(store.entries().map((entry) => entry.key)).toEqual(["a-second", "m-third"]);
    });
  });
});
