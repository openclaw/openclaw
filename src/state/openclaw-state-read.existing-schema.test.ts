import path from "node:path";
import { expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { listFleetCells, reserveFleetCell } from "../fleet/registry.js";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import { observeMainThreadSql } from "../test-utils/main-thread-sql-spies.test-support.js";
import { useStateDatabaseTempDirs } from "../test-utils/state-database-temp-dirs.js";
import { iterateOpenClawStateDatabaseReadOnly } from "./openclaw-state-db-read-connection.js";
import {
  withArtifactPreservingStateReads,
  withExistingOpenClawStateDatabaseReadOnly,
} from "./openclaw-state-db-readonly.js";
import { withExistingOpenClawStateSchema } from "./openclaw-state-db-schema-policy.js";
import { closeOpenClawStateDatabaseAsync, openOpenClawStateDatabase } from "./openclaw-state-db.js";

const tempDirs = useStateDatabaseTempDirs();

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
  requireNodeSqlite();
  const sql = observeMainThreadSql();
  try {
    await run();
    sql.expectIdle();
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
