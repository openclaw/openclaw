import assert from "node:assert/strict";
import { copyFileSync, renameSync } from "node:fs";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { buildAcpDatabaseSessionKey } from "../acp/runtime/session-meta-keys.js";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import { observeMainThreadSql } from "../test-utils/main-thread-sql-spies.test-support.js";
import { useStateDatabaseTempDirs } from "../test-utils/state-database-temp-dirs.js";
import * as reads from "./openclaw-state-db-readonly.js";
import { withExistingOpenClawStateSchema } from "./openclaw-state-db-schema-policy.js";
import * as state from "./openclaw-state-db.js";
import { createSessionRepositoryWorkspaceInDatabase } from "./session-repository-workspaces.kernel.js";

const tempDirs = useStateDatabaseTempDirs();

async function fixture() {
  const root = tempDirs.make("fixed-read-existing-schema-");
  const env = { OPENCLAW_STATE_DIR: root };
  const record = {
    id: "alpha",
    createdAt: 1,
    archivePath: path.join(root, "backup.tar.gz"),
    status: "ok",
    kind: "archive",
  } as const;
  const database = state.openOpenClawStateDatabase({ env });
  database.db
    .prepare(`INSERT INTO backup_runs
    (id, created_at, archive_path, status, manifest_json)
    VALUES ('alpha', 1, ?, 'ok', '{"kind":"archive"}')`)
    .run(record.archivePath);
  database.db
    .prepare("UPDATE schema_meta SET app_version = ? WHERE meta_key = 'primary'")
    .run("synthetic-installed-runtime");
  const options = { path: database.path, env };
  await state.closeOpenClawStateDatabaseAsync();
  replaceFile(options.path, "seed");
  return {
    options,
    record,
    read: async () => reads.executeExistingOpenClawStateRead({ env }, { type: "backup.runs" }),
  };
}

function backupReply(record: Awaited<ReturnType<typeof fixture>>["record"]) {
  return { ok: true, type: "backup.runs", sourceAdmitted: true, runs: [record] };
}

function dropListingIndex(file: string) {
  using db = new (requireNodeSqlite().DatabaseSync)(file);
  db.exec("DROP INDEX idx_plugin_state_listing");
}
function replaceFile(file: string, suffix: string) {
  renameSync(file, `${file}.${suffix}`);
  copyFileSync(`${file}.${suffix}`, file);
}
async function withoutHostSql<T>(run: () => Promise<T>) {
  requireNodeSqlite();
  const sql = observeMainThreadSql();
  using cleanup = new DisposableStack();
  cleanup.defer(() => vi.restoreAllMocks());
  cleanup.defer(() => sql.expectIdle());
  return await run();
}

it("prepares ACP and workspace facets together and observes foreign changes at each new phase", async () => {
  const root = tempDirs.make("row-shared-facts-");
  const env = { OPENCLAW_STATE_DIR: root };
  const database = state.openOpenClawStateDatabase({ env });
  const owner = { agentId: "main", sessionKey: "agent:main:shared-facts" };
  const workspace = createSessionRepositoryWorkspaceInDatabase(
    database.db,
    {
      ...owner,
      url: "https://example.test/fixture.git",
      runSetupScript: false,
    },
    1,
  ).workspace!;
  const command = {
    type: "sessionRows.sharedFacts" as const,
    entries: [
      {
        acp: {
          keys: [buildAcpDatabaseSessionKey(owner.sessionKey, owner.agentId)],
          entry: { sessionId: "original", lifecycleRevision: "generation" },
        },
        repositoryWorkspace: { ...owner, workspaceId: workspace.workspaceId },
      },
    ],
  };
  const read = async () => {
    const result = await withoutHostSql(() =>
      reads.executeExistingOpenClawStateRead({ env, path: database.path }, command),
    );
    assert(result?.ok && result.type === command.type, "Expected the row shared-state cohort");
    return result.rows;
  };
  expect(await read()).toEqual([{ acp: null, repositoryWorkspace: workspace }]);
  using foreign = new (requireNodeSqlite().DatabaseSync)(database.path);
  foreign
    .prepare(`INSERT INTO acp_sessions
      (session_key, session_id, backend, agent, runtime_session_name, mode, state, last_activity_at, updated_at)
      VALUES (?, 'generation', 'fixture', 'main', 'foreign', 'persistent', 'idle', 2, 2)`)
    .run(command.entries[0]!.acp.keys[0]!);
  foreign.prepare("UPDATE session_repository_workspaces SET branch = 'foreign'").run();
  expect(await read()).toEqual([
    {
      acp: expect.objectContaining({ runtime_session_name: "foreign" }),
      repositoryWorkspace: { ...workspace, branch: "foreign" },
    },
  ]);
  foreign.prepare("DELETE FROM acp_sessions").run();
  foreign.prepare("DELETE FROM session_repository_workspaces").run();
  expect(await read()).toEqual([{ acp: null, repositoryWorkspace: null }]);
});

it.each(["fresh", "cached", "artifact"] as const)(
  "validates replacement runtime shape on %s fixed reads without host SQL or schema repair",
  async (mode) => {
    const { options, record, read: readRows } = await fixture();
    const read = () =>
      withoutHostSql(() =>
        mode === "artifact" ? reads.withArtifactPreservingStateReads(readRows) : readRows(),
      );
    await withExistingOpenClawStateSchema(options, async () => {
      if (mode === "cached") {
        state.openOpenClawStateDatabase(options);
      }
      expect(await read()).toEqual(backupReply(record));
      await state.closeOpenClawStateDatabaseAsync();
      replaceFile(options.path, "previous");
      dropListingIndex(options.path);
      await expect(read()).rejects.toThrow(/idx_plugin_state_listing|schema/i);
    });
    await state.closeOpenClawStateDatabaseAsync();
    using persisted = new (requireNodeSqlite().DatabaseSync)(options.path, { readOnly: true });
    expect(
      persisted
        .prepare(`SELECT app_version,
        (SELECT name FROM sqlite_schema WHERE name = 'idx_plugin_state_listing') AS listing_index
        FROM schema_meta WHERE meta_key = 'primary'`)
        .get(),
    ).toEqual({ app_version: "synthetic-installed-runtime", listing_index: null });
  },
);

it("refuses fixed-read custody of a restricted cached handle outside its scope", async () => {
  const { options, record, read } = await fixture();
  const database = withExistingOpenClawStateSchema(options, () =>
    state.openOpenClawStateDatabase(options),
  );
  await withoutHostSql(async () => {
    await expect(read()).rejects.toThrow(/without schema repair/i);
  });
  expect(database.db.isOpen).toBe(true);
  await state.closeOpenClawStateDatabaseAsync();
  await withoutHostSql(async () => {
    expect(await read()).toEqual(backupReply(record));
  });
});

it("rejects detached fixed reads after their existing-schema scope ends", async () => {
  const { options, read } = await fixture();
  const gate = createDeferred();
  const { pending } = await withExistingOpenClawStateSchema(options, async () => ({
    pending: gate.promise.then(read),
  }));
  await withoutHostSql(async () => {
    const rejected = expect(pending).rejects.toThrow(/schema admission has ended/i);
    gate.resolve();
    await rejected;
  });
});

it("validates existing runtime shape before a fresh native read callback", async () => {
  const { options } = await fixture();
  await withExistingOpenClawStateSchema(options, async () => {
    dropListingIndex(options.path);
    const read = vi.fn(() => "must not run");
    expect(() => reads.withExistingOpenClawStateDatabaseReadOnly(read, options)).toThrow(
      /idx_plugin_state_listing|schema/i,
    );
    expect(read).not.toHaveBeenCalled();
  });
});
