import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../infra/kysely-sync.js";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
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

  it("renews active leases so long critical sections are not stolen", async () => {
    await withTempDir({ prefix: "openclaw-state-lock-renew-" }, async (dir) => {
      const dbPath = path.join(dir, "state.sqlite");
      const order: string[] = [];
      let releaseFirst!: () => void;
      const firstCanFinish = new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      let first!: Promise<void>;
      const firstEntered = new Promise<void>((resolve) => {
        first = withOpenClawStateLock(
          "shared",
          { path: dbPath, stale: 200, retries: FAST_RETRY },
          async () => {
            order.push("first-enter");
            resolve();
            await firstCanFinish;
            order.push("first-exit");
          },
        );
      });

      await firstEntered;
      await new Promise((resolve) => setTimeout(resolve, 450));
      const second = withOpenClawStateLock(
        "shared",
        { path: dbPath, stale: 200, retries: FAST_RETRY },
        async () => {
          order.push("second-enter");
        },
      );

      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(order).toEqual(["first-enter"]);

      releaseFirst();
      await Promise.all([first, second]);
      expect(order).toEqual(["first-enter", "first-exit", "second-enter"]);
    });
  });

  it("releases the lease when the guarded task throws synchronously", async () => {
    await withTempDir({ prefix: "openclaw-state-lock-sync-throw-" }, async (dir) => {
      const dbPath = path.join(dir, "state.sqlite");
      expect.assertions(2);

      await expect(
        withOpenClawStateLock("shared", { path: dbPath, retries: FAST_RETRY }, () => {
          throw new Error("boom");
        }),
      ).rejects.toThrow("boom");

      await expect(
        withOpenClawStateLock("shared", { path: dbPath, retries: FAST_RETRY }, async () => "ok"),
      ).resolves.toBe("ok");
    });
  });

  it("rejects and aborts the guarded task when lease renewal loses ownership", async () => {
    await withTempDir({ prefix: "openclaw-state-lock-lost-" }, async (dir) => {
      const dbPath = path.join(dir, "state.sqlite");
      let signal!: AbortSignal;
      let locked!: Promise<void>;
      const entered = new Promise<void>((resolve) => {
        locked = withOpenClawStateLock(
          "shared",
          { path: dbPath, stale: 20, retries: FAST_RETRY },
          async (lockSignal) => {
            signal = lockSignal;
            resolve();
            await new Promise<never>(() => {});
          },
        );
      });
      await entered;

      runOpenClawStateWriteTransaction(
        (database) => {
          const db = getNodeSqliteKysely<StateLockTestDatabase>(database.db);
          executeSqliteQuerySync(
            database.db,
            db
              .deleteFrom("state_leases")
              .where("scope", "=", "runtime.lock")
              .where("lease_key", "=", "shared"),
          );
        },
        { path: dbPath },
      );

      await expect(locked).rejects.toThrow("Lost SQLite state lock runtime.lock:shared");
      expect(signal.aborted).toBe(true);
    });
  });
});
