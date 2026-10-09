import "../test-utils/prepare-compiled-subprocesses.js";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
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
  const db = new DatabaseSync(filename);
  try {
    db.exec(
      "PRAGMA user_version=1; CREATE TABLE payload(value TEXT); INSERT INTO payload VALUES('keep');",
    );
  } finally {
    db.close();
  }
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

async function owned<T>(f: ReturnType<typeof fixture>, run: () => Promise<T> | T) {
  const owner = acquireGatewayStateOwner({ databasePath: f.shared });
  const scope = createOpenClawDatabaseMaintenanceScope({
    schemaMaintenance: true,
    assertOwnerCurrent: owner.assertCurrent,
    assertDatabaseAccess: owner.assertDatabaseAccess,
  });
  try {
    return await scope.run(run);
  } finally {
    await scope.close();
    owner.release();
  }
}

it.each(["0", "1"])(
  "omits only disposable core migration backups for shipped flag %s",
  async (flag) => {
    const f = fixture();
    f.env.OPENCLAW_UPDATE_IN_PROGRESS = flag;
    const foreignRoot = fs.realpathSync(dirs.make("doctor-foreign-core-"));
    const foreign = path.join(foreignRoot, "agent.sqlite");
    seed(foreign);
    const before = [f.shared, f.agent, foreign].map((file) => fs.readFileSync(file));
    await owned(f, () =>
      backupDoctorMigrationDatabases({
        env: f.env,
        pendingDatabasePaths: [f.agent, foreign],
        databasePaths: [f.agent, foreign],
      }),
    );
    expect(f.backups(f.shared)).toEqual([]);
    expect(f.backups(f.agent)).toEqual([]);
    expect(f.backups(foreign)).toHaveLength(1);
    expect([f.shared, f.agent, foreign].map((file) => fs.readFileSync(file))).toEqual(before);
    const captured = new DatabaseSync(path.join(foreignRoot, f.backups(foreign)[0]!), {
      readOnly: true,
    });
    try {
      expect(captured.prepare("SELECT value FROM payload").all()).toEqual([{ value: "keep" }]);
    } finally {
      captured.close();
    }
  },
);

it.each(["standalone", "flag-only", "foreign-temp"])(
  "retains ordinary backups for %s Doctor",
  async (kind) => {
    const f = fixture();
    const env =
      kind === "standalone"
        ? { OPENCLAW_STATE_DIR: f.root }
        : kind === "flag-only"
          ? { OPENCLAW_STATE_DIR: f.root, OPENCLAW_UPDATE_IN_PROGRESS: "1" }
          : { ...f.env, TMPDIR: path.dirname(f.root) };
    await owned(f, () =>
      backupDoctorMigrationDatabases({
        env,
        pendingDatabasePaths: [f.agent],
        databasePaths: [f.agent],
      }),
    );
    expect(f.backups(f.shared)).toHaveLength(1);
    expect(f.backups(f.agent)).toHaveLength(1);
  },
);

it.each(["symlink", "hardlink", "wal-symlink", "journal-hardlink"])(
  "does not admit a %s family as disposable",
  async (kind) => {
    const f = fixture();
    const foreign = path.join(fs.realpathSync(dirs.make("doctor-alias-source-")), "foreign.sqlite");
    seed(foreign);
    const before = fs.readFileSync(foreign);
    const target =
      kind === "wal-symlink"
        ? `${f.agent}-wal`
        : kind === "journal-hardlink"
          ? `${f.agent}-journal`
          : f.agent;
    if (target === f.agent) {
      fs.unlinkSync(target);
    }
    if (kind.includes("symlink")) {
      fs.symlinkSync(foreign, target);
    } else {
      fs.linkSync(foreign, target);
    }
    await owned(f, () => {
      const coverage = createDoctorRehearsalDatabaseCoverage(f.env)!;
      expect(coverage.admit([f.agent])).toEqual([]);
      expect(coverage.excludes(target)).toBe(false);
    });
    expect(fs.readFileSync(foreign)).toEqual(before);
  },
);

it.each(["dev", "ino"] as const)(
  "requires a known bigint %s before omitting an image",
  async (field) => {
    const f = fixture();
    await owned(f, () => {
      const lstat = fs.lstatSync;
      vi.spyOn(fs, "lstatSync").mockImplementation((...args: Parameters<typeof fs.lstatSync>) => {
        const stat = lstat(...args);
        if (String(args[0]) === f.agent && stat && typeof stat.ino === "bigint") {
          return new Proxy(stat, {
            get: (target, key) => (key === field ? 0n : Reflect.get(target, key)),
          });
        }
        return stat;
      });
      syncBuiltinESMExports();
      const coverage = createDoctorRehearsalDatabaseCoverage(f.env)!;
      expect(coverage.admit([f.agent])).toEqual([]);
      expect(coverage.excludes(f.agent)).toBe(false);
    });
  },
);

it("invalidates admitted coverage on physical replacement or owner release", async () => {
  const f = fixture();
  expect(createDoctorRehearsalDatabaseCoverage(f.env)).toBeUndefined();
  let coverage: ReturnType<typeof createDoctorRehearsalDatabaseCoverage>;
  await owned(f, () => {
    coverage = createDoctorRehearsalDatabaseCoverage(f.env)!;
    expect(coverage.admit([f.agent])).toEqual([f.agent]);
    fs.renameSync(f.agent, `${f.agent}.held`);
    seed(f.agent);
    expect(coverage.assertCurrent).toThrow(/identity changed/);
    fs.unlinkSync(f.agent);
    fs.renameSync(`${f.agent}.held`, f.agent);
    coverage.assertCurrent();
  });
  expect(coverage!.assertCurrent).toThrow(/closed|current/);
});

it.skipIf(process.platform === "win32")(
  "does not admit a public POSIX rehearsal root",
  async () => {
    const f = fixture();
    fs.chmodSync(f.root, 0o755);
    await owned(f, () => {
      expect(createDoctorRehearsalDatabaseCoverage(f.env)).toBeUndefined();
    });
  },
);

it("invalidates coverage when an absent companion appears", async () => {
  const f = fixture();
  await owned(f, () => {
    const coverage = createDoctorRehearsalDatabaseCoverage(f.env)!;
    expect(coverage.admit([f.agent])).toEqual([f.agent]);
    fs.writeFileSync(`${f.agent}-journal`, "new journal");
    expect(coverage.assertCurrent).toThrow(/identity changed/);
  });
});

it.each([false, true])(
  "requires canonical discovery before excluding a migration alias: %s",
  async (discovered) => {
    const f = fixture();
    const alias = path.join(f.root, "agent-alias.sqlite");
    fs.symlinkSync(f.agent, alias);
    const before = fs.readFileSync(f.agent);
    await owned(f, () =>
      backupDoctorMigrationDatabases({
        env: f.env,
        pendingDatabasePaths: [alias],
        databasePaths: discovered ? [alias, f.agent] : [alias],
      }),
    );
    expect(f.backups(f.agent)).toHaveLength(discovered ? 0 : 1);
    expect(fs.readFileSync(f.agent)).toEqual(before);
    if (!discovered) {
      const captured = new DatabaseSync(path.join(path.dirname(f.agent), f.backups(f.agent)[0]!), {
        readOnly: true,
      });
      try {
        expect(captured.prepare("SELECT value FROM payload").all()).toEqual([{ value: "keep" }]);
      } finally {
        captured.close();
      }
    }
  },
);

it("invalidates an excluded alias when its target changes", async () => {
  const f = fixture();
  const alias = path.join(f.root, "agent-alias.sqlite");
  fs.symlinkSync(f.agent, alias);
  await owned(f, () => {
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

it.each(["-wal", "-shm", "-journal"])(
  "retains ordinary backup protection for a directory at %s",
  async (suffix) => {
    const f = fixture();
    fs.mkdirSync(`${f.agent}${suffix}`);
    const before = fs.readFileSync(f.agent);
    await owned(f, async () => {
      const coverage = createDoctorRehearsalDatabaseCoverage(f.env)!;
      expect(coverage.admit([f.agent])).toEqual([]);
      const backup = backupDoctorMigrationDatabases({
        env: f.env,
        pendingDatabasePaths: [f.agent],
        databasePaths: [f.agent],
      });
      if (suffix === "-shm") {
        // The ordinary snapshot owner can preserve the closed database without SHM.
        await backup;
        expect(f.backups(f.agent)).toHaveLength(1);
        const captured = new DatabaseSync(
          path.join(path.dirname(f.agent), f.backups(f.agent)[0]!),
          {
            readOnly: true,
          },
        );
        try {
          expect(captured.prepare("SELECT value FROM payload").all()).toEqual([{ value: "keep" }]);
        } finally {
          captured.close();
        }
      } else {
        await expect(backup).rejects.toThrow();
        expect(f.backups(f.agent)).toEqual([]);
      }
    });
    expect(fs.readFileSync(f.agent)).toEqual(before);
  },
);
