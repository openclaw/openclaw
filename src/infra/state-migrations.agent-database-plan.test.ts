import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeTempDir } from "../../test/helpers/temp-dir.js";
import { MEDIA_ROWS_MIGRATION_META_KEY } from "../state/openclaw-agent-db-contract.js";
import * as maintenanceLease from "../state/openclaw-agent-db-maintenance-lease.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import { resolveIncognitoOpenClawAgentSqlitePath } from "../state/openclaw-agent-db.paths.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { installDeletedAgentDatabaseFences } from "./agent-database-readers.js";
import * as nodeSqlite from "./node-sqlite.js";
import { requireNodeSqlite } from "./node-sqlite.js";
import { corruptSqliteIndexKey } from "./sqlite-index-corruption.test-support.js";
import { planAgentDatabaseMigration } from "./state-migrations.agent-database-plan.js";
import { migrateLegacyMediaPersistence as migrate } from "./state-migrations.media-persistence.js";
import {
  cleanupMediaPersistenceFixtures,
  createEvent,
  createLegacyDatabaseFixture,
  writeArchive,
} from "./state-migrations.media-persistence.test-support.js";
import { MEDIA_ARCHIVE_VERIFICATION_KEY } from "./state-migrations.transcript-directives-archives.js";

type AgentDatabaseCondition = keyof Awaited<
  ReturnType<typeof planAgentDatabaseMigration>
>["databases"][number]["conditions"];

const tempDirs: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  cleanupMediaPersistenceFixtures(tempDirs);
});

const message = { role: "user", content: "kept", MediaPath: "/media/image.png" };

/** A real agent database after explicit Doctor migrated it: the state a healthy install keeps. */
async function healthyInstall() {
  const env = { OPENCLAW_STATE_DIR: makeTempDir(tempDirs, "agent-db-plan-") };
  const databasePath = createLegacyDatabaseFixture({
    env,
    eventsBySession: {
      "session-a": [createEvent({ id: "e1", parentId: null, timestamp: 1, message })],
    },
  });
  expect((await migrate({ env })).warnings).toEqual([]);
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
  return { env, databasePath };
}

const writable = (pathname: string, run: (db: import("node:sqlite").DatabaseSync) => void) => {
  const db = new (requireNodeSqlite().DatabaseSync)(pathname);
  try {
    run(db);
  } finally {
    db.close();
  }
};

/**
 * Names, sizes, inodes and mtimes of every file the state directory holds. A read-only
 * open of the shared state database may add its empty WAL index; a written frame would not be empty.
 */
function fileFacts(root: string): string[] {
  return allFileFacts(root).filter(
    (fact) => !/^state\/openclaw\.sqlite-(?:shm \d+|wal 0) /u.test(fact),
  );
}

function allFileFacts(root: string): string[] {
  const facts: string[] = [];
  const visit = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        visit(full);
        continue;
      }
      const stat = fs.statSync(full, { bigint: true });
      facts.push(`${path.relative(root, full)} ${stat.size} ${stat.ino} ${stat.mtimeNs}`);
    }
  };
  visit(root);
  return facts.toSorted();
}

// Windows has no POSIX modes; the permission repair rewrites them on every pass.
const windows = process.platform === "win32";

const conditionsOf = async (env: NodeJS.ProcessEnv) => {
  const plan = await planAgentDatabaseMigration({ env, configuredAgentDatabaseTargets: [] });
  expect(plan.databases).toHaveLength(1);
  return { plan, conditions: plan.databases[0]!.conditions };
};

describe("agent database migration plan", () => {
  it("answers none for every condition of a healthy database and changes no file", async () => {
    const { env } = await healthyInstall();
    const agentDir = path.join(env.OPENCLAW_STATE_DIR, "agents");
    const agentFiles = allFileFacts(agentDir);
    // The first read closes and seals the earlier pass's shared state handle.
    await planAgentDatabaseMigration({ env, configuredAgentDatabaseTargets: [] });
    expect(allFileFacts(agentDir)).toEqual(agentFiles);
    const before = fileFacts(env.OPENCLAW_STATE_DIR);
    const writes = vi.spyOn(nodeSqlite, "openNodeSqliteDatabase");

    const { plan, conditions } = await conditionsOf(env);

    expect(plan.pending).toBe(windows ? "work" : "none");
    expect(plan.discovery).toEqual({ discovery: "none", "misplaced-copies": "none" });
    expect(Object.entries(conditions).filter(([, answer]) => answer !== "none")).toEqual(
      windows ? [["permissions", "work"]] : [],
    );
    // Every condition the writing pass acts on was read, not skipped.
    expect(Object.keys(conditions).toSorted()).toEqual(
      [
        "engine",
        "schema-version",
        "schema-owner",
        "schema-additive",
        "entry-validity",
        "schema-metadata",
        "canonical-indexes",
        "runtime-schema",
        "integrity",
        "quarantine",
        "permissions",
        "registry",
        "media-rows",
        "entry-state-preparation",
        "transcript-archives",
        "archive-files",
        "planner-statistics",
        "cold-navigation",
      ].toSorted(),
    );
    expect(
      writes.mock.calls.filter(([, options]) => options?.readOnly !== true).map(([p]) => p),
    ).toEqual([]);
    expect(fileFacts(env.OPENCLAW_STATE_DIR)).toEqual(before);
  });

  // On Windows the permission repair always has work, so no database is ever unchanged;
  // the case above covers that answer.
  it.skipIf(windows)(
    "leaves a healthy database unleased, unopened for writing and its files untouched on a Doctor rerun",
    async () => {
      const { env, databasePath } = await healthyInstall();
      const agentDir = path.join(env.OPENCLAW_STATE_DIR, "agents");
      const agentFiles = allFileFacts(agentDir);
      // Settle the earlier pass's shared state handle, which a later read closes and seals.
      await planAgentDatabaseMigration({ env, configuredAgentDatabaseTargets: [] });
      const before = fileFacts(env.OPENCLAW_STATE_DIR);
      const leases = vi.spyOn(maintenanceLease, "withAgentDatabaseMaintenanceLease");
      const opens = vi.spyOn(nodeSqlite, "openNodeSqliteDatabase");
      let admitted: string[] = [];
      let prepared: string[] = [];

      const result = await migrate({
        env,
        onAdmittedTargets: (targets) => (admitted = targets.map((target) => target.path)),
        onPreparedRepairTargets: (targets) => (prepared = targets.map((target) => target.path)),
      });

      expect(result).toEqual({ changes: [], warnings: [] });
      expect(leases).not.toHaveBeenCalled();
      expect(
        opens.mock.calls.filter(([p, options]) => p === databasePath && options?.readOnly !== true),
      ).toEqual([]);
      // Later Doctor steps still receive the database as admitted and repair-ready.
      expect(admitted).toEqual([databasePath]);
      expect(prepared).toEqual([databasePath]);
      expect(fileFacts(env.OPENCLAW_STATE_DIR)).toEqual(before);
      // The agent database family, its clean-close seal included, is untouched throughout.
      expect(allFileFacts(agentDir)).toEqual(agentFiles);
    },
  );

  const stateDatabase = (env: NodeJS.ProcessEnv) => resolveOpenClawStateSqlitePath(env);
  const guards: Array<{
    condition: AgentDatabaseCondition;
    create: (fixture: { env: NodeJS.ProcessEnv; databasePath: string }) => void;
    repaired: (fixture: { env: NodeJS.ProcessEnv; databasePath: string }) => unknown;
    expected: unknown;
  }> = [
    {
      condition: "entry-validity",
      create: ({ databasePath }) =>
        writable(databasePath, (db) => {
          db.exec("UPDATE session_nodes SET entry_valid = 0");
        }),
      repaired: ({ databasePath }) =>
        readOne(databasePath, "SELECT count(*) AS n FROM session_nodes WHERE entry_valid = 0"),
      expected: { n: 0 },
    },
    {
      condition: "transcript-archives",
      create: ({ databasePath }) =>
        writable(databasePath, (db) => {
          db.prepare(
            "INSERT INTO schema_meta (meta_key, role, agent_id, schema_version, app_version, created_at, updated_at) VALUES (?, 'agent', 'main', 1, 'drifted', 1, 1) ON CONFLICT(meta_key) DO UPDATE SET app_version = 'drifted'",
          ).run(MEDIA_ARCHIVE_VERIFICATION_KEY);
        }),
      repaired: ({ databasePath }) =>
        readOne(databasePath, "SELECT app_version FROM schema_meta WHERE meta_key = ?", [
          MEDIA_ARCHIVE_VERIFICATION_KEY,
        ]),
      expected: { app_version: "" },
    },
    {
      condition: "planner-statistics",
      create: ({ databasePath }) =>
        writable(databasePath, (db) => {
          db.exec("DELETE FROM sqlite_stat1");
        }),
      repaired: ({ databasePath }) =>
        (
          readOne(databasePath, "SELECT count(*) > 0 AS analyzed FROM sqlite_stat1") as {
            analyzed: number;
          }
        ).analyzed,
      expected: 1,
    },
    {
      condition: "schema-metadata",
      create: ({ databasePath }) =>
        writable(databasePath, (db) => {
          db.exec("UPDATE schema_meta SET app_version = '0.0.1' WHERE meta_key = 'primary'");
        }),
      repaired: ({ databasePath }) =>
        readOne(
          databasePath,
          "SELECT app_version <> '0.0.1' AS current FROM schema_meta WHERE meta_key = 'primary'",
        ),
      expected: { current: 1 },
    },
    {
      condition: "canonical-indexes",
      create: ({ databasePath }) =>
        writable(databasePath, (db) => {
          const index = db
            .prepare(
              "SELECT name FROM sqlite_schema WHERE type = 'index' AND tbl_name = 'session_nodes' AND sql IS NOT NULL ORDER BY name LIMIT 1",
            )
            .get() as { name: string };
          db.exec(`DROP INDEX ${index.name}`);
          dropped = index.name;
        }),
      repaired: ({ databasePath }) =>
        readOne(databasePath, "SELECT count(*) AS n FROM sqlite_schema WHERE name = ?", [dropped]),
      expected: { n: 1 },
    },
    {
      condition: "integrity",
      create: ({ databasePath }) => {
        const { name, key } = readOne(
          databasePath,
          "SELECT (SELECT name FROM sqlite_schema WHERE type = 'index' AND tbl_name = 'session_nodes' AND sql LIKE '%(session_key)%' ORDER BY name LIMIT 1) AS name, (SELECT session_key FROM session_nodes LIMIT 1) AS key",
        ) as { name: string; key: string };
        corruptSqliteIndexKey(databasePath, name, key, `${key.slice(0, -1)}~`);
      },
      repaired: ({ databasePath }) => readOne(databasePath, "PRAGMA integrity_check"),
      expected: { integrity_check: "ok" },
    },
    {
      condition: "schema-additive",
      create: ({ databasePath }) =>
        writable(databasePath, (db) => {
          db.exec("DROP TABLE session_reactions");
        }),
      repaired: ({ databasePath }) =>
        readOne(
          databasePath,
          "SELECT count(*) AS n FROM sqlite_schema WHERE name = 'session_reactions'",
        ),
      expected: { n: 1 },
    },
    {
      condition: "media-rows",
      create: ({ databasePath }) =>
        writable(databasePath, (db) => {
          db.prepare("DELETE FROM schema_meta WHERE meta_key = ?").run(
            MEDIA_ROWS_MIGRATION_META_KEY,
          );
        }),
      repaired: ({ databasePath }) =>
        readOne(databasePath, "SELECT count(*) AS n FROM schema_meta WHERE meta_key = ?", [
          MEDIA_ROWS_MIGRATION_META_KEY,
        ]),
      expected: { n: 1 },
    },
    {
      condition: "permissions",
      create: ({ databasePath }) => fs.chmodSync(databasePath, 0o644),
      repaired: ({ databasePath }) => fs.statSync(databasePath).mode & 0o777,
      expected: 0o600,
    },
    {
      condition: "registry",
      create: ({ env }) =>
        writable(stateDatabase(env), (db) => {
          db.exec("DELETE FROM agent_databases");
        }),
      repaired: ({ env }) =>
        readOne(
          stateDatabase(env),
          "SELECT count(*) AS n FROM agent_databases WHERE agent_id = 'main'",
        ),
      expected: { n: 1 },
    },
    {
      condition: "archive-files",
      create: ({ env }) =>
        writeArchive(
          path.join(
            env.OPENCLAW_STATE_DIR!,
            "agents",
            "main",
            "sessions",
            "legacy.jsonl.deleted.2026-07-24T01-02-03.000Z",
          ),
          [createEvent({ id: "a1", parentId: null, timestamp: 2, message })],
          false,
        ),
      repaired: ({ env }) =>
        fs
          .readFileSync(
            path.join(
              env.OPENCLAW_STATE_DIR!,
              "agents",
              "main",
              "sessions",
              "legacy.jsonl.deleted.2026-07-24T01-02-03.000Z",
            ),
            "utf8",
          )
          .includes('"MediaPath"'),
      expected: false,
    },
  ];
  let dropped = "";

  // On Windows permissions always have work, so the plan stops before its whole-store
  // reads (archives, archive files, integrity), and POSIX mode bits are no fixture.
  const windowsUnread = new Set([
    "permissions",
    "transcript-archives",
    "archive-files",
    "integrity",
  ]);
  it.each(guards.filter((guard) => !windows || !windowsUnread.has(guard.condition)))(
    "reports $condition as work and the pass repairs it",
    async (guard) => {
      const fixture = await healthyInstall();
      guard.create(fixture);

      const { conditions } = await conditionsOf(fixture.env);
      expect(conditions[guard.condition]).toBe("work");

      const leases = vi.spyOn(maintenanceLease, "withAgentDatabaseMaintenanceLease");
      await migrate({ env: fixture.env });
      // Work keeps the unchanged writing pass, lease included.
      expect(leases).toHaveBeenCalled();
      closeOpenClawAgentDatabasesForTest();
      closeOpenClawStateDatabaseForTest();
      expect(guard.repaired(fixture)).toEqual(guard.expected);
      const after = await conditionsOf(fixture.env);
      expect(after.conditions[guard.condition]).toBe("none");
    },
  );

  it("reports an older schema version as work", async () => {
    const env = { OPENCLAW_STATE_DIR: makeTempDir(tempDirs, "agent-db-plan-old-") };
    createLegacyDatabaseFixture({
      env,
      eventsBySession: { s: [createEvent({ id: "e", parentId: null, timestamp: 1, message })] },
    });
    closeOpenClawAgentDatabasesForTest();
    const { plan, conditions } = await conditionsOf(env);
    expect(conditions["schema-version"]).toBe("work");
    expect(plan.pending).toBe("work");
  });

  it("answers undecidable for a store the read-only reader cannot vouch for", async () => {
    const { env, databasePath } = await healthyInstall();
    // A store whose agent was deleted in this process reads as missing.
    installDeletedAgentDatabaseFences([[path.resolve(databasePath), "main"]]);
    try {
      const { plan, conditions } = await conditionsOf(env);
      expect(conditions["schema-version"]).toBe("undecidable");
      expect(plan.pending).toBe(windows ? "work" : "undecidable");
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
    expect(
      configured.databases.map(({ path: pathname, conditions }) => [
        pathname,
        conditions["schema-version"],
      ]),
    ).toEqual(
      expect.arrayContaining([
        [incognitoPath, "undecidable"],
        [databasePath, "none"],
      ]),
    );
    expect(configured.pending).not.toBe("none");
  });
});

function readOne(pathname: string, sql: string, params: unknown[] = []) {
  const db = new (requireNodeSqlite().DatabaseSync)(pathname, { readOnly: true });
  try {
    return { ...(db.prepare(sql).get(...(params as never[])) as object) };
  } finally {
    db.close();
  }
}
