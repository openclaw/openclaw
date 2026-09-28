import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { isMainThread } from "node:worker_threads";
import { expect, it, vi } from "vitest";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import { createDeferredCore } from "../shared/deferred.js";
import * as stateReads from "../state/openclaw-state-db-readonly.js";
import { withExistingOpenClawStateSchema } from "../state/openclaw-state-db-schema-policy.js";
import {
  closeOpenClawStateDatabaseAsync,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import type { OpenClawStateReadReply } from "../state/openclaw-state-read.types.js";
import { observeMainThreadSql } from "../test-utils/main-thread-sql-spies.test-support.js";
import { useStateDatabaseTempDirs } from "../test-utils/state-database-temp-dirs.js";
import { configureNodeHost, loadNodeHostConfig, loadNodeHostConfigReadOnly } from "./config.js";

const tempDirs = useStateDatabaseTempDirs();
const readers = [loadNodeHostConfig, loadNodeHostConfigReadOnly];

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

async function withoutParentSql(operation: () => Promise<void>): Promise<number> {
  requireNodeSqlite();
  const sql = observeMainThreadSql();
  try {
    await operation();
    const count = sql.count();
    expect(count).toBe(0);
    return count;
  } finally {
    vi.restoreAllMocks();
  }
}

it.each(["cached", "fresh"] as const)(
  "loads %s node-host configuration without parent-thread SQL",
  async (mode) => {
    expect(isMainThread).toBe(true);
    const { env } = fixture();
    const expected = await seed(env);
    const source = openOpenClawStateDatabase({ env });
    if (mode === "fresh") {
      await closeOpenClawStateDatabaseAsync();
    }
    const startedAt = performance.now();
    const parentSqlCalls = await withoutParentSql(async () => {
      for (const read of readers) {
        expect(await read(env)).toEqual(expected);
      }
    });
    console.info("node-host configuration read", {
      mode,
      parentSqlCalls,
      elapsedMs: Math.round(performance.now() - startedAt),
    });
    expect(source.db.isOpen).toBe(mode === "cached");
  },
);

it.each(["fresh", "cached"] as const)(
  "loads %s managed node-host configuration without host SQL or schema repair",
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
      await withoutParentSql(async () => {
        for (const read of readers) {
          expect(await read(env)).toEqual(expected);
        }
      });
      const external = new DatabaseSync(databasePath);
      try {
        external.exec("DROP INDEX idx_plugin_state_listing");
      } finally {
        external.close();
      }
      await withoutParentSql(async () => {
        for (const read of readers) {
          await expect(read(env)).rejects.toThrow(/idx_plugin_state_listing|schema/i);
        }
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

it("leaves absent node-host configuration stores uncreated", async () => {
  const { env, databasePath } = fixture();
  for (const read of readers) {
    expect(await read(env)).toBeNull();
  }
  expect(fs.existsSync(databasePath)).toBe(false);
});

it("joins admitted node-host configuration reads before their disposable scope exits", async () => {
  const { env, databasePath } = fixture();
  const expected = await seed(env);
  const outcomes: unknown[] = [];
  await stateReads.withDisposableOpenClawStateReads(databasePath, async () => {
    for (const read of readers) {
      void read(env).then(
        (value) => outcomes.push(value),
        (error: unknown) => outcomes.push(error),
      );
    }
  });
  expect(outcomes).toEqual([expected, expected]);
});

it.each([
  { value_json: "{", updated_at_ms: 1, error: SyntaxError, message: /JSON/u },
  {
    value_json: '{"version":1,"nodeId":"fixture-node"}',
    updated_at_ms: -1,
    error: Error,
    message: /updated_at_ms must be a non-negative integer/u,
  },
  {
    value_json: '{"version":2,"nodeId":"fixture-node"}',
    updated_at_ms: 1,
    error: Error,
    message: /unsupported version 2/u,
  },
])("preserves node-host row decoding errors ($value_json, $updated_at_ms)", async (row) => {
  const { env } = fixture();
  vi.spyOn(stateReads, "executeExistingOpenClawStateRead").mockResolvedValue({
    ok: true,
    type: "nodeHost.config",
    sourceAdmitted: true,
    row: { value_json: row.value_json, updated_at_ms: row.updated_at_ms },
  });
  for (const read of readers) {
    const failure = await read(env).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(row.error);
    expect(failure).toMatchObject({ message: expect.stringMatching(row.message) });
  }
});

it("refuses retired node-host files before admitting a read", async () => {
  const { env, root } = fixture();
  fs.writeFileSync(path.join(root, "node.json"), "{}\n");
  const execute = vi.spyOn(stateReads, "executeExistingOpenClawStateRead");
  for (const read of readers) {
    await expect(read(env)).rejects.toThrow("openclaw doctor --fix");
  }
  expect(execute).not.toHaveBeenCalled();
});

it.each(
  readers.flatMap((read) =>
    [true, false].map((markerAtOriginal) => ({ read, name: read.name, markerAtOriginal })),
  ),
)(
  "retains the selected state root after $name waits (original marker=$markerAtOriginal)",
  async ({ read, markerAtOriginal }) => {
    const original = fixture();
    const other = fixture();
    const env = { ...original.env };
    const reply = createDeferredCore<OpenClawStateReadReply>();
    const execute = vi
      .spyOn(stateReads, "executeExistingOpenClawStateRead")
      .mockReturnValue(reply.promise);
    const result = read(env);
    env.OPENCLAW_STATE_DIR = other.root;
    fs.writeFileSync(path.join(markerAtOriginal ? original.root : other.root, "node.json"), "{}\n");
    reply.resolve({
      ok: true,
      type: "nodeHost.config",
      sourceAdmitted: true,
      row: {
        // The original-root legacy gate must run before decoding the returned row.
        value_json: markerAtOriginal ? "{" : '{"version":1,"nodeId":"original-node"}',
        updated_at_ms: 1,
      },
    });
    if (markerAtOriginal) {
      await expect(result).rejects.toThrow(
        `retired node-host state remains at ${path.join(original.root, "node.json")}`,
      );
    } else {
      await expect(result).resolves.toMatchObject({ nodeId: "original-node" });
    }
    expect(execute.mock.calls[0]?.[0].env?.OPENCLAW_STATE_DIR).toBe(original.root);
  },
);
