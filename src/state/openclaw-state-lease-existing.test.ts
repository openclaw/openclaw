import { AsyncResource } from "node:async_hooks";
import fs from "node:fs";
import path from "node:path";
import { setImmediate } from "node:timers/promises";
import { afterEach, expect, it as baseIt, vi } from "vitest";
import { captureThrown } from "../../test/helpers/capture-thrown.js";
import { createDeferred, withTestTimeout } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import { withPluginLifecycleLease } from "../plugins/plugin-lifecycle-lease.js";
import { holdStateDatabaseWriteTransaction } from "../test-utils/state-database-contention.js";
import {
  AGENT_DATABASE_MAINTENANCE_LEASE,
  assertNoOpenClawAgentDatabaseLeases,
} from "./openclaw-agent-db-lease.js";
import { withAgentDatabaseMaintenanceLease as maintain } from "./openclaw-agent-db-maintenance-lease.js";
import {
  closeOpenClawAgentDatabasesAsync,
  openOpenClawAgentDatabase,
} from "./openclaw-agent-db.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "./openclaw-state-db-contract.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "./openclaw-state-db.js";
import {
  withOpenClawStateLease as withLease,
  type OpenClawStateLeaseContext,
} from "./openclaw-state-lease.js";
import {
  addPreCutoverClientCredentialTablesForTest,
  withStateMigrationBackupForTest,
} from "./openclaw-state-schema.test-support.js";

const dirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    await closeOpenClawAgentDatabasesAsync();
    closeOpenClawStateDatabaseForTest();
    cleanup();
  }),
);
function leaseOptions(options: { env: NodeJS.ProcessEnv } | { path: string }) {
  return {
    scope: "core:test-premigration",
    key: "global",
    database: { scope: "shared" as const, options, schemaPolicy: "existing" as const },
    leaseMs: 30_000,
    waitMs: 0,
  };
}
function source(holdAgent = false, provenance = true) {
  const root = dirs.make("state-lease-before-migration-");
  const env = { HOME: root, OPENCLAW_STATE_DIR: root };
  const pathname = openOpenClawStateDatabase({ env }).path;
  const agent = holdAgent ? openOpenClawAgentDatabase({ agentId: "worker", env }) : undefined;
  closeOpenClawStateDatabaseForTest();
  using db = openNodeSqliteDatabase(pathname);
  addPreCutoverClientCredentialTablesForTest(db);
  db.exec(`PRAGMA foreign_keys=OFF;
      PRAGMA user_version=15;
      UPDATE schema_meta SET schema_version=15 WHERE meta_key='primary';`);
  if (!provenance) {
    db.exec("ALTER TABLE agent_database_leases DROP COLUMN provenance");
  }
  const options = { env, schemaPolicy: "existing" as const };
  return { pathname, options, lease: leaseOptions({ env }), agent };
}
const it = baseIt.extend<{ f: ReturnType<typeof source> }>({
  f: async ({ task: _task }, use) => use(source()),
});
function mutate(pathname: string, sql: string, ...values: string[]) {
  using db = openNodeSqliteDatabase(pathname);
  return db.prepare(sql).run(...values).changes;
}
function inspect(pathname: string) {
  using db = openNodeSqliteDatabase(pathname, { readOnly: true });
  return {
    version: db.prepare("PRAGMA user_version").get(),
    schema: db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name").all(),
    metadata: db.prepare("SELECT * FROM schema_meta ORDER BY meta_key").all(),
    leases: db.prepare("SELECT * FROM state_leases").all(),
  };
}
function thrown(operation: () => void) {
  return captureThrown(operation, "Expected ownership assertion to fail");
}
it("acquires, verifies, renews and releases a timer lease without migrating", async ({ f }) => {
  const before = inspect(f.pathname);
  const entered = await withLease(f.lease, async (lease) => {
    lease.assertOwned();
    lease.renew?.();
    return inspect(f.pathname);
  });
  expect(entered).toEqual({ ...before, leases: [expect.anything()] });
  expect(inspect(f.pathname)).toEqual(before);
});
it.each([false])(
  "takes plugin and agent writer ownership before candidate migration (provenance=%s)",
  async (provenance) => {
    const f = source(false, provenance);
    const before = inspect(f.pathname);
    const atEntry = await withPluginLifecycleLease(f.options, () =>
      maintain(f.options, async (maintenance) => {
        maintenance.assertOwned();
        return inspect(f.pathname);
      }),
    );
    expect(atEntry.version).toEqual({ user_version: 15 });
    expect(atEntry.schema).toEqual(before.schema);
    expect(atEntry.leases).toHaveLength(2);
    expect(inspect(f.pathname)).toEqual(before);
  },
);
it("refuses a competing owner and preserves a replacement lease on cleanup", async ({ f }) => {
  const outside = new AsyncResource("premigration-competing-owner");
  const competing = vi.fn(async () => {});
  try {
    await expect(
      withLease(f.lease, async (held) => {
        await expect(
          outside.runInAsyncScope(() => withLease(f.lease, competing)),
        ).rejects.toMatchObject({ code: "OPENCLAW_STATE_LEASE_HELD", outcome: { kind: "held" } });
        mutate(
          f.pathname,
          "UPDATE state_leases SET owner='replacement' WHERE scope=?",
          f.lease.scope,
        );
        held.assertOwned();
      }),
    ).rejects.toThrow(/lost/);
  } finally {
    outside.emitDestroy();
  }
  expect(competing).not.toHaveBeenCalled();
  expect(inspect(f.pathname)).toMatchObject({
    version: { user_version: 15 },
    leases: [{ owner: "replacement" }],
  });
});
it("does not create missing existing-only lease state", async () => {
  const pathname = path.join(dirs.make("state-lease-missing-"), "missing.sqlite");
  await expect(withLease(leaseOptions({ path: pathname }), async () => {})).rejects.toThrow();
  expect(fs.existsSync(pathname)).toBe(false);
});
it("keeps the maintenance lease live across an explicitly owned migration", async ({ f }) => {
  await withLease(f.lease, async (lease) => {
    expect(inspect(f.pathname).version).toEqual({ user_version: 15 });
    lease.assertOwned();
    await withStateMigrationBackupForTest(f.options, () => {
      openOpenClawStateDatabase(f.options);
      lease.assertOwned();
    });
    lease.assertOwned();
  });
  expect(inspect(f.pathname)).toMatchObject({
    version: { user_version: OPENCLAW_STATE_SCHEMA_VERSION },
    leases: [],
  });
});

it("waits through write contention before existing-schema maintenance", async ({ f }) => {
  await withLease(
    { ...f.lease, ...AGENT_DATABASE_MAINTENANCE_LEASE, heartbeat: "worker" },
    async (maintenance) => {
      const holder = holdStateDatabaseWriteTransaction(f.pathname, 250);
      try {
        await holder.ready;
        assertNoOpenClawAgentDatabaseLeases(maintenance, f.options);
      } finally {
        holder.release();
        await holder.joined;
      }
    },
  );
  expect(inspect(f.pathname).leases).toEqual([]);
});

it("drains cached agent handles from another profile using their own lease database", async () => {
  const target = source(true);
  const otherRoot = dirs.make("state-lease-other-profile-");
  const otherEnv = { HOME: otherRoot, OPENCLAW_STATE_DIR: otherRoot };
  const otherState = openOpenClawStateDatabase({ env: otherEnv }).path;
  const otherAgent = openOpenClawAgentDatabase({ agentId: "other", env: otherEnv });
  const otherBefore = inspect(otherState);
  let entered = false;
  await maintain(target.options, async (lease) => {
    lease.assertOwned();
    entered = true;
    expect([target.agent?.db.isOpen, otherAgent.db.isOpen]).toEqual([false, false]);
    expect(inspect(target.pathname).version).toEqual({ user_version: 15 });
  });
  expect(entered).toBe(true);
  expect(inspect(target.pathname).version).toEqual({ user_version: 15 });
  expect(inspect(otherState)).toEqual(otherBefore);
  using otherDb = openNodeSqliteDatabase(otherState, { readOnly: true });
  expect(otherDb.prepare("SELECT lease_id FROM agent_database_leases").all()).toEqual([]);
});

it("does not recreate state displaced before heartbeat startup", async ({ f }) => {
  const displaced = `${f.pathname}.displaced`;
  const entered = vi.fn(async () => {});
  const onWorker = vi.fn(() => fs.renameSync(f.pathname, displaced));
  process.once("worker", onWorker);
  try {
    await expect(withLease({ ...f.lease, heartbeat: "worker" }, entered)).rejects.toThrow();
  } finally {
    process.removeListener("worker", onWorker);
  }
  expect(onWorker).toHaveBeenCalledOnce();
  expect(entered).not.toHaveBeenCalled();
  expect([fs.existsSync(displaced), fs.existsSync(f.pathname)]).toEqual([true, false]);
});

it("reenters maintenance without acquiring or migrating state", async ({ f }) => {
  const before = inspect(f.pathname);
  const nested = await maintain(f.options, async (outer) => {
    const child = await maintain(f.options, async (inner) => {
      inner.assertOwned();
      outer.assertOwned();
      return { lease: inner, state: inspect(f.pathname) };
    });
    expect(() => child.lease.assertOwned()).toThrow(/closed/);
    outer.assertOwned();
    return child.state;
  });
  expect(nested).toMatchObject({ leases: [expect.anything()], version: before.version });
  expect(inspect(f.pathname)).toEqual(before);
});

it("refuses nested maintenance redirection before creating another database", async ({ f }) => {
  const other = dirs.make("maintenance-other-root-");
  const entered = vi.fn(async () => {});
  await maintain(f.options, async (outer) => {
    await expect(
      maintain({ env: { HOME: other, OPENCLAW_STATE_DIR: other } }, entered),
    ).rejects.toThrow(/switch/);
    outer.assertOwned();
  });
  expect(entered).not.toHaveBeenCalled();
  expect(fs.readdirSync(other)).toEqual([]);
});

it("joins nested maintenance work before releasing the actual durable lease", async ({ f }) => {
  const entered = createDeferred<OpenClawStateLeaseContext>();
  const release = createDeferred();
  const outside = new AsyncResource("outside-maintenance-root");
  const settled = vi.fn();
  const run = maintain(f.options, async (owner) => {
    void maintain(f.options, async (inner) => {
      entered.resolve(owner);
      await release.promise;
      inner.assertOwned();
      inner.renew?.();
    });
  }).finally(settled);
  void run.catch(() => undefined);
  try {
    const outer = await withTestTimeout(entered.promise, 10_000, "maintenance child entry");
    expect(settled).not.toHaveBeenCalled();
    // Drain admitted children without allowing new work through the escaped parent.
    await setImmediate();
    expect(() => outer.renew?.()).toThrow(/closed/);
    await expect(
      outside.runInAsyncScope(() =>
        withLease({ ...f.lease, ...AGENT_DATABASE_MAINTENANCE_LEASE }, async () => {
          throw new Error("competitor was admitted");
        }),
      ),
    ).rejects.toMatchObject({ code: "OPENCLAW_STATE_LEASE_HELD", outcome: { kind: "held" } });
  } finally {
    release.resolve();
    await run;
    outside.emitDestroy();
  }
  expect(settled).toHaveBeenCalledOnce();
  expect(inspect(f.pathname).leases).toEqual([]);
});

it("reports a failed detached maintenance child before releasing its real owner", async ({ f }) => {
  const failure = new Error("detached migration failed");
  await expect(
    maintain(f.options, async () => {
      void maintain(f.options, async () => {
        await Promise.resolve();
        throw failure;
      });
    }),
  ).rejects.toBe(failure);
  expect(inspect(f.pathname).leases).toEqual([]);
});

it("shares a child-first lease loss with its parent and sibling scopes", async ({ f }) => {
  let first: unknown;
  const sibling = vi.fn(async () => {});
  const operation = maintain(f.options, async (parent) => {
    await maintain(f.options, async (child) => {
      expect(
        mutate(
          f.pathname,
          "DELETE FROM state_leases WHERE scope = ? AND lease_key = ?",
          AGENT_DATABASE_MAINTENANCE_LEASE.scope,
          AGENT_DATABASE_MAINTENANCE_LEASE.key,
        ),
      ).toBe(1);
      first = thrown(() => child.assertOwned());
    }).catch(() => undefined);
    expect(thrown(() => parent.assertOwned())).toBe(first);
    expect(thrown(() => parent.assertOwned())).toBe(first);
    await expect(maintain(f.options, sibling)).rejects.toBe(first);
  });
  const outcome = await operation.catch((error: unknown) => error);
  expect(outcome).toBe(first);
  expect(first).toMatchObject({ code: "OPENCLAW_STATE_LEASE_LOST" });
  expect(sibling).not.toHaveBeenCalled();
});
