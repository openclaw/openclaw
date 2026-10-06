import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { backupDoctorMigrationDatabases } from "../commands/doctor-migration-backup.js";
import { withDoctorSqliteMaintenanceLock } from "../commands/doctor-sqlite-maintenance-lock.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
  repairOpenClawStateDatabaseSchema,
} from "../state/openclaw-state-db.js";
import { readClawResumeStateReadOnly } from "./package-resume.js";
import { parseClawManifest } from "./schema.js";
import type { ClawSourceIdentity } from "./types.js";
import { buildClawUpdatePlan } from "./update-plan.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(() => closeOpenClawStateDatabaseForTest());

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
  for (const column of [
    "claw_installs.bootstrap_source_path",
    "claw_installs.bootstrap_content_digest",
    "claw_package_refs.extension_id",
    "claw_package_refs.extension_format",
    "claw_package_refs.extension_detected_format",
    "claw_package_refs.extension_mapped_json",
    "claw_package_refs.extension_unavailable_json",
    "claw_package_refs.extension_adapter_identity",
  ]) {
    const [table, name] = column.split(".");
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
  return {
    env,
    databasePath: createBaseShapeState({ env, packageRoot, workspace }),
    packageRoot,
    workspace,
  };
}

describe("read-only Claw state admission", () => {
  it("requires backed-up Doctor schema repair before plan and resume reads", async () => {
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

    const planUpdate = () =>
      buildClawUpdatePlan({
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
    const resume = () =>
      readClawResumeStateReadOnly("legacy-worker", { path: fixture.databasePath });
    await expect(planUpdate()).rejects.toThrow("openclaw doctor --fix");
    await expect(resume()).rejects.toThrow("openclaw doctor --fix");
    expect(await readFile(fixture.databasePath)).toEqual(before);
    const readRows = (file: string) => {
      const db = new DatabaseSync(file, { readOnly: true });
      try {
        return db.prepare("SELECT * FROM claw_installs").all();
      } finally {
        db.close();
      }
    };
    const originalRows = readRows(fixture.databasePath);
    const backupParams = { env: fixture.env, pendingDatabasePaths: [], databasePaths: [] };
    await withDoctorSqliteMaintenanceLock({
      env: fixture.env,
      operation: "Claw provenance schema repair",
      protectedPaths: [fixture.databasePath],
      run: async () => {
        const backup = await backupDoctorMigrationDatabases(backupParams);
        expect(backup.changes).toHaveLength(1);
        expect(repairOpenClawStateDatabaseSchema({ env: fixture.env }).warnings).toEqual([]);
        expect(await backupDoctorMigrationDatabases(backupParams)).toEqual({
          changes: [],
          warnings: [],
        });
      },
    });
    const backupFiles = (await readdir(dirname(fixture.databasePath))).filter(
      (name) => name.includes(".pre-startup-migration-") && name.endsWith(".bak"),
    );
    expect(backupFiles).toHaveLength(1);
    expect(readRows(join(dirname(fixture.databasePath), backupFiles[0]!))).toEqual(originalRows);
    const canonicalRows = structuredClone(originalRows);
    for (const row of canonicalRows) {
      row.bootstrap_source_path = null;
      row.bootstrap_content_digest = null;
    }
    expect(readRows(fixture.databasePath)).toEqual(canonicalRows);
    const plan = await planUpdate();
    expect(plan.blockers).not.toContainEqual(expect.objectContaining({ code: "claw_not_found" }));
    expect(plan.blockers).not.toContainEqual(
      expect.objectContaining({ code: "claw_identity_mismatch" }),
    );
    const state = await resume();
    expect(state?.record).toMatchObject({ agentId: "legacy-worker", status: "complete" });
    expect(state?.record.bootstrap).toBeUndefined();
  });
});
