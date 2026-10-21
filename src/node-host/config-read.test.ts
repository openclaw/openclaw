import fs from "node:fs";
import path from "node:path";
import { isMainThread } from "node:worker_threads";
import { expect, it, vi } from "vitest";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import * as stateReads from "../state/openclaw-state-db-readonly.js";
import { withExistingOpenClawStateSchema } from "../state/openclaw-state-db-schema-policy.js";
import {
  closeOpenClawStateDatabaseAsync,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { observeMainThreadSql } from "../test-utils/main-thread-sql-spies.test-support.js";
import { useStateDatabaseTempDirs } from "../test-utils/state-database-temp-dirs.js";
import { configureNodeHost, loadNodeHostConfig } from "./config.js";

const tempDirs = useStateDatabaseTempDirs();

function fixture() {
  const root = tempDirs.make("openclaw-node-host-config-reader-");
  return {
    root,
    env: { OPENCLAW_STATE_DIR: root },
    databasePath: path.join(root, "state", "openclaw.sqlite"),
  };
}

function seed(env: NodeJS.ProcessEnv) {
  return configureNodeHost({
    env,
    nodeId: "fixture-node",
    displayName: "Fixture Node",
    fallbackDisplayName: "fallback",
    gateway: { host: "gateway.example", port: 18443, tls: true, contextPath: "/gateway" },
    commands: ["fixture.read", "fixture.list"],
    installedAppsSharing: true,
    nowMs: 1234,
  });
}

async function withoutParentSql<T>(operation: () => Promise<T>): Promise<T> {
  requireNodeSqlite();
  const sql = observeMainThreadSql();
  try {
    const result = await operation();
    expect(sql.count()).toBe(0);
    return result;
  } finally {
    vi.restoreAllMocks();
  }
}

it.each(["cached", "fresh"] as const)("loads %s config without parent SQL", async (mode) => {
  expect(isMainThread).toBe(true);
  const { env } = fixture();
  const expected = await seed(env);
  const source = openOpenClawStateDatabase({ env });
  if (mode === "fresh") {
    await closeOpenClawStateDatabaseAsync();
  }
  expect(await withoutParentSql(() => loadNodeHostConfig(env))).toEqual(expected);
  expect(source.db.isOpen).toBe(mode === "cached");
});

it.each(["fresh", "cached"] as const)(
  "reads %s managed schema without repair/SQL",
  async (mode) => {
    const { env, databasePath } = fixture();
    const expected = await seed(env);
    openOpenClawStateDatabase({ env })
      .db.prepare("UPDATE schema_meta SET app_version = ? WHERE meta_key = 'primary'")
      .run("synthetic-installed-runtime");
    await closeOpenClawStateDatabaseAsync();
    const { DatabaseSync } = requireNodeSqlite();
    await withExistingOpenClawStateSchema({ path: databasePath }, async () => {
      if (mode === "cached") {
        openOpenClawStateDatabase({ env });
      }
      expect(await withoutParentSql(() => loadNodeHostConfig(env))).toEqual(expected);
      await closeOpenClawStateDatabaseAsync();
      fs.renameSync(databasePath, `${databasePath}.template`);
      fs.copyFileSync(`${databasePath}.template`, databasePath, fs.constants.COPYFILE_EXCL);
      const external = new DatabaseSync(databasePath);
      try {
        external.exec("DROP INDEX idx_plugin_state_listing");
      } finally {
        external.close();
      }
      await withoutParentSql(async () => {
        await expect(loadNodeHostConfig(env)).rejects.toThrow(/idx_plugin_state_listing|schema/i);
      });
    });
    await closeOpenClawStateDatabaseAsync();
    const persisted = new DatabaseSync(databasePath, { readOnly: true });
    try {
      expect(
        persisted.prepare("SELECT app_version FROM schema_meta WHERE meta_key = 'primary'").get(),
      ).toEqual({ app_version: "synthetic-installed-runtime" });
      expect(
        persisted
          .prepare("SELECT name FROM sqlite_schema WHERE name = 'idx_plugin_state_listing'")
          .get(),
      ).toBeUndefined();
    } finally {
      persisted.close();
    }
  },
);

it.each([false, true])("gates absent store reads on legacy=%s", async (legacy) => {
  const { env, root, databasePath } = fixture();
  const execute = vi.spyOn(stateReads, "executeExistingOpenClawStateRead");
  if (legacy) {
    fs.writeFileSync(path.join(root, "node.json"), "{}\n");
    await expect(loadNodeHostConfig(env)).rejects.toThrow("openclaw doctor --fix");
    expect(execute).not.toHaveBeenCalled();
  } else {
    expect(await loadNodeHostConfig(env)).toBeNull();
  }
  expect(fs.existsSync(databasePath)).toBe(false);
});

it("joins admitted node-host configuration reads before their disposable scope exits", async () => {
  const { env, databasePath } = fixture();
  const expected = await seed(env);
  const outcomes: unknown[] = [];
  await stateReads.withDisposableOpenClawStateReads(databasePath, async () => {
    void loadNodeHostConfig(env).then(
      (value) => outcomes.push(value),
      (error: unknown) => outcomes.push(error),
    );
  });
  expect(outcomes).toEqual([expected]);
});

const validRow = '{"version":1,"nodeId":"fixture-node"}';
it.each([
  ["{", 1, SyntaxError, /JSON/u],
  [validRow, -1, Error, /updated_at_ms must be a non-negative integer/u],
  ['{"version":2,"nodeId":"fixture-node"}', 1, Error, /unsupported version 2/u],
] as const)("preserves row errors (%s, %s)", async (json, time, kind, message) => {
  const { env } = fixture();
  vi.spyOn(stateReads, "executeExistingOpenClawStateRead").mockResolvedValue({
    ok: true,
    type: "nodeHost.config",
    sourceAdmitted: true,
    row: { value_json: json, updated_at_ms: time },
  });
  const failure = await loadNodeHostConfig(env).catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(kind);
  expect(failure).toMatchObject({ message: expect.stringMatching(message) });
});

it("configures without host SQL and refreshes previously read configuration", async () => {
  const { env } = fixture();
  const initial = await seed(env);
  expect(await loadNodeHostConfig(env)).toEqual(initial);
  await withoutParentSql(async () => {
    const update = {
      displayName: "Updated Node",
      gateway: { host: "new.gateway.example", port: 19443, tls: true },
      commands: ["fixture.updated"],
    };
    const configured = await configureNodeHost({
      ...update,
      env,
      fallbackDisplayName: "fallback",
      nowMs: 5678,
    });
    expect(configured).toMatchObject({
      ...update,
      nodeId: initial.nodeId,
      installedAppsSharing: true,
    });
    expect(await loadNodeHostConfig(env)).toEqual(configured);
  });
});
