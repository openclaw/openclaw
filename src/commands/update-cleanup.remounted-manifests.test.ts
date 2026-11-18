import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { resolveSessionSqliteMigrationRunsDir } from "../infra/session-sqlite-migration-manifest.js";
import { createUpdateRun, finishUpdateRun } from "../infra/update-run-ledger.js";
import { closeOpenClawStateDatabaseAsync } from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { cleanupSessionStateForTest } from "../test-utils/session-state-cleanup.js";
import { inspectSessionSqliteRecovery } from "./doctor-session-sqlite-recovery-inventory.js";
import { retireSessionSqliteRecovery } from "./doctor-session-sqlite-retirement.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
let env: NodeJS.ProcessEnv;
let stateDir: string;
beforeEach(() => {
  const home = fs.realpathSync(dirs.make("remounted-manifests-"));
  stateDir = path.join(home, "state");
  fs.mkdirSync(stateDir);
  for (const [key, value] of Object.entries({
    HOME: home,
    OPENCLAW_HOME: "",
    OPENCLAW_PROFILE: "",
    OPENCLAW_STATE_DIR: stateDir,
    OPENCLAW_CONFIG_PATH: path.join(stateDir, "openclaw.json"),
  })) {
    vi.stubEnv(key, value);
  }
  fs.writeFileSync(process.env.OPENCLAW_CONFIG_PATH!, "{}\n");
  env = { ...process.env };
});
afterEach(async () => {
  await cleanupSessionStateForTest();
  await closeOpenClawStateDatabaseAsync();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

/** A manifest exactly as a 2026.10.x startup migration stored it, recorded before a reboot. */
function storedPreRebootManifest(destinations: string[], completedAt: string) {
  const backupId = randomUUID();
  const targets = destinations.map((sqlitePath) => {
    const archivePath = `${sqlitePath}.pre-startup-migration-${backupId}.bak`;
    fs.copyFileSync(sqlitePath, archivePath);
    const archive = fs.statSync(archivePath, { bigint: true });
    const move = () => ({
      archivePath,
      artifact: {
        identity: {
          dev: String(archive.dev + 2n),
          ino: String(archive.ino),
          mtimeNs: String(archive.mtimeNs),
          size: Number(archive.size),
          sha256: createHash("sha256").update(fs.readFileSync(archivePath)).digest("hex"),
        },
        classification: "repair-original",
        reason: "pre-startup-migration-backup",
        dependencies: [],
        disposal: { state: "retained" },
      },
      kind: "database-backup",
      sourcePath: sqlitePath,
    });
    const destination = fs.statSync(sqlitePath, { bigint: true });
    return {
      agentId: "startup-migration",
      databaseIdentity: { dev: String(destination.dev + 2n), ino: String(destination.ino) },
      completedMoves: [move()],
      issues: [],
      plannedMoves: [move()],
      sqlitePath,
      storePath: sqlitePath,
      validationBeforeArchive: "passed",
    };
  });
  const manifestPath = path.join(
    resolveSessionSqliteMigrationRunsDir(env),
    `startup-migration-${backupId}.json`,
  );
  fs.mkdirSync(path.dirname(manifestPath), { recursive: true, mode: 0o700 });
  const manifest = {
    manifestVersion: 3,
    openClawVersion: "2026.10.7",
    runId: `startup-migration-${backupId}`,
    startedAt: completedAt,
    targets,
    completedAt,
  };
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  return { manifestPath, manifest };
}

it("retires originals from stored pre-reboot manifests after later destination writes", async () => {
  const now = Date.now();
  let later: string;
  {
    using clock = vi.spyOn(Date, "now");
    clock.mockReturnValue(now + 60_000);
    later = createUpdateRun({ trigger: "cli" }, { env }).runId;
  }
  await closeOpenClawStateDatabaseAsync();
  const destinations = [
    path.join(stateDir, "agents", "main", "agent", "openclaw-agent.sqlite"),
    path.join(stateDir, "agents", "openclaw", "agent", "openclaw-agent.sqlite"),
  ];
  for (const file of destinations) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    using database = new DatabaseSync(file);
    database.exec("CREATE TABLE migrated(value TEXT); INSERT INTO migrated VALUES ('migrated')");
  }
  destinations.push(resolveOpenClawStateSqlitePath(env));
  const { manifestPath, manifest } = storedPreRebootManifest(
    destinations,
    new Date(now).toISOString(),
  );
  // The Gateway keeps writing every destination after the reboot.
  for (const file of destinations.slice(0, 2)) {
    using database = new DatabaseSync(file);
    database.exec("CREATE TABLE after_reboot(value TEXT); INSERT INTO after_reboot VALUES ('x')");
  }
  finishUpdateRun(later, { status: "succeeded" }, { env });
  await closeOpenClawStateDatabaseAsync();

  const report = await retireSessionSqliteRecovery({
    env,
    preview: await inspectSessionSqliteRecovery({ cfg: {}, env }),
    readConfig: async () => ({}),
    confirm: async () => true,
  });

  const archives = manifest.targets.map((target) => target.completedMoves[0]!.archivePath);
  expect(
    archives.map((file) => {
      const item = report.artifacts.find((artifact) => artifact.path === file);
      return [item?.outcome, item?.detail];
    }),
  ).toEqual(archives.map(() => ["removed", undefined]));
  expect(archives.filter((file) => fs.existsSync(file))).toEqual([]);
  const stored = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as typeof manifest;
  // Only the remounted device and the disposal receipts change; every other stored field stays.
  const expected = structuredClone(manifest);
  for (const [index, target] of expected.targets.entries()) {
    const live = fs.statSync(target.sqlitePath, { bigint: true });
    target.databaseIdentity = { dev: String(live.dev), ino: target.databaseIdentity.ino };
    for (const key of ["plannedMoves", "completedMoves"] as const) {
      const { disposal } = stored.targets[index]![key][0]!.artifact;
      expect(disposal).toMatchObject({ state: "disposed" });
      target[key][0]!.artifact.disposal = disposal;
    }
  }
  expect(stored).toEqual(expected);
});
