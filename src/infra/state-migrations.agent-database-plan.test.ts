import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { makeTempDir } from "../../test/helpers/temp-dir.js";
import { withArtifactPreservingStateReads } from "../state/artifact-preserving-state-reads.js";
import { MEDIA_ROWS_MIGRATION_META_KEY } from "../state/openclaw-agent-db-contract.js";
import * as maintenanceLease from "../state/openclaw-agent-db-maintenance-lease.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../state/openclaw-agent-db.js";
import { resolveIncognitoOpenClawAgentSqlitePath } from "../state/openclaw-agent-db.paths.js";
import { createOpenClawDatabaseMaintenanceScope } from "../state/openclaw-state-db-async-lifecycle.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { upgradeStateOnGatewayStart } from "../state/state-upgrade-startup.js";
import { installDeletedAgentDatabaseFences } from "./agent-database-readers.js";
import { listDirectoryTreeStrictSync } from "./directory-walk.js";
import * as nodeSqlite from "./node-sqlite.js";
import { compareValidSemver } from "./semver.js";
import { readSqliteCleanCloseSeal } from "./sqlite-clean-close-seal.js";
import { retireSqliteDatabaseAdmissionForPath } from "./sqlite-database-admission.js";
import { corruptSqliteIndexKey } from "./sqlite-index-corruption.test-support.js";
import * as integrityWorker from "./sqlite-integrity-worker.js";
import { planAgentDatabaseMigration } from "./state-migrations.agent-database-plan.js";
import { migrateLegacyMediaPersistence as migrate } from "./state-migrations.media-persistence.js";
import {
  cleanupMediaPersistenceFixtures,
  createEvent,
  createLegacyDatabaseFixture,
  writeArchive,
} from "./state-migrations.media-persistence.test-support.js";
import { MEDIA_ARCHIVE_VERIFICATION_KEY } from "./state-migrations.transcript-directives-archives.js";

type Plan = Awaited<ReturnType<typeof planAgentDatabaseMigration>>;
type Fixture = { env: NodeJS.ProcessEnv; stateDir: string; databasePath: string };

const tempDirs: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  cleanupMediaPersistenceFixtures(tempDirs);
});

function sql(pathname: string, statement: string, ...params: string[]): unknown {
  using db = new (nodeSqlite.requireNodeSqlite().DatabaseSync)(pathname);
  const row = db.prepare(statement).get(...params);
  return row && Object.values(row)[0];
}

const message = { role: "user", content: "kept", MediaPath: "/media/image.png" };
const event = (id: string) => createEvent({ id, parentId: null, timestamp: 1, message });

/** A real agent database after explicit Doctor migrated it: the state a healthy install keeps. */
async function healthyInstall(): Promise<Fixture> {
  const stateDir = makeTempDir(tempDirs, "agent-db-plan-");
  const env = { OPENCLAW_STATE_DIR: stateDir };
  const databasePath = createLegacyDatabaseFixture({ env, eventsBySession: { s: [event("e1")] } });
  expect((await migrate({ env })).warnings).toEqual([]);
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
  return { env, stateDir, databasePath };
}

/**
 * Name, size, inode and mtime of every file under root. A read-only open of the shared
 * state database may add its empty WAL index; a written frame would not be empty.
 */
function fileFacts(root: string, all = false): string[] {
  return listDirectoryTreeStrictSync(root)
    .filter(({ dirent }) => dirent.isFile())
    .map(({ relativePath }) => {
      const stat = fs.statSync(path.join(root, relativePath), { bigint: true });
      return `${relativePath} ${stat.size} ${stat.ino} ${stat.mtimeNs}`;
    })
    .filter((fact) => all || !/^state\/openclaw\.sqlite-(?:shm \d+|wal 0) /u.test(fact))
    .toSorted();
}

// Windows rewrites modes on every pass; before SQLite 3.46 the pass analyzes every table.
const alwaysWork = [
  ...(process.platform === "win32" ? [["permissions", "work"]] : []),
  ...((compareValidSemver(String(sql(":memory:", "SELECT sqlite_version()")), "3.46.0") ?? -1) < 0
    ? [["planner-statistics", "work"]]
    : []),
];

async function conditionsOf(env: NodeJS.ProcessEnv) {
  const plan = await planAgentDatabaseMigration({ env, configuredAgentDatabaseTargets: [] });
  expect(plan.databases).toHaveLength(1);
  return { plan, conditions: plan.databases[0]!.conditions };
}

it("plans a healthy database as none, and a Doctor rerun leaves it unleased and untouched", async () => {
  const { env, stateDir, databasePath } = await healthyInstall();
  const agentDir = path.join(stateDir, "agents");
  const agentFiles = fileFacts(agentDir, true);
  // The first read closes and seals the earlier pass's shared state handle.
  await planAgentDatabaseMigration({ env, configuredAgentDatabaseTargets: [] });
  const before = fileFacts(stateDir);
  const opens = vi.spyOn(nodeSqlite, "openNodeSqliteDatabase");
  const leases = vi.spyOn(maintenanceLease, "withAgentDatabaseMaintenanceLease");

  const { plan, conditions } = await conditionsOf(env);
  expect(plan.pending).toBe(alwaysWork.length > 0 ? "work" : "none");
  expect(plan.discovery).toEqual({ discovery: "none", "misplaced-copies": "none" });
  expect(Object.entries(conditions).filter(([, answer]) => answer !== "none")).toEqual(alwaysWork);
  // Every condition the writing pass acts on was read, not skipped.
  expect(Object.keys(conditions)).toHaveLength(18);
  if (alwaysWork.length === 0) {
    const reported: string[][] = [];
    const report = (targets: readonly { path: string }[]) =>
      reported.push(targets.map((t) => t.path));
    expect(
      await migrate({ env, onAdmittedTargets: report, onPreparedRepairTargets: report }),
    ).toEqual({ changes: [], warnings: [] });
    expect(leases).not.toHaveBeenCalled();
    // Later Doctor steps still receive the database as admitted and repair-ready.
    expect(reported).toEqual([[databasePath], [databasePath]]);
  }
  expect(opens.mock.calls.filter(([, options]) => options?.readOnly !== true)).toEqual([]);
  expect(fileFacts(stateDir)).toEqual(before);
  expect(fileFacts(agentDir, true)).toEqual(agentFiles);
});

it.skipIf(alwaysWork.length > 0).each([true, false])(
  "checks integrity during boot migration only if proof is missing (sealed: %s)",
  async (sealed) => {
    const { env, stateDir, databasePath } = await healthyInstall();
    const maintenance = createOpenClawDatabaseMaintenanceScope({ sqliteIntegrityCheck: "full" });
    try {
      maintenance.run(() => openOpenClawAgentDatabase({ agentId: "main", env }));
      closeOpenClawAgentDatabasesForTest();
    } finally {
      await maintenance.close();
    }
    closeOpenClawStateDatabaseForTest();
    retireSqliteDatabaseAdmissionForPath(databasePath);
    const sealPath = `${databasePath}.seal`;
    expect(
      readSqliteCleanCloseSeal(databasePath, fs.statSync(databasePath, { bigint: true })),
    ).toBeDefined();
    if (!sealed) {
      fs.unlinkSync(sealPath);
    }
    const configPath = path.join(stateDir, "openclaw.json");
    fs.writeFileSync(
      configPath,
      JSON.stringify({ gateway: { mode: "local" }, plugins: { enabled: false } }),
    );
    const legacy = path.join(stateDir, "tui", "last-session.json");
    fs.mkdirSync(path.dirname(legacy));
    fs.writeFileSync(
      legacy,
      JSON.stringify({
        terminal: { sessionKey: "agent:main:tui-123", updatedAt: 100 },
      }),
    );

    const check = vi.spyOn(integrityWorker, "assertSqliteIntegrityInWorker");
    await upgradeStateOnGatewayStart({ ...env, OPENCLAW_CONFIG_PATH: configPath }, () => true);

    expect(fs.existsSync(legacy)).toBe(false);
    expect(check.mock.calls.filter(([pathname]) => pathname === databasePath)).toHaveLength(
      sealed ? 0 : 1,
    );
    if (sealed) {
      expect(
        readSqliteCleanCloseSeal(databasePath, fs.statSync(databasePath, { bigint: true })),
      ).toBeDefined();
    }
  },
);

const archiveFile = (f: Fixture) =>
  path.join(f.stateDir, "agents/main/sessions/legacy.jsonl.deleted.2026-07-24T01-02-03.000Z");
const firstIndex =
  "SELECT name FROM sqlite_schema WHERE type = 'index' AND tbl_name = 'session_nodes'";
let dropped = "";
/** Each condition: create its state in a real database; `repaired` reads 1 once the pass fixed it. */
const guards: Array<{
  condition: keyof Plan["databases"][number]["conditions"];
  create: (f: Fixture) => void;
  repaired: (f: Fixture) => unknown;
}> = [
  {
    condition: "entry-validity",
    create: (f) => sql(f.databasePath, "UPDATE session_nodes SET entry_valid = 0"),
    repaired: (f) =>
      sql(f.databasePath, "SELECT NOT EXISTS (SELECT 1 FROM session_nodes WHERE entry_valid = 0)"),
  },
  {
    condition: "transcript-archives",
    create: (f) =>
      sql(
        f.databasePath,
        "INSERT INTO schema_meta (meta_key, role, agent_id, schema_version, app_version, created_at, updated_at) VALUES (?, 'agent', 'main', 1, 'drifted', 1, 1) ON CONFLICT(meta_key) DO UPDATE SET app_version = 'drifted'",
        MEDIA_ARCHIVE_VERIFICATION_KEY,
      ),
    repaired: (f) =>
      sql(
        f.databasePath,
        "SELECT app_version = '' FROM schema_meta WHERE meta_key = ?",
        MEDIA_ARCHIVE_VERIFICATION_KEY,
      ),
  },
  {
    condition: "planner-statistics",
    create: (f) => sql(f.databasePath, "DELETE FROM sqlite_stat1"),
    repaired: (f) => sql(f.databasePath, "SELECT count(*) > 0 FROM sqlite_stat1"),
  },
  {
    condition: "schema-metadata",
    create: (f) =>
      sql(
        f.databasePath,
        "UPDATE schema_meta SET app_version = '0.0.1' WHERE meta_key = 'primary'",
      ),
    repaired: (f) =>
      sql(
        f.databasePath,
        "SELECT app_version <> '0.0.1' FROM schema_meta WHERE meta_key = 'primary'",
      ),
  },
  {
    condition: "canonical-indexes",
    create: (f) => {
      dropped = String(sql(f.databasePath, `${firstIndex} AND sql IS NOT NULL ORDER BY name`));
      sql(f.databasePath, `DROP INDEX ${dropped}`);
    },
    repaired: (f) =>
      sql(f.databasePath, "SELECT count(*) FROM sqlite_schema WHERE name = ?", dropped),
  },
  {
    condition: "integrity",
    create: (f) => {
      const key = String(sql(f.databasePath, "SELECT session_key FROM session_nodes"));
      const index = String(
        sql(f.databasePath, `${firstIndex} AND sql LIKE '%(session_key)%' ORDER BY name`),
      );
      corruptSqliteIndexKey(f.databasePath, index, key, `${key.slice(0, -1)}~`);
    },
    repaired: (f) =>
      sql(f.databasePath, "SELECT integrity_check = 'ok' FROM pragma_integrity_check"),
  },
  {
    condition: "schema-additive",
    create: (f) => sql(f.databasePath, "DROP TABLE session_reactions"),
    repaired: (f) =>
      sql(f.databasePath, "SELECT count(*) FROM sqlite_schema WHERE name = 'session_reactions'"),
  },
  {
    condition: "media-rows",
    create: (f) =>
      sql(
        f.databasePath,
        "DELETE FROM schema_meta WHERE meta_key = ?",
        MEDIA_ROWS_MIGRATION_META_KEY,
      ),
    repaired: (f) =>
      sql(
        f.databasePath,
        "SELECT count(*) FROM schema_meta WHERE meta_key = ?",
        MEDIA_ROWS_MIGRATION_META_KEY,
      ),
  },
  {
    condition: "permissions",
    create: (f) => fs.chmodSync(f.databasePath, 0o644),
    repaired: (f) => Number((fs.statSync(f.databasePath).mode & 0o777) === 0o600),
  },
  {
    condition: "registry",
    create: (f) => sql(resolveOpenClawStateSqlitePath(f.env), "DELETE FROM agent_databases"),
    repaired: (f) =>
      sql(
        resolveOpenClawStateSqlitePath(f.env),
        "SELECT count(*) FROM agent_databases WHERE agent_id = 'main'",
      ),
  },
  {
    condition: "archive-files",
    create: (f) => writeArchive(archiveFile(f), [event("a1")], false),
    repaired: (f) => Number(!fs.readFileSync(archiveFile(f), "utf8").includes('"MediaPath"')),
  },
];

// A condition with work on every pass stops the plan before its whole-store reads
// (archives, archive files, integrity); POSIX mode bits are no fixture on Windows.
const unread = new Set(
  alwaysWork.length > 0
    ? ["transcript-archives", "archive-files", "integrity", ...alwaysWork.map(([c]) => c)]
    : [],
);
it.each(guards.filter((guard) => !unread.has(guard.condition)))(
  "reports $condition as work and the unchanged pass repairs it",
  async (guard) => {
    const fixture = await healthyInstall();
    guard.create(fixture);
    expect((await conditionsOf(fixture.env)).conditions[guard.condition]).toBe("work");

    const leases = vi.spyOn(maintenanceLease, "withAgentDatabaseMaintenanceLease");
    await migrate({ env: fixture.env });
    expect(leases).toHaveBeenCalled();
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
    expect(guard.repaired(fixture)).toBe(1);
    expect((await conditionsOf(fixture.env)).conditions[guard.condition]).toBe("none");
  },
);

it("plans nothing where store reads would be served from copies", async () => {
  const { env } = await healthyInstall();
  const opens = vi.spyOn(nodeSqlite, "openNodeSqliteDatabase");
  const plan = await withArtifactPreservingStateReads(
    () => planAgentDatabaseMigration({ env, configuredAgentDatabaseTargets: [] }),
    { agentDatabases: true },
  );
  expect(plan).toEqual({
    discovery: { discovery: "undecidable" },
    databases: [],
    pending: "undecidable",
  });
  expect(opens).not.toHaveBeenCalled();
});

it("reports an older schema version as work", async () => {
  const env = { OPENCLAW_STATE_DIR: makeTempDir(tempDirs, "agent-db-plan-old-") };
  createLegacyDatabaseFixture({ env, eventsBySession: { s: [event("e")] } });
  closeOpenClawAgentDatabasesForTest();
  const { plan, conditions } = await conditionsOf(env);
  expect([conditions["schema-version"], plan.pending]).toEqual(["work", "work"]);
});

it("answers undecidable for a store the read-only reader cannot vouch for", async () => {
  const { env, databasePath } = await healthyInstall();
  // A store whose agent was deleted in this process reads as missing.
  installDeletedAgentDatabaseFences([[path.resolve(databasePath), "main"]]);
  try {
    const { plan, conditions } = await conditionsOf(env);
    expect(conditions["schema-version"]).toBe("undecidable");
    expect(plan.pending).toBe(alwaysWork.length > 0 ? "work" : "undecidable");
  } finally {
    installDeletedAgentDatabaseFences([]);
  }
  // A configured incognito store is a target, but the reader never vouches for it.
  const incognitoPath = resolveIncognitoOpenClawAgentSqlitePath({ agentId: "main", env });
  fs.copyFileSync(databasePath, incognitoPath);
  const configured = await planAgentDatabaseMigration({
    env,
    configuredAgentDatabaseTargets: [{ agentId: "main", path: incognitoPath }],
  });
  expect(configured.databases.map((d) => [d.path, d.conditions["schema-version"]])).toEqual(
    expect.arrayContaining([
      [incognitoPath, "undecidable"],
      [databasePath, "none"],
    ]),
  );
  expect(configured.pending).not.toBe("none");
});
