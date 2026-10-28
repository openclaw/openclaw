import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveSchemaMigrationBackupTables } from "../../state/schema-migration-backup-scope.js";
import { openNodeSqliteDatabase } from "../node-sqlite.js";
import { admitDatabasePortDescriptor } from "./port-descriptor.js";
import { loadStatePortDescriptor } from "./state-port-descriptor.js";
import { resolveStatePortRoots, statePortProvider } from "./state-port.js";

const stateDir = path.resolve("/synthetic/selected");
const home = path.resolve("/synthetic/home");
const env = {
  ...process.env,
  HOME: home,
  OPENCLAW_STATE_DIR: "/unselected",
  OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
};
const rows = (db: DatabaseSync, sql: string) => db.prepare(sql).all();
const backupTables = (foundVersion: number, supportedVersion: number) =>
  resolveSchemaMigrationBackupTables({ kind: "state", foundVersion, supportedVersion });
const legacyWorkspaceSchema = `CREATE TABLE local_workspace_projections (
  worktree_id TEXT NOT NULL PRIMARY KEY,
  agent_id TEXT NOT NULL,
  session_key TEXT NOT NULL,
  session_id TEXT NOT NULL,
  lifecycle_revision TEXT,
  projection_path TEXT NOT NULL UNIQUE,
  base_commit TEXT NOT NULL,
  source_paths_json TEXT NOT NULL,
  baseline_json TEXT,
  baseline_ref TEXT,
  pending_ref TEXT,
  pending_target TEXT CHECK (pending_target IN ('canonical', 'projection')),
  paused_runtimes_json TEXT,
  journal_json TEXT,
  journal_pack BLOB CHECK (journal_pack IS NULL OR length(journal_pack) <= 268435456),
  revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
  created_at_ms INTEGER NOT NULL,
  CHECK ((baseline_json IS NULL) = (baseline_ref IS NULL)),
  CHECK ((journal_json IS NULL) = (journal_pack IS NULL))
) STRICT;`;

it.each<{
  label: string;
  config: OpenClawConfig;
  roots: string[];
}>([
  { label: "selected and retained default", config: {}, roots: [] },
  {
    label: "disabled custom store",
    config: {
      plugins: { entries: { "voice-call": { enabled: false, config: { store: "~/calls" } } } },
    },
    roots: [path.join(home, "calls")],
  },
  {
    label: "both configured package aliases",
    config: {
      plugins: {
        enabled: false,
        entries: {
          "voice-call": { config: { store: path.join(home, "first") } },
          "@openclaw/voice-call": { config: { store: path.join(home, "second") } },
        },
      },
    },
    roots: [path.join(home, "first"), path.join(home, "second")],
  },
  {
    label: "duplicate custom store and excluded Matrix account roots",
    config: {
      plugins: {
        entries: {
          "voice-call": { config: { store: path.join(stateDir, "voice-calls") } },
        },
      },
      channels: {
        matrix: {
          homeserver: "https://matrix.example.test",
          accounts: {
            main: { userId: "@main:example.test" },
            retained: { enabled: false, userId: "@retained:example.test" },
          },
        },
      },
    },
    roots: [],
  },
])("discovers $label with the optional plugin absent", ({ config, roots }) => {
  expect(resolveStatePortRoots({ config, stateDir, env })).toEqual(
    [stateDir, path.join(stateDir, "voice-calls"), ...roots].map((root) =>
      path.join(root, "state", "openclaw.sqlite"),
    ),
  );
});

it.each(
  [24, 26, 27, 28, 30].flatMap((version) => [
    { version, profiles: false },
    { version, profiles: true },
  ]),
)(
  "selects only present fragment catalogs for v$version with profiles and workspace=$profiles",
  async ({ version, profiles }) => {
    const descriptor = await statePortProvider.loadDescriptor(undefined, version);
    using source = openNodeSqliteDatabase(":memory:");
    source.exec(descriptor.sqlite);
    if (profiles) {
      source.exec(legacyWorkspaceSchema);
      source.exec(
        descriptor.fragments!.find((fragment) => fragment.id === "user_profiles")!.sqlite,
      );
    }
    const admitted = await admitDatabasePortDescriptor(
      { engine: "sqlite", db: source },
      descriptor,
    );
    expect(admitted.activeFragments).toEqual(
      profiles ? ["local_workspace_projections", "user_profiles"] : [],
    );
    const workspace = descriptor.fragments!.find(
      (fragment) => fragment.id === "local_workspace_projections",
    )!;
    expect(workspace.tables.map((table) => table.name)).toEqual(["local_workspace_projections"]);
    expect(workspace.sqlite).not.toContain("checkpoint_json");
    expect(workspace.preData).not.toContain("checkpoint_json");
    expect(workspace.preData + workspace.postData).not.toContain("local_workspace_manifest_nodes");
    if (profiles) {
      expect(workspace.expectedCatalog.filter((fact) => fact.kind === "column")).toMatchObject(
        rows(source, "PRAGMA table_info(local_workspace_projections)").map((column) => ({
          table: "local_workspace_projections",
          value: { name: column.name, position: Number(column.cid) + 1 },
        })),
      );
    }
    const tables = rows(
      source,
      "SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
    ).map((row) => row.name);
    expect(
      admitted.expectedCatalog.filter((fact) => fact.kind === "table").map((fact) => fact.table),
    ).toEqual(expect.arrayContaining(tables));
    expect(admitted.expectedCatalog.filter((fact) => fact.kind === "table")).toHaveLength(
      tables.length,
    );
    for (const table of ["acp_replay_events", "skill_usage"]) {
      expect(
        admitted.expectedCatalog.filter((fact) => fact.table === table && fact.kind === "indexes"),
      ).toEqual([
        {
          table,
          kind: "indexes",
          value: rows(source, `PRAGMA index_list(${table})`).length,
        },
      ]);
    }
    expect(
      rows(source, "PRAGMA index_info(idx_state_leases_owner)").map((row) => row.name),
    ).toEqual(version < 27 ? ["owner", "updated_at"] : ["owner"]);
    expect(
      rows(
        source,
        `SELECT name FROM sqlite_schema WHERE name IN
          ('idx_acp_replay_events_session_seq', 'idx_skill_usage_key') ORDER BY name`,
      ).map((row) => row.name),
    ).toEqual(version < 27 ? ["idx_acp_replay_events_session_seq", "idx_skill_usage_key"] : []);
  },
);
it("retains the exact predecessor credential tables for PostgreSQL update recovery", async () => {
  const predecessor = await loadStatePortDescriptor(28);
  const current = await loadStatePortDescriptor();
  const tables = ["device_identities", "device_auth_tokens", "gateway_origin_device_tokens"];
  using db = openNodeSqliteDatabase(":memory:");
  db.exec(predecessor.sqlite);
  db.prepare(`INSERT INTO device_identities VALUES (?, ?, ?, ?, ?, ?)`).run(
    "primary",
    "retained-device",
    "public-bytes",
    "private-bytes",
    1,
    2,
  );
  expect(db.prepare("SELECT private_key_pem FROM device_identities").get()).toEqual({
    private_key_pem: "private-bytes",
  });
  for (const table of tables) {
    expect(predecessor.tables.some((entry) => entry.name === table)).toBe(true);
    expect(predecessor.preData).toContain(`CREATE TABLE "${table}"`);
    expect(current.tables.some((entry) => entry.name === table)).toBe(false);
    expect(current.preData).not.toContain(`CREATE TABLE "${table}"`);
  }
  expect(current.tables.some((entry) => entry.name === "exec_approvals_config")).toBe(true);
});

it("captures only the credential retirement scope plus required schema metadata and statistics", () => {
  expect(backupTables(28, 29)).toEqual([
    "config_machine_state",
    "device_auth_tokens",
    "device_identities",
    "exec_approvals_config",
    "gateway_origin_device_tokens",
    "schema_meta",
    "sqlite_stat1",
    "sqlite_stat4",
  ]);
});

it("retains the v29 catalog and backs up only policy-fence metadata", async () => {
  const predecessor = await loadStatePortDescriptor(29);
  const current = await loadStatePortDescriptor(30);
  expect(predecessor.version).toBe(29);
  expect(current.version).toBe(30);
  expect(predecessor.tables).toEqual(current.tables);
  expect(predecessor.sqlite).toBe(current.sqlite);
  expect(predecessor.tables.some((table) => table.name === "device_auth_tokens")).toBe(false);
  expect(backupTables(29, 30)).toEqual(["config_machine_state", "schema_meta"]);
});

it("preserves v30 workspace recovery shape and admits incremental storage only at v31", async () => {
  for (const version of [30, 31]) {
    const descriptor = await loadStatePortDescriptor(version);
    expect(descriptor.version).toBe(version);
    const workspace = descriptor.fragments!.find(
      (fragment) => fragment.id === "local_workspace_projections",
    )!;
    using source = openNodeSqliteDatabase(":memory:");
    source.exec(workspace.sqlite);
    const insert = () =>
      source.exec(`INSERT INTO local_workspace_projections (
        worktree_id, agent_id, session_key, session_id, projection_path,
        base_commit, source_paths_json, baseline_ref, created_at_ms
      ) VALUES ('workspace', 'main', 'session', 'session', '/synthetic/workspace',
        'base', '[]', 'sha256:root', 1)`);
    if (version === 30) {
      expect(insert).toThrow("CHECK constraint failed");
    } else {
      insert();
      source
        .prepare(`INSERT INTO local_workspace_manifest_nodes VALUES (?, ?, ?)`)
        .run("workspace", "deleted.txt", '{"retained":"bytes"}');
      source.prepare("UPDATE local_workspace_projections SET checkpoint_json = ?").run("receipt");
      expect(
        source.prepare("SELECT checkpoint_json FROM local_workspace_projections").get(),
      ).toEqual({
        checkpoint_json: "receipt",
      });
    }
    expect(source.prepare("PRAGMA table_info(local_workspace_manifest_nodes)").all()).toHaveLength(
      version === 30 ? 0 : 3,
    );
  }
  expect(backupTables(30, 31)).toEqual([
    "config_machine_state",
    "local_workspace_manifest_nodes",
    "local_workspace_projections",
    "schema_meta",
    "sqlite_stat1",
    "sqlite_stat4",
  ]);
});

it("preserves schema 33/34 workspace inputs and ports shared digests and fingerprints at schema 35", async () => {
  for (const version of [33, 34, 35]) {
    const descriptor = await loadStatePortDescriptor(version);
    const workspace = descriptor.fragments!.find(
      (fragment) => fragment.id === "local_workspace_projections",
    )!;
    using source = openNodeSqliteDatabase(":memory:");
    source.exec(workspace.sqlite);
    const columns = new Set(
      source
        .prepare("PRAGMA table_info(local_workspace_projections)")
        .all()
        .map((column) => column.name),
    );
    for (const column of [
      "tree_root_digest",
      "source_paths_digest",
      "canonical_fingerprints",
      "projection_fingerprints",
    ]) {
      expect(columns.has(column)).toBe(version === 35);
    }
    for (const table of ["local_workspace_tree_packs", "local_workspace_source_path_sets"]) {
      expect(
        source.prepare(`SELECT name FROM sqlite_schema WHERE name = ?`).get(table) !== undefined,
      ).toBe(version === 35);
      expect(workspace.tables.some((entry) => entry.name === table)).toBe(version === 35);
      if (version === 35) {
        expect(workspace.tables.find((entry) => entry.name === table)?.pk).toEqual([
          table === "local_workspace_tree_packs" ? "tree_digest" : "path_digest",
        ]);
      }
      expect((workspace.preData + workspace.postData).includes(`CREATE TABLE "${table}"`)).toBe(
        version === 35,
      );
    }
    // The online converter still needs its retained source at both versions.
    expect(source.prepare("PRAGMA table_info(local_workspace_manifest_nodes)").all()).toHaveLength(
      3,
    );
  }
  expect(backupTables(34, 35)).toEqual([
    "config_machine_state",
    "local_workspace_manifest_nodes",
    "local_workspace_projections",
    "local_workspace_source_path_sets",
    "local_workspace_tree_packs",
    "schema_meta",
  ]);
});
