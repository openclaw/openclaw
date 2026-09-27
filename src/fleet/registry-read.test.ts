import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { isMainThread } from "node:worker_threads";
import { expect, it, vi } from "vitest";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import { createOpenClawDatabaseMaintenanceScope } from "../state/openclaw-state-db-async-lifecycle.js";
import {
  withArtifactPreservingStateReads,
  withDisposableOpenClawStateReads,
} from "../state/openclaw-state-db-readonly.js";
import {
  closeOpenClawStateDatabaseAsync,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { observeMainThreadSql } from "../test-utils/main-thread-sql-spies.test-support.js";
import { useStateDatabaseTempDirs } from "../test-utils/state-database-temp-dirs.js";
import {
  deleteFleetCell,
  getFleetCell,
  listFleetCells,
  reserveFleetCell,
  updateFleetCellImage,
} from "./registry.js";
import { withFleetCellOperation } from "./service-support.runtime.js";

const tempDirs = useStateDatabaseTempDirs();

function fixture() {
  const root = tempDirs.make("openclaw-fleet-reader-");
  return {
    root,
    env: { OPENCLAW_STATE_DIR: root },
    databasePath: path.join(root, "state", "openclaw.sqlite"),
  };
}

function seed(env: NodeJS.ProcessEnv, root: string) {
  return reserveFleetCell(env, {
    tenantId: "alpha",
    createdAtMs: 1,
    image: "fixture:image",
    runtime: "docker",
    containerName: "fixture-alpha",
    dataDir: path.join(root, "alpha"),
  });
}

function watchNativeSql() {
  requireNodeSqlite();
  return observeMainThreadSql();
}

it.each(["cached", "fresh"] as const)(
  "reads a %s registry in the worker and preserves the cached writer",
  async (mode) => {
    expect(isMainThread).toBe(true);
    const { root, env } = fixture();
    const record = await seed(env, root);
    const source = openOpenClawStateDatabase({ env });
    if (mode === "fresh") {
      await closeOpenClawStateDatabaseAsync();
    }
    const calls = watchNativeSql();
    const startedAt = performance.now();
    try {
      expect(await listFleetCells(env)).toEqual([record]);
      expect(await getFleetCell(env, record.tenantId)).toEqual(record);
      const mainThreadSqlCalls = calls.count();
      console.info("fleet registry read", {
        mode,
        mainThreadSqlCalls,
        elapsedMs: Math.round(performance.now() - startedAt),
      });
      expect(mainThreadSqlCalls).toBe(0);
      expect(source.db.isOpen).toBe(mode === "cached");
    } finally {
      vi.restoreAllMocks();
    }
  },
);

it("prepares and retires an artifact registry snapshot without main-thread SQL", async () => {
  const { root, env, databasePath } = fixture();
  const record = await seed(env, root);
  await closeOpenClawStateDatabaseAsync();
  const sourceBytes = fs.readFileSync(databasePath);
  const calls = watchNativeSql();
  const startedAt = performance.now();
  const read = async () => {
    expect(await listFleetCells(env)).toEqual([record]);
    expect(await getFleetCell(env, record.tenantId)).toEqual(record);
  };
  try {
    await withArtifactPreservingStateReads(read);
    const mainThreadSqlCalls = calls.count();
    console.info("fleet snapshot lifecycle", {
      mode: "artifact",
      mainThreadSqlCalls,
      elapsedMs: Math.round(performance.now() - startedAt),
    });
    expect(mainThreadSqlCalls).toBe(0);
  } finally {
    vi.restoreAllMocks();
  }
  expect(fs.readFileSync(databasePath)).toEqual(sourceBytes);
});

it("reads current committed registry rows while a cached native iterator retains older rows", async () => {
  expect(isMainThread).toBe(true);
  const { root, env } = fixture();
  const alpha = await seed(env, root);
  const beta = await reserveFleetCell(env, {
    tenantId: "beta",
    createdAtMs: 2,
    image: "fixture:original",
    runtime: "docker",
    containerName: "fixture-beta",
    dataDir: path.join(root, "beta"),
  });
  const source = openOpenClawStateDatabase({ env });
  // sqlite-allow-raw -- Exercise SQLite's implicit cursor snapshot outside explicit transactions.
  const cursor = source.db
    .prepare("SELECT tenant_id, image FROM fleet_cells ORDER BY tenant_id")
    .iterate();
  try {
    expect(cursor.next()).toMatchObject({
      done: false,
      value: { tenant_id: alpha.tenantId, image: alpha.image },
    });
    expect(source.db.isTransaction).toBe(false);
    await updateFleetCellImage(env, beta.tenantId, "fixture:committed");
    expect(source.db.isTransaction).toBe(false);
    // sqlite-allow-raw -- Verify this exact native handle still owns the earlier read view.
    expect(
      source.db.prepare("SELECT image FROM fleet_cells WHERE tenant_id = ?").get(beta.tenantId),
    ).toEqual({ image: beta.image });
    const calls = watchNativeSql();
    try {
      const committed = { ...beta, image: "fixture:committed" };
      expect(await listFleetCells(env)).toEqual([alpha, committed]);
      expect(await getFleetCell(env, beta.tenantId)).toEqual(committed);
      calls.expectIdle();
      expect(source.db.isOpen).toBe(true);
      expect(source.db.isTransaction).toBe(false);
    } finally {
      vi.restoreAllMocks();
    }
    expect(cursor.next()).toMatchObject({
      done: false,
      value: { tenant_id: beta.tenantId, image: beta.image },
    });
  } finally {
    cursor.return?.();
  }
  expect(source.db.isOpen).toBe(true);
});

it("commits a complete leased registry operation off the main thread and reopens its result", async () => {
  expect(isMainThread).toBe(true);
  const { root, env } = fixture();
  const calls = watchNativeSql();
  const startedAt = performance.now();
  try {
    await withFleetCellOperation({
      env,
      tenantId: "alpha",
      operationName: "create",
      operation: async (checkpoint) => {
        await checkpoint();
        await seed(env, root);
        await updateFleetCellImage(env, "alpha", "fixture:updated");
        await deleteFleetCell(env, "alpha");
        await seed(env, root);
        await updateFleetCellImage(env, "alpha", "fixture:committed");
      },
    });
    const mainThreadSqlCalls = calls.count();
    console.info("fleet registry operation", {
      mainThreadSqlCalls,
      elapsedMs: Math.round(performance.now() - startedAt),
    });
    expect(mainThreadSqlCalls).toBe(0);
  } finally {
    vi.restoreAllMocks();
  }
  await closeOpenClawStateDatabaseAsync();
  expect(await getFleetCell(env, "alpha")).toMatchObject({
    tenantId: "alpha",
    image: "fixture:committed",
    hostPort: 19_100,
  });
});

it("keeps absent registry reads noncreating", async () => {
  const { env, databasePath } = fixture();
  expect(await listFleetCells(env)).toEqual([]);
  expect(await getFleetCell(env, "missing")).toBeUndefined();
  expect(fs.existsSync(databasePath)).toBe(false);
});

it("joins an admitted read before its disposable source scope exits", async () => {
  const { root, env, databasePath } = fixture();
  const record = await seed(env, root);
  let outcome: unknown;
  await withDisposableOpenClawStateReads(databasePath, async () => {
    void getFleetCell(env, record.tenantId).then(
      (reply) => {
        outcome = reply;
      },
      (error: unknown) => {
        outcome = error;
      },
    );
  });
  expect(outcome).toEqual(record);
});

it("preserves a maintenance-created cached writer after an independent admitted registry read", async () => {
  const { root, env } = fixture();
  const record = await seed(env, root);
  const maintenance = createOpenClawDatabaseMaintenanceScope(() => undefined);
  const source = maintenance.run(() => openOpenClawStateDatabase({ env }));
  try {
    const calls = watchNativeSql();
    try {
      expect(await getFleetCell(env, record.tenantId)).toEqual(record);
      calls.expectIdle();
    } finally {
      vi.restoreAllMocks();
    }
    await maintenance.close();
    expect(source.db.isOpen).toBe(true);
    expect(await listFleetCells(env)).toEqual([record]);
  } finally {
    await maintenance.close();
  }
});
