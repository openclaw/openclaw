import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { isMainThread } from "node:worker_threads";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import { createOpenClawDatabaseMaintenanceScope } from "../state/openclaw-state-db-async-lifecycle.js";
import { withDisposableOpenClawStateReads } from "../state/openclaw-state-db-readonly.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import {
  deleteFleetCell,
  getFleetCell,
  listFleetCells,
  reserveFleetCell,
  updateFleetCellImage,
} from "./registry.js";
import { withFleetCellOperation } from "./service-support.runtime.js";

const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    vi.restoreAllMocks();
    await closeOpenClawStateDatabaseAsync();
    closeOpenClawStateDatabaseForTest();
    cleanup();
  }),
);

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
  const { DatabaseSync, StatementSync } = requireNodeSqlite();
  return [
    vi.spyOn(DatabaseSync.prototype, "prepare"),
    vi.spyOn(DatabaseSync.prototype, "exec"),
    ...(["get", "all", "run", "iterate"] as const).map((method) =>
      vi.spyOn(StatementSync.prototype, method),
    ),
  ];
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
      const mainThreadSqlCalls = calls.reduce((total, call) => total + call.mock.calls.length, 0);
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
    const mainThreadSqlCalls = calls.reduce((total, call) => total + call.mock.calls.length, 0);
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
      expect(calls.reduce((total, call) => total + call.mock.calls.length, 0)).toBe(0);
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
