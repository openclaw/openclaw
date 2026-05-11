import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { executeSqliteQueryTakeFirstSync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { withTempDir } from "../test-helpers/temp-dir.js";
import { withOpenClawStateLock } from "./sqlite-state-lock.js";

const FAST_RETRY = {
  retries: 100,
  factor: 1,
  minTimeout: 1,
  maxTimeout: 1,
  randomize: false,
} as const;

type StateLockTestDatabase = Pick<OpenClawStateKyselyDatabase, "state_leases">;

describe("withOpenClawStateLock", () => {
  afterEach(() => {
    closeOpenClawStateDatabaseForTest();
  });

  it("serializes contenders through SQLite state and cleans up the lease", async () => {
    await withTempDir({ prefix: "openclaw-state-lock-" }, async (dir) => {
      const dbPath = path.join(dir, "state.sqlite");
      const order: string[] = [];
      let releaseFirst!: () => void;
      const firstCanFinish = new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      let first!: Promise<void>;
      const firstEntered = new Promise<void>((resolve) => {
        first = withOpenClawStateLock("shared", { path: dbPath, retries: FAST_RETRY }, async () => {
          order.push("first-enter");
          resolve();
          await firstCanFinish;
          order.push("first-exit");
        });
      });

      await firstEntered;
      const second = withOpenClawStateLock(
        "shared",
        { path: dbPath, retries: FAST_RETRY },
        async () => {
          order.push("second-enter");
        },
      );

      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(order).toEqual(["first-enter"]);

      releaseFirst();
      await Promise.all([first, second]);
      expect(order).toEqual(["first-enter", "first-exit", "second-enter"]);
      const database = openOpenClawStateDatabase({ path: dbPath });
      const db = getNodeSqliteKysely<StateLockTestDatabase>(database.db);
      const row = executeSqliteQueryTakeFirstSync(
        database.db,
        db
          .selectFrom("state_leases")
          .select("owner")
          .where("scope", "=", "runtime.lock")
          .where("lease_key", "=", "shared"),
      );
      expect(row).toBeUndefined();
    });
  });
});
