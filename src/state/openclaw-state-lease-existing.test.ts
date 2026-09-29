import { AsyncResource } from "node:async_hooks";
import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { createDeferred, withTestTimeout } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import { withPluginLifecycleLease } from "../plugins/plugin-lifecycle-lease.js";
import { AGENT_DATABASE_MAINTENANCE_LEASE } from "./openclaw-agent-db-lease.js";
import {
  closeOpenClawAgentDatabasesAsync,
  openOpenClawAgentDatabase,
  withAgentDatabaseMaintenanceLease,
} from "./openclaw-agent-db.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "./openclaw-state-db-contract.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "./openclaw-state-db.js";
import { withOpenClawStateLease, type OpenClawStateLeaseContext } from "./openclaw-state-lease.js";

const dirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    await closeOpenClawAgentDatabasesAsync();
    closeOpenClawStateDatabaseForTest();
    cleanup();
  }),
);
function source(holdAgent = false) {
  const root = dirs.make("state-lease-before-migration-");
  const env = { HOME: root, OPENCLAW_STATE_DIR: root };
  const pathname = openOpenClawStateDatabase({ env }).path;
  const agent = holdAgent ? openOpenClawAgentDatabase({ agentId: "worker", env }) : undefined;
  closeOpenClawStateDatabaseForTest();
  const db = openNodeSqliteDatabase(pathname);
  try {
    db.exec(`PRAGMA foreign_keys=OFF;
      DROP TABLE IF EXISTS skill_workshop_proposal_events;
      DROP TABLE IF EXISTS skill_workshop_proposal_rollbacks;
      DROP TABLE IF EXISTS skill_workshop_collection_reviews;
      DROP TABLE IF EXISTS skill_workshop_proposals;
      PRAGMA user_version=15;
      UPDATE schema_meta SET schema_version=15 WHERE meta_key='primary';`);
  } finally {
    db.close();
  }
  const options = { env, schemaPolicy: "existing" as const };
  const lease = {
    scope: "core:test-premigration",
    key: "global",
    database: { scope: "shared" as const, options: { env }, schemaPolicy: "existing" as const },
    leaseMs: 30_000,
    waitMs: 0,
  };
  return { root, pathname, options, lease, agent };
}
function inspect(pathname: string) {
  const db = openNodeSqliteDatabase(pathname, { readOnly: true });
  try {
    return {
      version: db.prepare("PRAGMA user_version").get(),
      schema: db
        .prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name")
        .all(),
      metadata: db.prepare("SELECT * FROM schema_meta ORDER BY meta_key").all(),
      leases: db.prepare("SELECT * FROM state_leases").all(),
    };
  } finally {
    db.close();
  }
}
it.each(["timer", "worker"] as const)(
  "acquires, verifies, renews and releases an actual %s lease without migrating",
  async (heartbeat) => {
    const f = source();
    const before = inspect(f.pathname);
    let entered: ReturnType<typeof inspect> | undefined;
    await withOpenClawStateLease(
      { ...f.lease, ...(heartbeat === "worker" ? { heartbeat } : {}) },
      async (lease) => {
        lease.assertOwned();
        lease.renew?.();
        entered = inspect(f.pathname);
      },
    );
    expect(entered?.version).toEqual(before.version);
    expect(entered?.schema).toEqual(before.schema);
    expect(entered?.leases).toHaveLength(1);
    expect(inspect(f.pathname)).toEqual(before);
  },
);
it("takes plugin and agent writer ownership before allowing the candidate migration", async () => {
  const f = source();
  let atEntry: ReturnType<typeof inspect> | undefined;
  await withPluginLifecycleLease(f.options, () =>
    withAgentDatabaseMaintenanceLease(f.options, async (maintenance) => {
      maintenance.assertOwned();
      atEntry = inspect(f.pathname);
    }),
  );
  expect(atEntry?.version).toEqual({ user_version: 15 });
  expect(atEntry?.leases).toHaveLength(2);
  expect(inspect(f.pathname).version).toEqual({ user_version: 15 });
  expect(inspect(f.pathname).leases).toEqual([]);
});
it("refuses a competing owner and preserves a replacement lease on cleanup", async () => {
  const f = source();
  const outside = new AsyncResource("premigration-competing-owner");
  let competingEntered = false;
  try {
    await expect(
      withOpenClawStateLease(f.lease, async (held) => {
        await expect(
          outside.runInAsyncScope(() =>
            withOpenClawStateLease(f.lease, async () => {
              competingEntered = true;
            }),
          ),
        ).rejects.toMatchObject({
          code: "OPENCLAW_STATE_LEASE_HELD",
          outcome: { kind: "held" },
        });
        const db = openNodeSqliteDatabase(f.pathname);
        try {
          db.prepare("UPDATE state_leases SET owner='replacement' WHERE scope=?").run(
            f.lease.scope,
          );
        } finally {
          db.close();
        }
        held.assertOwned();
      }),
    ).rejects.toThrow(/lost/);
  } finally {
    outside.emitDestroy();
  }
  expect(competingEntered).toBe(false);
  expect(inspect(f.pathname).version).toEqual({ user_version: 15 });
  expect(inspect(f.pathname).leases).toEqual([expect.objectContaining({ owner: "replacement" })]);
});
it("does not create missing existing-only lease state", async () => {
  const root = dirs.make("state-lease-missing-");
  const pathname = path.join(root, "missing.sqlite");
  await expect(
    withOpenClawStateLease(
      {
        scope: "test",
        key: "missing",
        leaseMs: 30_000,
        waitMs: 0,
        database: { scope: "shared", options: { path: pathname }, schemaPolicy: "existing" },
      },
      async () => {},
    ),
  ).rejects.toThrow();
  expect(fs.existsSync(pathname)).toBe(false);
});
it("keeps the maintenance lease live across an explicitly owned migration", async () => {
  const f = source();
  const ready = createDeferred();
  const release = createDeferred();
  let beforeMigration: ReturnType<typeof inspect>["version"] | undefined;
  const run = withOpenClawStateLease(f.lease, async (lease) => {
    beforeMigration = inspect(f.pathname).version;
    ready.resolve();
    await release.promise;
    lease.assertOwned();
    openOpenClawStateDatabase(f.options);
    lease.assertOwned();
  });
  try {
    await withTestTimeout(ready.promise, 10_000, "lease admission did not complete");
  } finally {
    release.resolve();
  }
  await run;
  expect(beforeMigration).toEqual({ user_version: 15 });
  expect(inspect(f.pathname).version).toEqual({ user_version: OPENCLAW_STATE_SCHEMA_VERSION });
  expect(inspect(f.pathname).leases).toEqual([]);
});

it("drains an existing agent handle without migrating while its lease is released", async () => {
  const f = source(true);
  let atEntry: ReturnType<typeof inspect> | undefined;
  await withAgentDatabaseMaintenanceLease(f.options, async (lease) => {
    lease.assertOwned();
    atEntry = inspect(f.pathname);
  });
  expect(f.agent?.db.isOpen).toBe(false);
  expect(atEntry?.version).toEqual({ user_version: 15 });
  expect(inspect(f.pathname).version).toEqual({ user_version: 15 });
});

it("drains cached agent handles from another profile using their own lease database", async () => {
  const target = source(true);
  const otherRoot = dirs.make("state-lease-other-profile-");
  const otherEnv = { HOME: otherRoot, OPENCLAW_STATE_DIR: otherRoot };
  const otherState = openOpenClawStateDatabase({ env: otherEnv }).path;
  const otherAgent = openOpenClawAgentDatabase({ agentId: "other", env: otherEnv });
  const otherBefore = inspect(otherState);
  let entered = false;
  await withAgentDatabaseMaintenanceLease(target.options, async (lease) => {
    lease.assertOwned();
    entered = true;
    expect(target.agent?.db.isOpen).toBe(false);
    expect(otherAgent.db.isOpen).toBe(false);
  });
  expect(entered).toBe(true);
  expect(inspect(target.pathname).version).toEqual({ user_version: 15 });
  expect(inspect(otherState)).toEqual(otherBefore);
  const otherDb = openNodeSqliteDatabase(otherState, { readOnly: true });
  try {
    expect(otherDb.prepare("SELECT lease_id FROM agent_database_leases").all()).toEqual([]);
  } finally {
    otherDb.close();
  }
});

it("does not recreate state displaced before the existing-schema heartbeat opens", async () => {
  const f = source();
  const displaced = `${f.pathname}.displaced`;
  let moved = false;
  let entered = false;
  const onWorker = () => {
    fs.renameSync(f.pathname, displaced);
    moved = true;
  };
  process.once("worker", onWorker);
  try {
    await expect(
      withOpenClawStateLease({ ...f.lease, heartbeat: "worker" }, async () => {
        entered = true;
      }),
    ).rejects.toThrow();
  } finally {
    process.removeListener("worker", onWorker);
  }
  expect(moved).toBe(true);
  expect(entered).toBe(false);
  expect(fs.existsSync(displaced)).toBe(true);
  expect(fs.existsSync(f.pathname)).toBe(false);
});

it("reenters the same real maintenance owner without acquiring or migrating state", async () => {
  const f = source();
  const before = inspect(f.pathname);
  let nested: ReturnType<typeof inspect> | undefined;
  let stale: OpenClawStateLeaseContext | undefined;
  await withAgentDatabaseMaintenanceLease(f.options, async (outer) => {
    await withAgentDatabaseMaintenanceLease(f.options, async (inner) => {
      inner.assertOwned();
      outer.assertOwned();
      stale = inner;
      nested = inspect(f.pathname);
    });
    expect(() => stale?.assertOwned()).toThrow(/closed/);
    outer.assertOwned();
  });
  expect(nested?.leases).toHaveLength(1);
  expect(nested?.version).toEqual(before.version);
  expect(inspect(f.pathname)).toEqual(before);
});

it("refuses nested maintenance redirection before creating another database", async () => {
  const f = source();
  const other = dirs.make("maintenance-other-root-");
  let entered = false;
  await withAgentDatabaseMaintenanceLease(f.options, async (outer) => {
    await expect(
      withAgentDatabaseMaintenanceLease(
        { env: { HOME: other, OPENCLAW_STATE_DIR: other } },
        async () => {
          entered = true;
        },
      ),
    ).rejects.toThrow(/switch/);
    outer.assertOwned();
  });
  expect(entered).toBe(false);
  expect(fs.readdirSync(other)).toEqual([]);
});

it("joins nested maintenance work before releasing the actual durable lease", async () => {
  const f = source();
  const entered = createDeferred();
  const release = createDeferred();
  const outside = new AsyncResource("outside-maintenance-root");
  let settled = false;
  let outer: OpenClawStateLeaseContext | undefined;
  const run = withAgentDatabaseMaintenanceLease(f.options, async (owner) => {
    outer = owner;
    void withAgentDatabaseMaintenanceLease(f.options, async (inner) => {
      entered.resolve();
      await release.promise;
      inner.assertOwned();
      inner.renew?.();
    });
  }).finally(() => {
    settled = true;
  });
  void run.catch(() => undefined);
  try {
    await withTestTimeout(entered.promise, 10_000, "nested maintenance did not enter");
    expect(settled).toBe(false);
    // The outer callback has returned. Already-admitted children may finish,
    // but the escaped outer capability cannot admit another effect.
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect(() => outer?.renew?.()).toThrow(/closed/);
    await expect(
      outside.runInAsyncScope(() =>
        withOpenClawStateLease({ ...f.lease, ...AGENT_DATABASE_MAINTENANCE_LEASE }, async () => {
          throw new Error("competitor was admitted");
        }),
      ),
    ).rejects.toMatchObject({ code: "OPENCLAW_STATE_LEASE_HELD", outcome: { kind: "held" } });
  } finally {
    release.resolve();
    await run;
    outside.emitDestroy();
  }
  expect(settled).toBe(true);
  expect(inspect(f.pathname).leases).toEqual([]);
});

it("reports a failed detached maintenance child before releasing its real owner", async () => {
  const f = source();
  const failure = new Error("detached migration failed");
  await expect(
    withAgentDatabaseMaintenanceLease(f.options, async () => {
      void withAgentDatabaseMaintenanceLease(f.options, async () => {
        await Promise.resolve();
        throw failure;
      });
    }),
  ).rejects.toBe(failure);
  expect(inspect(f.pathname).leases).toEqual([]);
});

it.each([false, true])(
  "retains the first actual ownership failure through maintenance drainage (nested=%s)",
  async (nested) => {
    const f = source();
    let first: unknown;
    const operation = withAgentDatabaseMaintenanceLease(f.options, async (owner) => {
      const db = openNodeSqliteDatabase(f.pathname);
      try {
        const deleted = db
          .prepare("DELETE FROM state_leases WHERE scope = ? AND lease_key = ?")
          .run(AGENT_DATABASE_MAINTENANCE_LEASE.scope, AGENT_DATABASE_MAINTENANCE_LEASE.key);
        expect(deleted.changes).toBe(1);
      } finally {
        db.close();
      }
      try {
        owner.assertOwned();
      } catch (error) {
        first = error;
      }
      expect(first).toBeInstanceOf(Error);
      let repeated: unknown;
      try {
        owner.assertOwned();
      } catch (error) {
        repeated = error;
      }
      expect(repeated).toBe(first);
      if (nested) {
        let entered = false;
        await expect(
          withAgentDatabaseMaintenanceLease(f.options, async () => {
            entered = true;
          }),
        ).rejects.toBe(first);
        expect(entered).toBe(false);
      }
      throw first;
    });
    const outcome = await operation.catch((error: unknown) => error);
    expect(outcome).toBe(first);
    expect(outcome).toMatchObject({ code: "OPENCLAW_STATE_LEASE_LOST" });
  },
);

it("shares a child-first lease loss with its parent and sibling scopes", async () => {
  const f = source();
  let first: unknown;
  let parentFailure: unknown;
  let siblingFailure: unknown;
  let siblingEntered = false;
  const operation = withAgentDatabaseMaintenanceLease(f.options, async (parent) => {
    await withAgentDatabaseMaintenanceLease(f.options, async (child) => {
      const db = openNodeSqliteDatabase(f.pathname);
      try {
        expect(
          db
            .prepare("DELETE FROM state_leases WHERE scope = ? AND lease_key = ?")
            .run(AGENT_DATABASE_MAINTENANCE_LEASE.scope, AGENT_DATABASE_MAINTENANCE_LEASE.key)
            .changes,
        ).toBe(1);
      } finally {
        db.close();
      }
      try {
        child.assertOwned();
      } catch (error) {
        first = error;
      }
    }).catch(() => undefined);
    try {
      parent.assertOwned();
    } catch (error) {
      parentFailure = error;
    }
    siblingFailure = await withAgentDatabaseMaintenanceLease(f.options, async () => {
      siblingEntered = true;
    }).catch((error: unknown) => error);
  });
  const outcome = await operation.catch((error: unknown) => error);
  expect(first).toMatchObject({ code: "OPENCLAW_STATE_LEASE_LOST" });
  expect(parentFailure).toBe(first);
  expect(siblingFailure).toBe(first);
  expect(siblingEntered).toBe(false);
  expect(outcome).toBe(first);
});
