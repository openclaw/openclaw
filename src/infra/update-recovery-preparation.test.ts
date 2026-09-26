import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { openNodeSqliteDatabase } from "./node-sqlite.js";
import type { UpdateRecoveryBackupRef } from "./update-recovery-backup-contract.js";
import { fileDigest } from "./update-recovery-backup-files.js";
import { prepareVerifiedBackup } from "./update-recovery-backup-verify.js";
import { prepareUpdateRecoveryGeneration } from "./update-recovery-preparation.js";

const mocks = vi.hoisted(() => ({ getRun: vi.fn() }));
vi.mock("./update-run-reader.js", () => ({ getUpdateRunAsync: mocks.getRun }));

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

async function writeManifest(
  directory: string,
  manifest: object,
): Promise<UpdateRecoveryBackupRef> {
  const manifestPath = path.join(directory, "manifest.json");
  const raw = `${JSON.stringify(manifest)}\n`;
  await fs.writeFile(manifestPath, raw, { mode: 0o600 });
  return { directory, manifestPath, manifestSha256: sha256(raw) };
}

it("prepares and verifies a same-schema recovery generation through current owners", async () => {
  const root = await fs.realpath(tempDirs.make("update-recovery-preparation-"));
  const stateDir = path.join(root, "state");
  const configPath = path.join(stateDir, "openclaw.json");
  const databasePath = path.join(stateDir, "state", "openclaw.sqlite");
  const runId = "11111111-1111-4111-8111-111111111111";
  const baselineDirectory = `${stateDir}.update-captures/${runId}`;
  const candidateDirectory = path.join(baselineDirectory, "candidate");
  await fs.mkdir(path.dirname(databasePath), { recursive: true, mode: 0o700 });
  await fs.mkdir(path.join(baselineDirectory, "payload"), { recursive: true, mode: 0o700 });
  await fs.mkdir(path.join(candidateDirectory, "payload"), { recursive: true, mode: 0o700 });
  await fs.chmod(baselineDirectory, 0o700);
  await fs.chmod(candidateDirectory, 0o700);
  vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
  vi.stubEnv("OPENCLAW_CONFIG_PATH", configPath);

  const baselinePayload = path.join(baselineDirectory, "payload", "2");
  const database = openNodeSqliteDatabase(baselinePayload);
  try {
    database.exec(`PRAGMA user_version=19;
      CREATE TABLE schema_meta(meta_key TEXT PRIMARY KEY, role TEXT, agent_id TEXT, schema_version INTEGER, app_version TEXT);
      INSERT INTO schema_meta VALUES('primary','global',NULL,19,'before');
      CREATE TABLE config_machine_state(state_key TEXT PRIMARY KEY, value_json TEXT);
      CREATE TABLE acknowledged(id TEXT PRIMARY KEY, value TEXT);
      INSERT INTO acknowledged VALUES('row','before');
      CREATE TABLE state_leases(scope TEXT, lease_key TEXT, owner TEXT, updated_at INTEGER, expires_at INTEGER);
      INSERT INTO state_leases VALUES('test','lease','source',1,2);
      CREATE TABLE agent_database_leases(database_path TEXT, owner TEXT);
      INSERT INTO agent_database_leases VALUES('/source','source');`);
  } finally {
    database.close();
  }
  const candidatePayload = path.join(candidateDirectory, "payload", "2");
  await fs.copyFile(baselinePayload, candidatePayload);
  const candidate = openNodeSqliteDatabase(candidatePayload);
  try {
    candidate.prepare("UPDATE acknowledged SET value='candidate' WHERE id='row'").run();
  } finally {
    candidate.close();
  }
  const common = {
    schemaVersion: 2,
    kind: "update-recovery",
    databases: [{ path: databasePath, role: "global" }],
    runId,
    installRoot: path.join(root, "install"),
    stateDir,
    configPath,
    configPaths: [configPath],
    creator: { host: "fixture", pid: 1, startIdentity: "1" },
    drivers: [],
    createdAt: "2026-09-25T00:00:00.000Z",
    roots: [stateDir],
    excludedRoots: [],
    protectedPaths: [configPath],
  };
  const entries = async (payload: string) => [
    { kind: "directory", sourcePath: stateDir, mode: 0o700 },
    { kind: "missing", sourcePath: configPath, sqlite: false, directory: false },
    {
      kind: "file",
      sourcePath: databasePath,
      archivePath: "payload/2",
      sqlite: true,
      mode: 0o600,
      ...(await fileDigest(payload)),
    },
  ];
  const baselineRef = await writeManifest(baselineDirectory, {
    ...common,
    generation: { kind: "baseline" },
    entries: await entries(baselinePayload),
  });
  const candidateRef = await writeManifest(candidateDirectory, {
    ...common,
    generation: { kind: "candidate", baselineSha256: baselineRef.manifestSha256 },
    entries: await entries(candidatePayload),
  });
  mocks.getRun.mockResolvedValue({
    origin: {
      updateRecoveryCapture: { manifestSha256: baselineRef.manifestSha256, configWrites: [] },
    },
  });
  const verifiedCandidate = await prepareVerifiedBackup(candidateRef);
  const candidateBytes = await fs.readFile(candidatePayload);
  const changedCandidate = openNodeSqliteDatabase(candidatePayload);
  try {
    changedCandidate.prepare("UPDATE acknowledged SET value='changed-after-verification'").run();
  } finally {
    changedCandidate.close();
  }
  await expect(verifiedCandidate.assertCurrent()).rejects.toThrow(
    "Update recovery source payload changed",
  );
  await expect(verifiedCandidate.close()).rejects.toThrow(
    "Update recovery verification cleanup failed",
  );
  await fs.writeFile(candidatePayload, candidateBytes);
  const before = await Promise.all([fs.readFile(baselinePayload), fs.readFile(candidatePayload)]);
  const prepared = await prepareUpdateRecoveryGeneration(baselineRef, candidateRef, {
    assertOwned() {},
    env: { ...process.env, OPENCLAW_STATE_DIR: stateDir, OPENCLAW_CONFIG_PATH: configPath },
  });
  expect(prepared.directory).toBe(path.join(baselineDirectory, "prepared"));
  const preparedDatabase = openNodeSqliteDatabase(path.join(prepared.directory, "payload", "2"), {
    readOnly: true,
  });
  try {
    expect(preparedDatabase.prepare("SELECT value FROM acknowledged WHERE id='row'").get()).toEqual(
      { value: "candidate" },
    );
    expect(preparedDatabase.prepare("SELECT COUNT(*) AS count FROM state_leases").get()).toEqual({
      count: 0,
    });
    expect(
      preparedDatabase.prepare("SELECT COUNT(*) AS count FROM agent_database_leases").get(),
    ).toEqual({ count: 0 });
  } finally {
    preparedDatabase.close();
  }
  expect(await Promise.all([fs.readFile(baselinePayload), fs.readFile(candidatePayload)])).toEqual(
    before,
  );
});
