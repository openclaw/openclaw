import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { listFleetCells, reserveFleetCell } from "../fleet/registry.js";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import {
  iterateOpenClawStateDatabaseReadOnly,
  withArtifactPreservingStateReads,
  withExistingOpenClawStateDatabaseReadOnly,
} from "./openclaw-state-db-readonly.js";
import { withExistingOpenClawStateSchema } from "./openclaw-state-db-schema-policy.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "./openclaw-state-db.js";

const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    vi.restoreAllMocks();
    await closeOpenClawStateDatabaseAsync();
    closeOpenClawStateDatabaseForTest();
    cleanup();
  }),
);

async function fixture() {
  const root = tempDirs.make("fixed-read-existing-schema-");
  const env = { OPENCLAW_STATE_DIR: root };
  const record = await reserveFleetCell(env, {
    tenantId: "alpha",
    createdAtMs: 1,
    image: "fixture:image",
    runtime: "docker",
    containerName: "fixture-alpha",
    dataDir: path.join(root, "alpha"),
  });
  const database = openOpenClawStateDatabase({ env });
  database.db
    .prepare("UPDATE schema_meta SET app_version = ? WHERE meta_key = 'primary'")
    .run("synthetic-installed-runtime");
  const options = { path: database.path, env };
  await closeOpenClawStateDatabaseAsync();
  return { env, options, record };
}

async function withoutHostSql(run: () => Promise<void>) {
  const { DatabaseSync, StatementSync } = requireNodeSqlite();
  const calls = [
    vi.spyOn(DatabaseSync.prototype, "prepare"),
    vi.spyOn(DatabaseSync.prototype, "exec"),
    ...(["get", "all", "run", "iterate"] as const).map((method) =>
      vi.spyOn(StatementSync.prototype, method),
    ),
  ];
  try {
    await run();
    expect(calls.reduce((total, call) => total + call.mock.calls.length, 0)).toBe(0);
  } finally {
    vi.restoreAllMocks();
  }
}

it.each(["fresh", "cached", "artifact"] as const)(
  "validates existing runtime shape on %s fixed reads without host SQL or schema repair",
  async (mode) => {
    const { env, options, record } = await fixture();
    const read = () =>
      mode === "artifact"
        ? withArtifactPreservingStateReads(() => listFleetCells(env))
        : listFleetCells(env);
    await withExistingOpenClawStateSchema(options, async () => {
      if (mode === "cached") {
        openOpenClawStateDatabase(options);
      }
      await withoutHostSql(async () => {
        expect(await read()).toEqual([record]);
      });
      const { DatabaseSync } = requireNodeSqlite();
      const external = new DatabaseSync(options.path);
      try {
        external.exec("DROP INDEX idx_plugin_state_listing");
      } finally {
        external.close();
      }
      await withoutHostSql(async () => {
        await expect(read()).rejects.toThrow(/idx_plugin_state_listing|schema/i);
      });
    });
    await closeOpenClawStateDatabaseAsync();
    const { DatabaseSync } = requireNodeSqlite();
    const persisted = new DatabaseSync(options.path, { readOnly: true });
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

it("refuses fixed-read custody of a restricted cached handle outside its scope", async () => {
  const { env, options, record } = await fixture();
  const database = withExistingOpenClawStateSchema(options, () =>
    openOpenClawStateDatabase(options),
  );
  await withoutHostSql(async () => {
    await expect(listFleetCells(env)).rejects.toThrow(/without schema repair/i);
  });
  expect(database.db.isOpen).toBe(true);
  await closeOpenClawStateDatabaseAsync();
  await withoutHostSql(async () => {
    expect(await listFleetCells(env)).toEqual([record]);
  });
});

it("rejects detached fixed reads after their existing-schema scope ends", async () => {
  const { env, options } = await fixture();
  const gate = createDeferred();
  const { pending } = await withExistingOpenClawStateSchema(options, async () => ({
    pending: gate.promise.then(() => listFleetCells(env)),
  }));
  await withoutHostSql(async () => {
    const rejected = expect(pending).rejects.toThrow(/schema admission has ended/i);
    gate.resolve();
    await rejected;
  });
});

it.each(["fresh", "streaming"] as const)(
  "validates existing runtime shape before a %s native read callback",
  async (mode) => {
    const { env, options } = await fixture();
    await withExistingOpenClawStateSchema(options, async () => {
      const source = mode === "streaming" ? openOpenClawStateDatabase(options) : undefined;
      const { DatabaseSync } = requireNodeSqlite();
      const external = new DatabaseSync(options.path);
      try {
        external.exec("DROP INDEX idx_plugin_state_listing");
      } finally {
        external.close();
      }
      const read = vi.fn(() => "must not run");
      if (source) {
        const rows = iterateOpenClawStateDatabaseReadOnly(
          source,
          function* () {
            yield read();
          },
          env,
        );
        await expect(rows.next()).rejects.toThrow(/idx_plugin_state_listing|schema/i);
      } else {
        expect(() => withExistingOpenClawStateDatabaseReadOnly(read, options)).toThrow(
          /idx_plugin_state_listing|schema/i,
        );
      }
      expect(read).not.toHaveBeenCalled();
    });
  },
);
