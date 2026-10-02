import "../test-utils/prepare-compiled-subprocesses.js";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it, vi, type Mock } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { acquireGatewayStateOwner } from "../infra/gateway-state-owner.js";
import { buildUpdateRehearsalPathEnv } from "../infra/update-rehearsal-paths.js";
import { createOpenClawDatabaseMaintenanceScope } from "../state/openclaw-state-db-async-lifecycle.js";
import { backupDoctorMigrationDatabases } from "./doctor-migration-backup.js";
import { createDoctorRehearsalDatabaseCoverage } from "./doctor-rehearsal-databases.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => {
  vi.restoreAllMocks();
  syncBuiltinESMExports();
});

function seed(filename: string) {
  fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
  using db = new DatabaseSync(filename);
  db.exec(
    "PRAGMA user_version=1; CREATE TABLE payload(value TEXT); INSERT INTO payload VALUES('keep');",
  );
}

function fixture() {
  const root = fs.realpathSync(dirs.make("doctor-disposable-core-"));
  const shared = path.join(root, "state", "openclaw.sqlite");
  const agent = path.join(root, "agents", "main", "agent", "openclaw-agent.sqlite");
  seed(shared);
  seed(agent);
  const env = {
    ...buildUpdateRehearsalPathEnv(root),
    OPENCLAW_UPDATE_IN_PROGRESS: "0",
    OPENCLAW_SERVICE_REPAIR_POLICY: "external",
    OPENCLAW_UPDATE_PARENT_ALLOWS_GATEWAY_SERVICE_REPAIR: "0",
    OPENCLAW_UPDATE_PARENT_ALLOWS_GATEWAY_ACTIVATION: "0",
  };
  const backups = (filename: string) =>
    fs
      .readdirSync(path.dirname(filename))
      .filter(
        (name) =>
          name.startsWith(path.basename(filename) + ".pre-startup-migration-") &&
          name.endsWith(".bak"),
      );
  return { root, shared, agent, env, backups };
}

async function owned<T>(run: (admission: Mock<() => void>) => Promise<T> | T) {
  const owner = acquireGatewayStateOwner({ databasePath: f.shared });
  const scope = createOpenClawDatabaseMaintenanceScope({
    schemaMaintenance: true,
    assertOwnerCurrent: vi.spyOn(owner, "assertCurrent"),
    assertDatabaseAccess: owner.assertDatabaseAccess,
  });
  try {
    return await scope.run(() => run(vi.mocked(owner.assertCurrent)));
  } finally {
    await scope.close();
    owner.release();
  }
}

function backup(paths = [f.agent], env: NodeJS.ProcessEnv = f.env, discovered = paths) {
  return backupDoctorMigrationDatabases({
    env,
    pendingDatabasePaths: paths,
    databasePaths: discovered,
  });
}

function expectBackup(filename: string) {
  const backups = f.backups(filename);
  expect(backups).toHaveLength(1);
  using captured = new DatabaseSync(path.join(path.dirname(filename), backups[0]!), {
    readOnly: true,
  });
  expect(captured.prepare("SELECT value FROM payload").all()).toEqual([{ value: "keep" }]);
}

let f: ReturnType<typeof fixture>;
beforeEach(() => {
  f = fixture();
});

it("omits only disposable core migration backups for the shipped flag", async () => {
  f.env.OPENCLAW_UPDATE_IN_PROGRESS = "1";
  const foreignRoot = fs.realpathSync(dirs.make("doctor-foreign-core-"));
  const foreign = path.join(foreignRoot, "agent.sqlite");
  seed(foreign);
  const before = [f.shared, f.agent, foreign].map((file) => fs.readFileSync(file));
  await owned(() => backup([f.agent, foreign]));
  expect(f.backups(f.shared)).toEqual([]);
  expect(f.backups(f.agent)).toEqual([]);
  expect([f.shared, f.agent, foreign].map((file) => fs.readFileSync(file))).toEqual(before);
  expectBackup(foreign);
});

it.each(["flag-only", "foreign-temp"])("retains ordinary backups for %s Doctor", async (kind) => {
  const env =
    kind === "flag-only"
      ? { OPENCLAW_STATE_DIR: f.root, OPENCLAW_UPDATE_IN_PROGRESS: "1" }
      : { ...f.env, TMPDIR: path.dirname(f.root) };
  await owned(() => backup([f.agent], env));
  expect(f.backups(f.shared)).toHaveLength(1);
  expect(f.backups(f.agent)).toHaveLength(1);
});

it.each(["symlink", "hardlink"])("does not admit a %s family as disposable", async (kind) => {
  const foreign = path.join(fs.realpathSync(dirs.make("doctor-alias-source-")), "foreign.sqlite");
  seed(foreign);
  const before = fs.readFileSync(foreign);
  const target = f.agent;
  fs.unlinkSync(target);
  if (kind === "symlink") {
    fs.symlinkSync(foreign, target);
  } else {
    fs.linkSync(foreign, target);
  }
  await owned(() => {
    const coverage = createDoctorRehearsalDatabaseCoverage(f.env)!;
    expect(coverage.admit([f.agent])).toEqual([]);
    expect(coverage.excludes(target)).toBe(false);
  });
  expect(fs.readFileSync(foreign)).toEqual(before);
});

it("requires a known bigint inode before omitting an image", async () => {
  await owned(() => {
    const lstat = fs.lstatSync;
    vi.spyOn(fs, "lstatSync").mockImplementation((...args: Parameters<typeof fs.lstatSync>) => {
      const stat = lstat(...args);
      if (String(args[0]) === f.agent && stat && typeof stat.ino === "bigint") {
        return new Proxy(stat, {
          get: (target, key) => (key === "ino" ? 0n : Reflect.get(target, key)),
        });
      }
      return stat;
    });
    syncBuiltinESMExports();
    const coverage = createDoctorRehearsalDatabaseCoverage(f.env)!;
    expect(coverage.admit([f.agent])).toEqual([]);
    expect(coverage.excludes(f.agent)).toBe(false);
  });
});

it.each(["replacement", "companion"])("revokes %s coverage", async (kind) => {
  expect(createDoctorRehearsalDatabaseCoverage(f.env)).toBeUndefined();
  let coverage: ReturnType<typeof createDoctorRehearsalDatabaseCoverage>;
  await owned((admission) => {
    admission.mockClear();
    coverage = createDoctorRehearsalDatabaseCoverage(f.env)!;
    expect(coverage.admit([f.agent])).toEqual([f.agent]);
    coverage.assertCurrent();
    expect(admission).toHaveBeenCalledTimes(4);
    if (kind === "replacement") {
      fs.renameSync(f.agent, `${f.agent}.held`);
      seed(f.agent);
    } else {
      fs.writeFileSync(`${f.agent}-journal`, "new journal");
    }
    expect(coverage.assertCurrent).toThrow(/identity changed/);
    fs.rmSync(kind === "replacement" ? f.agent : `${f.agent}-journal`);
    if (kind === "replacement") {
      fs.renameSync(`${f.agent}.held`, f.agent);
    }
    coverage.assertCurrent();
  });
  expect(coverage!.assertCurrent).toThrow(/closed|current/);
});

it.skipIf(process.platform === "win32")(
  "does not admit a public POSIX rehearsal root",
  async () => {
    fs.chmodSync(f.root, 0o755);
    await owned(() => {
      expect(createDoctorRehearsalDatabaseCoverage(f.env)).toBeUndefined();
    });
  },
);

it.each([false, true])(
  "requires canonical discovery before excluding a migration alias: %s",
  async (discovered) => {
    const alias = path.join(f.root, "agent-alias.sqlite");
    fs.symlinkSync(f.agent, alias);
    const before = fs.readFileSync(f.agent);
    await owned(() => backup([alias], f.env, discovered ? [alias, f.agent] : [alias]));
    expect(f.backups(f.agent)).toHaveLength(discovered ? 0 : 1);
    expect(fs.readFileSync(f.agent)).toEqual(before);
    if (!discovered) {
      expectBackup(f.agent);
    }
  },
);

it("invalidates an excluded alias when its target changes", async () => {
  const alias = path.join(f.root, "agent-alias.sqlite");
  fs.symlinkSync(f.agent, alias);
  await owned(() => {
    const coverage = createDoctorRehearsalDatabaseCoverage(f.env)!;
    coverage.admit([f.agent, f.shared]);
    expect(coverage.excludes(alias)).toBe(true);
    fs.unlinkSync(alias);
    fs.symlinkSync(f.shared, alias);
    expect(() => {
      coverage.excludes(alias);
      coverage.assertCurrent();
    }).toThrow(/alias changed/);
  });
});

it("retains ordinary backup protection for a directory at -shm", async () => {
  fs.mkdirSync(`${f.agent}-shm`);
  const before = fs.readFileSync(f.agent);
  await owned(async () => {
    const coverage = createDoctorRehearsalDatabaseCoverage(f.env)!;
    expect(coverage.admit([f.agent])).toEqual([]);
    await backup();
    expectBackup(f.agent);
  });
  expect(fs.readFileSync(f.agent)).toEqual(before);
});
