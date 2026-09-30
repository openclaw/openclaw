// Regression coverage for read-only Claw state access on databases that predate
// the additive provenance columns but already report the current schema version.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { StatementSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { observeSqliteReadSql } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import { getAdmittedSqliteSchemaFacts } from "../infra/sqlite-schema-facts.js";
import { tableExists } from "../state/openclaw-state-db-schema-helpers.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
  openExistingOpenClawStateDatabaseReadOnly,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { OPENCLAW_STATE_MAINTENANCE_SCHEMA_COMPATIBILITY } from "../state/openclaw-state-schema-compatibility.js";
import { readClawResumeStateReadOnly } from "./package-resume.js";
import { parseClawManifest } from "./schema.js";
import type { ClawSourceIdentity } from "./types.js";
import { buildClawUpdatePlan } from "./update-plan.js";

const tempDirs = useAutoCleanupTempDirTracker((cleanup) => {
  afterEach(async () => {
    await closeOpenClawStateDatabaseAsync();
    closeOpenClawStateDatabaseForTest();
    cleanup();
  });
});

function createBaseShapeState(params: {
  env: { OPENCLAW_STATE_DIR: string };
  packageRoot: string;
  workspace: string;
}): string {
  const database = openOpenClawStateDatabase({ env: params.env });
  const databasePath = database.path;
  database.db
    .prepare(
      `INSERT INTO claw_installs (
        agent_id, schema_version, source_kind, claw_name, claw_version, package_root,
        manifest_path, integrity_kind, integrity, source_byte_length, manifest_schema_version,
        plan_integrity, workspace, agent_config_digest, agent_owned_paths_json, status,
        added_at_ms, updated_at_ms
      ) VALUES (
        'legacy-worker', 'openclaw.clawInstallRecord.v1', 'package', '@acme/legacy', '1.0.0', ?,
        ?, 'artifact', 'sha256:aa', 10, 1, 'sha256:bb', ?, 'sha256:cc', '[]', 'complete',
        1000, 2000
      )`,
    )
    .run(params.packageRoot, join(params.packageRoot, "CLAW.md"), params.workspace);
  for (const column of OPENCLAW_STATE_MAINTENANCE_SCHEMA_COMPATIBILITY.allowedMissingColumns ??
    []) {
    const [table, name] = column.split(".");
    if (!table || !name) {
      continue;
    }
    // Additive columns can belong to tables that are stripped from claw-scoped
    // schemas entirely (e.g. node_worker_launches); base shape only drops
    // columns whose owning table exists here.
    const tableRow = database.db
      .prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`)
      .get(table);
    if (!tableRow) {
      continue;
    }
    database.db.exec(`ALTER TABLE ${table} DROP COLUMN ${name};`);
  }
  closeOpenClawStateDatabaseForTest();
  return databasePath;
}

async function createFixture(label: string): Promise<{
  env: { OPENCLAW_STATE_DIR: string };
  databasePath: string;
  packageRoot: string;
  workspace: string;
}> {
  const root = tempDirs.make(label);
  const packageRoot = join(root, "package");
  const workspace = join(root, "workspace");
  await mkdir(packageRoot, { recursive: true });
  await mkdir(workspace, { recursive: true });
  await writeFile(join(packageRoot, "CLAW.md"), "---\nschemaVersion: 1\n---\n", "utf8");
  const env = { OPENCLAW_STATE_DIR: join(root, "state") };
  const databasePath = createBaseShapeState({ env, packageRoot, workspace });
  await closeOpenClawStateDatabaseAsync();
  return {
    env,
    databasePath,
    packageRoot,
    workspace,
  };
}

describe("read-only Claw state compatibility", () => {
  it("admits base-shape table facts without repeating catalog SQL", async () => {
    const fixture = await createFixture("openclaw-claw-base-shape-admission-");
    const before = await readFile(fixture.databasePath);
    const isCatalogSql = (sql: string) => /\bsqlite_(?:master|schema)\b/iu.test(sql);

    // An unadmitted reader proves the observer sees repeated catalog reads.
    const unadmitted = openNodeSqliteDatabase(fixture.databasePath, { readOnly: true });
    const control = observeSqliteReadSql(StatementSync.prototype);
    try {
      expect(getAdmittedSqliteSchemaFacts(unadmitted)).toBeUndefined();
      expect(tableExists(unadmitted, "claw_installs")).toBe(true);
      expect(tableExists(unadmitted, "claw_installs")).toBe(true);
      expect(control.queries.filter(isCatalogSql)).toHaveLength(2);
    } finally {
      control.restore();
      unadmitted.close();
    }

    const database = await openExistingOpenClawStateDatabaseReadOnly({ env: fixture.env });
    if (!database) {
      throw new Error("Expected the existing base-shape database to open");
    }
    const observation = observeSqliteReadSql(StatementSync.prototype);
    try {
      const facts = getAdmittedSqliteSchemaFacts(database.db);
      expect(facts).toBeDefined();
      expect(facts?.tables.has("claw_installs")).toBe(true);
      for (let index = 0; index < 3; index += 1) {
        expect(tableExists(database.db, "claw_installs")).toBe(true);
        expect(tableExists(database.db, "missing_claw_table")).toBe(false);
        expect(getAdmittedSqliteSchemaFacts(database.db)).toBe(facts);
      }
      expect(observation.queries.filter(isCatalogSql)).toHaveLength(0);
    } finally {
      observation.restore();
      database.walMaintenance.close();
    }
    expect(before.equals(await readFile(fixture.databasePath))).toBe(true);
  });

  it("plans an update against a base-shape database without mutating it", async () => {
    const fixture = await createFixture("openclaw-claw-base-shape-");
    const before = await readFile(fixture.databasePath);
    const parsed = parseClawManifest({
      schemaVersion: 1,
      agent: { id: "legacy-worker", name: "Legacy Worker" },
    });
    if (!parsed.ok) {
      throw new Error(JSON.stringify(parsed.diagnostics));
    }
    const source: ClawSourceIdentity = {
      kind: "package",
      name: "@acme/legacy",
      version: "1.1.0",
      packageRoot: fixture.packageRoot,
      manifestPath: join(fixture.packageRoot, "CLAW.md"),
      integrityKind: "artifact",
      integrity: "sha256:dd",
      byteLength: 12,
    };

    const plan = await buildClawUpdatePlan({
      agentId: "legacy-worker",
      targetManifest: parsed.manifest,
      targetSource: source,
      config: {},
      sourceMcpServers: {},
      stateOptions: { env: fixture.env },
      packagePreflight: async () => ({
        ok: true as const,
        action: "install" as const,
        integrity: `sha256:${"a".repeat(64)}`,
      }),
    });

    expect(plan.blockers).not.toContainEqual(expect.objectContaining({ code: "claw_not_found" }));
    expect(plan.blockers).not.toContainEqual(
      expect.objectContaining({ code: "claw_identity_mismatch" }),
    );
    expect(before.equals(await readFile(fixture.databasePath))).toBe(true);
  });

  it("resumes a base-shape database without mutating it", async () => {
    const fixture = await createFixture("openclaw-claw-base-shape-resume-");
    const before = await readFile(fixture.databasePath);

    const state = await readClawResumeStateReadOnly("legacy-worker", {
      path: fixture.databasePath,
    });

    expect(state?.record).toMatchObject({ agentId: "legacy-worker", status: "complete" });
    expect(state?.record.bootstrap).toBeUndefined();
    expect(before.equals(await readFile(fixture.databasePath))).toBe(true);
  });
});
