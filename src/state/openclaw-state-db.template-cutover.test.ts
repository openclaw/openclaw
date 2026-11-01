import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { bindFreshClientCredentialStore } from "../infra/client-credential-migration.js";
import type { EngineConnection } from "../infra/sql-connection.js";
import { runSqliteImmediateTransactionSync } from "../infra/sqlite-transaction.js";
import { requireNativeSqliteDatabase } from "../test-utils/native-sqlite.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "./openclaw-state-db-contract.js";
import { assertExistingOpenClawStateRuntimeSchema } from "./openclaw-state-db-existing-schema.js";
import { readStateSchemaContentVersion } from "./openclaw-state-db-schema-version.js";
import { closeOpenClawStateDatabaseAsync, openOpenClawStateDatabase } from "./openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "./openclaw-state-db.paths.js";
import { getOpenClawStateFeatureSchemaSql } from "./openclaw-state-feature-schema.js";
import { OPENCLAW_STATE_SCHEMA_SQL } from "./openclaw-state-schema.js";
import {
  addPreCutoverClientCredentialTablesForTest,
  createInitialStateSchemaShape,
  restorePreTemplateStateIdentifiersForTest,
} from "./openclaw-state-schema.test-support.js";
import {
  collectSqliteSchemaShape,
  normalizeSqliteSchemaShapeSql,
} from "./sqlite-schema-shape.test-support.js";

// Exact schema-35 source from 2e72690d0acbde9c1d8e274a0531938807102c65, not reversed candidate DDL.
const legacySchema = readFileSync(
  new URL("../../test/fixtures/sqlite/openclaw-state-schema-v35.sql", import.meta.url),
  "utf8",
);
const legacyFixtureSha256 = "d436399d596dabc437f6a66024912269ba78d4cebcdb8603202b041185ba4d2d";

const dirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    await closeOpenClawStateDatabaseAsync();
    cleanup();
  }),
);
const setting = '{"theme":"claw","opaque":"claw-introduced","enabled":true}';

function ordinaryRows(db: EngineConnection, provenance: boolean) {
  return {
    agents: db.prepare("SELECT * FROM agent_databases ORDER BY agent_id").all(),
    profile: db.prepare("SELECT * FROM user_profiles ORDER BY id").all(),
    settings: db
      .prepare("SELECT * FROM config_machine_state WHERE state_key = 'ordinary.setting'")
      .all(),
    ...(provenance
      ? { provenance: db.prepare("SELECT rowid, * FROM agent_provenance ORDER BY agent_id").all() }
      : {}),
  };
}

function fixture(provenance = true, refusePublication = false) {
  expect(createHash("sha256").update(legacySchema).digest("hex")).toBe(legacyFixtureSha256);
  const root = dirs.make("state-template-cutover-");
  const env = {
    ...process.env,
    OPENCLAW_HOME: path.join(root, "home"),
    OPENCLAW_STATE_DIR: path.join(root, "state"),
    OPENCLAW_CONFIG_PATH: path.join(root, "openclaw.json"),
  };
  const pathname = resolveOpenClawStateSqlitePath(env);
  mkdirSync(path.dirname(pathname), { recursive: true });
  using db = new DatabaseSync(pathname);
  db.exec("PRAGMA foreign_keys = OFF; BEGIN IMMEDIATE;");
  db.exec(legacySchema);
  db.exec(getOpenClawStateFeatureSchemaSql("user_profiles"));
  db.exec(`PRAGMA user_version = 35;
    INSERT INTO schema_meta VALUES ('primary', 'global', 35, NULL, 'frozen-schema-35', 100, 100);
    INSERT INTO config_machine_state VALUES ('state.schema.contentVersion', '35', 100);
    INSERT INTO agent_databases VALUES ('ordinary', 'agents/ordinary/agent/agent.sqlite', 38, 100, 0);
    INSERT INTO user_profiles (id, display_name, role, created_at, updated_at)
      VALUES ('ordinary-profile', 'Claw Team', 'admin', 100, 100);`);
  db.prepare("INSERT INTO config_machine_state VALUES ('ordinary.setting', ?, 100)").run(setting);
  if (provenance) {
    db.exec(`INSERT INTO agent_provenance(rowid, agent_id, created_via, creator_agent_id, created_at_ms)
      VALUES (42, 'ordinary', 'operator', NULL, 101), (43, 'by-agent', 'agent', 'ordinary', 102);`);
  } else {
    db.exec("DROP TABLE agent_provenance;");
  }
  if (refusePublication) {
    db.exec(`CREATE TRIGGER refuse_template_version BEFORE UPDATE ON schema_meta
      BEGIN SELECT RAISE(ABORT, 'fixture version publication refusal'); END;`);
  }
  db.exec("COMMIT; PRAGMA foreign_keys = ON;");
  const before = ordinaryRows(db, provenance);
  return { pathname, env, before, provenance };
}

function expectCanonical(db: EngineConnection) {
  expect(db.prepare("PRAGMA user_version").get()?.user_version).toBe(OPENCLAW_STATE_SCHEMA_VERSION);
  expect(
    db.prepare("SELECT schema_version FROM schema_meta WHERE meta_key = 'primary'").get(),
  ).toEqual({ schema_version: OPENCLAW_STATE_SCHEMA_VERSION });
  expect(readStateSchemaContentVersion(db)).toBe(OPENCLAW_STATE_SCHEMA_VERSION);
  expect(
    db
      .prepare(
        "SELECT name FROM sqlite_schema WHERE type IN ('table', 'view') AND name GLOB 'claw_*'",
      )
      .all(),
  ).toEqual([]);
  expect(
    db
      .prepare(
        "SELECT name FROM sqlite_schema WHERE type = 'table' AND name GLOB 'template_*' ORDER BY name",
      )
      .all(),
  ).toEqual([
    { name: "template_cron_refs" },
    { name: "template_installs" },
    { name: "template_mcp_server_refs" },
    { name: "template_package_refs" },
    { name: "template_workspace_files" },
  ]);
}

it.each([true, false])(
  "opens an untouched schema-35 store with no Labs rows (provenance present: %s)",
  async (provenance) => {
    const f = fixture(provenance);
    const opened = openOpenClawStateDatabase({ path: f.pathname, env: f.env });
    expectCanonical(opened.db);
    expect(ordinaryRows(opened.db, provenance)).toEqual(f.before);
    expect(
      opened.db.prepare("SELECT name FROM sqlite_schema WHERE name = 'agent_provenance'").all(),
    ).toHaveLength(provenance ? 1 : 0);
    await closeOpenClawStateDatabaseAsync();
    using read = new DatabaseSync(f.pathname, { readOnly: true });
    expect(() => assertExistingOpenClawStateRuntimeSchema(read, f.pathname)).not.toThrow();
    expect(ordinaryRows(read, provenance)).toEqual(f.before);
    const reopened = openOpenClawStateDatabase({ path: f.pathname, env: f.env });
    expectCanonical(reopened.db);
    expect(ordinaryRows(reopened.db, provenance)).toEqual(f.before);
  },
);

it("creates fresh shared state directly at the canonical Template version", () => {
  const env = { OPENCLAW_STATE_DIR: dirs.make("state-template-fresh-") };
  const db = openOpenClawStateDatabase({ env }).db;
  expectCanonical(db);
});

it("adds credential fixture tables without downgrading an already current Template schema", () => {
  using db = new DatabaseSync(":memory:");
  db.exec(OPENCLAW_STATE_SCHEMA_SQL);
  db.exec(`PRAGMA user_version = 36;
    INSERT INTO schema_meta VALUES ('primary', 'global', 36, NULL, 'current-fixture', 100, 100);`);
  const schema = db.prepare(
    "SELECT name, sql FROM sqlite_schema WHERE name GLOB 'template_*' ORDER BY name",
  );
  const before = schema.all();
  addPreCutoverClientCredentialTablesForTest(db);
  expect(schema.all()).toEqual(before);
  expect(db.prepare("PRAGMA user_version").get()).toEqual({ user_version: 36 });
  expect(
    db.prepare("SELECT schema_version FROM schema_meta WHERE meta_key = 'primary'").get(),
  ).toEqual({ schema_version: 36 });
  expect(db.prepare("SELECT name FROM sqlite_schema WHERE name GLOB 'claw_*'").all()).toEqual([]);
});

it("rolls back the complete cutover when version publication is refused", async () => {
  const f = fixture(true, true);
  expect(() => openOpenClawStateDatabase({ path: f.pathname, env: f.env })).toThrow(
    /fixture version publication refusal/,
  );
  await closeOpenClawStateDatabaseAsync();
  using db = new DatabaseSync(f.pathname, { readOnly: true });
  expect(db.prepare("PRAGMA user_version").get()?.user_version).toBe(35);
  expect(
    db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name GLOB 'claw_*'").all(),
  ).toHaveLength(5);
  expect(db.prepare("SELECT name FROM sqlite_schema WHERE name GLOB 'template_*'").all()).toEqual(
    [],
  );
  expect(ordinaryRows(db, true)).toEqual(f.before);
});

it("migrates structured installed records without rewriting user strings or opaque JSON", async () => {
  const f = fixture();
  const opaque = '{"name":"claw","origin":"claw-introduced","path":"claw_installs"}';
  {
    using predecessor = new DatabaseSync(f.pathname);
    predecessor.exec(`INSERT INTO claw_installs VALUES (
      'starter', 'openclaw.clawInstallRecord.v3', 'package', '@fixture/claw', '0.1.1',
      '/claw/source', '/claw/source/CLAW.md', 'artifact', 'sha256:claw', 123, 1,
      'sha256:claw-plan', '/claw/workspace', 'sha256:config', '["claw"]', NULL, NULL,
      'complete', 100, 200);
      INSERT INTO claw_workspace_files VALUES (
        'starter', 'claw.txt', 'openclaw.clawWorkspaceFileRecord.v1', '/claw/workspace',
        'claw.txt', 'sha256:claw', 'complete', 100, 200);
      INSERT INTO claw_package_refs VALUES (
        'starter', 'skill', 'clawhub', '@fixture/claw', '0.1.1', 'sha256:claw',
        'openclaw.clawPackageRef.v1', '@fixture/claw', 'complete', 'managed',
        'claw-introduced', 0, NULL, NULL, NULL, NULL, NULL, NULL, 100, 200);
      INSERT INTO claw_mcp_server_refs VALUES (
        'starter', 'claw', 'openclaw.clawMcpServerRef.v1', 'sha256:claw', 'managed',
        'claw-introduced', 0, 'complete', NULL, 100, 200);
      INSERT INTO agent_provenance VALUES ('starter', 'claw', NULL, 100);`);
    predecessor
      .prepare("INSERT INTO claw_cron_refs VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(
        "starter",
        "claw",
        "openclaw.clawCronRef.v1",
        "claw-key",
        "claw-job",
        "complete",
        opaque,
        null,
        100,
        200,
      );
  }
  const db = openOpenClawStateDatabase({ path: f.pathname, env: f.env }).db;
  expectCanonical(db);
  expect(
    db
      .prepare(
        "SELECT template_name, template_version, schema_version, package_root, agent_owned_paths_json FROM template_installs",
      )
      .get(),
  ).toEqual({
    template_name: "@fixture/claw",
    template_version: "0.1.1",
    schema_version: "openclaw.templateInstallRecord.v3",
    package_root: "/claw/source",
    agent_owned_paths_json: '["claw"]',
  });
  expect(
    db
      .prepare(
        "SELECT schema_version, origin, package_integrity, template_name FROM template_package_refs",
      )
      .get(),
  ).toEqual({
    schema_version: "openclaw.templatePackageRef.v1",
    origin: "template-introduced",
    package_integrity: "sha256:claw",
    template_name: "@fixture/claw",
  });
  expect(
    db.prepare("SELECT schema_version, target_path FROM template_workspace_files").get(),
  ).toEqual({ schema_version: "openclaw.templateWorkspaceFileRecord.v1", target_path: "claw.txt" });
  expect(
    db.prepare("SELECT schema_version, name, origin FROM template_mcp_server_refs").get(),
  ).toEqual({
    schema_version: "openclaw.templateMcpServerRef.v1",
    name: "claw",
    origin: "template-introduced",
  });
  expect(db.prepare("SELECT schema_version, job_json FROM template_cron_refs").get()).toEqual({
    schema_version: "openclaw.templateCronRef.v1",
    job_json: opaque,
  });
  expect(
    db.prepare("SELECT created_via FROM agent_provenance WHERE agent_id = 'starter'").get(),
  ).toEqual({ created_via: "template" });
  await closeOpenClawStateDatabaseAsync();
  using read = new DatabaseSync(f.pathname, { readOnly: true });
  expect(() => assertExistingOpenClawStateRuntimeSchema(read, f.pathname)).not.toThrow();
});

// Keep Template-specific additive repair coverage beside its versioned cutover.
it("repairs same-version Template bootstrap columns with a missing index through its admitted path", async () => {
  const options = { env: { OPENCLAW_STATE_DIR: dirs.make("template-additive-repair-") } };
  const sourcePath = openOpenClawStateDatabase({
    env: { OPENCLAW_STATE_DIR: dirs.make("template-additive-source-") },
  }).path;
  await closeOpenClawStateDatabaseAsync();
  const pathname = resolveOpenClawStateSqlitePath(options.env);
  mkdirSync(path.dirname(pathname), { recursive: true });
  // Match the original fixture's fresh physical identity, without stale source admissions.
  copyFileSync(sourcePath, pathname);
  {
    using shippedSchema = new DatabaseSync(pathname);
    runSqliteImmediateTransactionSync(shippedSchema, () =>
      bindFreshClientCredentialStore(shippedSchema, { path: pathname, env: options.env }),
    );
    shippedSchema.exec(`
      ALTER TABLE template_installs DROP COLUMN bootstrap_source_path;
      ALTER TABLE template_installs DROP COLUMN bootstrap_content_digest;
      DROP INDEX idx_task_runs_runtime_run;
    `);
    expectCanonical(shippedSchema);
  }
  const reopened = openOpenClawStateDatabase(options);
  const columns = reopened.db.prepare("PRAGMA table_info(template_installs)").all();
  expect(columns.map((column) => column.name)).toEqual(
    expect.arrayContaining(["bootstrap_source_path", "bootstrap_content_digest"]),
  );
  expect(
    normalizeSqliteSchemaShapeSql(
      collectSqliteSchemaShape(requireNativeSqliteDatabase(reopened.db)),
    ),
  ).toEqual(normalizeSqliteSchemaShapeSql(createInitialStateSchemaShape()));
});

it("restores only predecessor-owned definitions while retaining local CHECKs, indexes, triggers and rowids", () => {
  using db = new DatabaseSync(":memory:");
  db.exec(OPENCLAW_STATE_SCHEMA_SQL);
  db.exec(`ALTER TABLE template_package_refs ADD COLUMN local_label TEXT NOT NULL
      DEFAULT 'template' CHECK (local_label = 'template');
    CREATE TABLE fixture_local_effects (value TEXT);
    CREATE INDEX fixture_local_label ON template_package_refs(local_label)
      WHERE local_label = 'template';
    CREATE TRIGGER fixture_local_effect AFTER UPDATE ON template_package_refs
      BEGIN INSERT INTO fixture_local_effects VALUES ('template-introduced'); END;
    INSERT INTO template_package_refs
      (rowid, agent_id, package_kind, package_source, package_ref, package_version,
       package_integrity, schema_version, template_name, package_status, relationship,
       origin, independent_owner, installed_at_ms, updated_at_ms)
      VALUES (71, 'fixture', 'skill', 'clawhub', '@fixture/package', '0.1.1',
        'sha256:retained', 'openclaw.templatePackageRef.v1', 'literal template_name',
        'complete', 'managed', 'template-introduced', 0, 100, 100);`);
  restorePreTemplateStateIdentifiersForTest(db);
  expect(
    db.prepare("SELECT rowid, claw_name, origin, local_label FROM claw_package_refs").get(),
  ).toEqual({
    rowid: 71,
    claw_name: "literal template_name",
    origin: "claw-introduced",
    local_label: "template",
  });
  expect(
    db.prepare("SELECT sql FROM sqlite_schema WHERE name = 'fixture_local_label'").get()?.sql,
  ).toContain("local_label = 'template'");
  expect(db.prepare("SELECT * FROM fixture_local_effects").all()).toEqual([]);
  db.exec("UPDATE claw_package_refs SET package_status = 'retained'");
  expect(db.prepare("SELECT * FROM fixture_local_effects").all()).toEqual([
    { value: "template-introduced" },
  ]);
});
