import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { deriveDeliveryQueueRetentionColumns } from "../infra/delivery-queue-retention-columns.js";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import { createLocalSqliteSnapshotProvider } from "../snapshot/local-repository.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "../state/openclaw-state-db-contract.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { OPENCLAW_STATE_SCHEMA_SQL } from "../state/openclaw-state-schema.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import {
  backupSqliteCreateCommand,
  backupSqliteListCommand,
  backupSqliteRestoreCommand,
  backupSqliteVerifyCommand,
} from "./backup-sqlite.js";
import { createTestRuntime } from "./test-runtime-config-helpers.js";

const configMocks = vi.hoisted(() => ({
  getRuntimeConfig: vi.fn(),
}));

vi.mock("../config/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config/config.js")>();
  const { createTestConfigReadMocks } = await import("./test-runtime-config-helpers.js");
  return {
    ...actual,
    getRuntimeConfig: configMocks.getRuntimeConfig,
    loadConfig: configMocks.getRuntimeConfig,
    readConfigFileSnapshot: async () => ({ config: configMocks.getRuntimeConfig() }),
    captureRuntimeConfigAsyncReader: createTestConfigReadMocks(configMocks, "getRuntimeConfig")
      .captureRuntimeConfigAsyncReader,
  };
});

let state: OpenClawTestState;

beforeEach(async () => {
  // Rejected requests can record outcomes too; every case must own its state.
  state = await createOpenClawTestState({
    prefix: "openclaw-backup-sqlite-",
    layout: "state-only",
  });
  configMocks.getRuntimeConfig.mockReset().mockReturnValue({
    agents: { entries: { main: {}, "ops-team": {} } },
  });
});

afterEach(async () => {
  await state.cleanup();
});

function createGlobalDatabase(databasePath: string): void {
  const sqlite = requireNodeSqlite();
  const database = new sqlite.DatabaseSync(databasePath);
  try {
    database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA wal_autocheckpoint = 0;
      ${OPENCLAW_STATE_SCHEMA_SQL}
      PRAGMA user_version = ${OPENCLAW_STATE_SCHEMA_VERSION};
      CREATE TABLE durable_entries (id INTEGER PRIMARY KEY, value TEXT NOT NULL);
    `);
    database
      .prepare(
        "INSERT INTO schema_meta (meta_key, role, schema_version, agent_id, app_version, created_at, updated_at) VALUES ('primary', 'global', ?, NULL, NULL, 1, 1)",
      )
      .run(OPENCLAW_STATE_SCHEMA_VERSION);
    const entryJson = '{"payload":"do-not-restore"}';
    database
      .prepare(
        `
          INSERT INTO delivery_queue_entries
            (queue_name, id, status, entry_json, retention_id_prefix,
             retention_max_age_ms, retention_max_entries, enqueued_at, updated_at)
          VALUES ('delivery', 'queued', 'pending', ?,
            @retention_id_prefix, @retention_max_age_ms, @retention_max_entries, 1, 1)
        `,
      )
      .run(deriveDeliveryQueueRetentionColumns("queued", entryJson), entryJson);
    database.prepare("INSERT INTO durable_entries (value) VALUES (?)").run("checkpointed");
    database.exec("PRAGMA wal_checkpoint(TRUNCATE);");
    database.prepare("INSERT INTO durable_entries (value) VALUES (?)").run("committed-in-wal");
  } finally {
    database.close();
  }
}

describe("SQLite backup commands", () => {
  it.each([false, true])(
    "creates, lists, verifies, and fresh-restores the global database (mixed: %s)",
    async (mixed) => {
      if (mixed) {
        configMocks.getRuntimeConfig.mockReturnValue({
          database: { families: { workboard: { engine: "postgres" } } },
        });
      }
      const tempDir = state.root;
      const repositoryPath = path.join(tempDir, "snapshots");
      const scratchPath = path.join(tempDir, "scratch");
      const restorePath = path.join(tempDir, "restore", "openclaw.sqlite");
      const databasePath = resolveOpenClawStateSqlitePath();
      await fs.mkdir(path.dirname(databasePath), { recursive: true });
      await fs.mkdir(scratchPath, { mode: 0o700 });
      await fs.chmod(scratchPath, 0o700);
      createGlobalDatabase(databasePath);
      const runtime = createRuntime();

      const created = await backupSqliteCreateCommand(runtime, {
        global: true,
        repository: repositoryPath,
        json: true,
      });
      expect(created.manifest.database).toMatchObject({
        role: "global",
        basename: "openclaw.sqlite",
        userVersion: OPENCLAW_STATE_SCHEMA_VERSION,
      });
      expect(JSON.parse(String(runtime.log.mock.calls[0]?.[0]))).toEqual(created);

      const listed = await backupSqliteListCommand(runtime, {
        repository: repositoryPath,
        json: true,
      });
      expect(listed.snapshots).toHaveLength(1);
      expect(listed.snapshots[0]?.manifest.snapshotId).toBe(created.manifest.snapshotId);

      const missingScratchPath = path.join(tempDir, "missing-scratch");
      await expect(
        backupSqliteVerifyCommand(runtime, created.snapshotPath, {
          scratch: missingScratchPath,
        }),
      ).rejects.toThrow(
        `SQLite validation root does not exist: ${missingScratchPath}. Create a private directory there or pass an existing directory with \`--scratch\`.`,
      );

      const verified = await backupSqliteVerifyCommand(runtime, created.snapshotPath, {
        scratch: scratchPath,
        json: true,
      });
      expect(verified.manifest).toEqual(created.manifest);
      await expect(fs.readdir(scratchPath)).resolves.toEqual([]);

      const restored = await backupSqliteRestoreCommand(runtime, created.snapshotPath, {
        target: restorePath,
        json: true,
      });
      expect(restored).toMatchObject({
        ok: true,
        snapshotPath: created.snapshotPath,
        targetPath: restorePath,
      });
      expect(runtime.error).not.toHaveBeenCalled();

      const sqlite = requireNodeSqlite();
      const restoredDatabase = new sqlite.DatabaseSync(restorePath, { readOnly: true });
      try {
        expect(
          restoredDatabase.prepare("SELECT value FROM durable_entries ORDER BY id").all(),
        ).toEqual([{ value: "checkpointed" }, { value: "committed-in-wal" }]);
        expect(
          restoredDatabase.prepare("SELECT COUNT(*) AS count FROM delivery_queue_entries").get(),
        ).toEqual({ count: 0 });
      } finally {
        restoredDatabase.close();
      }
    },
  );

  it("reports missing snapshot paths for verify and restore", async () => {
    const repositoryPath = state.path("snapshots");
    const snapshotPath = path.join(repositoryPath, "missing-snapshot");
    const restorePath = state.path("restored.sqlite");
    const runtime = createRuntime();
    const missingRepositoryMessage = `SQLite snapshot repository does not exist: ${repositoryPath}. Check the snapshot path or create a snapshot with \`openclaw backup sqlite create\`.`;

    await expect(backupSqliteVerifyCommand(runtime, snapshotPath, {})).rejects.toThrow(
      missingRepositoryMessage,
    );
    await expect(
      backupSqliteRestoreCommand(runtime, snapshotPath, { target: restorePath }),
    ).rejects.toThrow(missingRepositoryMessage);

    await fs.mkdir(repositoryPath, { mode: 0o700 });
    const missingSnapshotMessage = `SQLite snapshot does not exist: ${snapshotPath}. Run \`openclaw backup sqlite list --repository ${repositoryPath}\` to inspect available snapshots.`;
    await expect(backupSqliteVerifyCommand(runtime, snapshotPath, {})).rejects.toThrow(
      missingSnapshotMessage,
    );
    await expect(
      backupSqliteRestoreCommand(runtime, snapshotPath, { target: restorePath }),
    ).rejects.toThrow(missingSnapshotMessage);
  });

  it.each(["directory", "file"])(
    "reports a repository-format mismatch when listing a Git backup as SQLite (%s marker)",
    async (marker) => {
      const repositoryPath = path.join(state.root, "git-backup");
      const gitPath = path.join(repositoryPath, ".git");
      if (marker === "directory") {
        await fs.mkdir(gitPath, { recursive: true });
      } else {
        await fs.mkdir(repositoryPath);
        await fs.writeFile(gitPath, "gitdir: ../git-admin\n");
      }

      const runtime = createRuntime();
      await expect(
        backupSqliteListCommand(runtime, { repository: repositoryPath, json: true }),
      ).rejects.toThrow(
        `Git backup repository is not a SQLite snapshot repository: ${repositoryPath}. Use \`openclaw backup git log --repository <path>\` instead.`,
      );
    },
  );

  it("requires exactly one named OpenClaw database source", async () => {
    const runtime = createRuntime();

    await expect(
      backupSqliteCreateCommand(runtime, { repository: "/tmp/snapshots" }),
    ).rejects.toThrow("Choose a SQLite snapshot source");
    await expect(
      backupSqliteCreateCommand(runtime, {
        global: true,
        agent: "main",
        repository: "/tmp/snapshots",
      }),
    ).rejects.toThrow("Choose exactly one SQLite snapshot source");
  });

  it.each([
    [
      "unknown",
      "nope-agent",
      'Unknown agent id "nope-agent". Run openclaw agents list to see configured agents.',
    ],
    ["whitespace-only", "   ", "--agent must not be blank"],
  ])("rejects an %s SQLite snapshot agent", async (_label, agent, message) => {
    await expect(
      backupSqliteCreateCommand(createRuntime(), {
        agent,
        repository: "/tmp/snapshots",
      }),
    ).rejects.toThrow(message);
  });

  it("does not claim completion when a corrupt database also rejects outcome recording", async () => {
    const repositoryPath = state.path("snapshots");
    const databasePath = resolveOpenClawStateSqlitePath();
    await fs.mkdir(path.dirname(databasePath), { recursive: true });
    await fs.writeFile(databasePath, Buffer.alloc(32));
    const runtime = createRuntime();

    await expect(
      backupSqliteCreateCommand(runtime, { global: true, repository: repositoryPath }),
    ).rejects.toThrow(/cannot be snapshotted safely/u);

    expect(runtime.error).toHaveBeenCalledExactlyOnceWith(
      `Warning: the backup outcome could not be recorded: Cannot admit backup.recordOutcome for backup outcome ledger in state root ${path.dirname(path.dirname(databasePath))}: failed to acquire gateway state ownership | file is not a database | ERR_SQLITE_ERROR. No local mutation was attempted. Inspect openclaw gateway status. Update the Gateway or fix authentication and retry. To run offline, stop the Gateway through its service owner, wait for ownership to release, then rerun this exact command. | ERR_SQLITE_ERROR`,
    );
    await expect(fs.readdir(repositoryPath)).resolves.toEqual([]);
  });

  it("requires repository, snapshot, and restore target paths", async () => {
    const runtime = createRuntime();

    await expect(backupSqliteCreateCommand(runtime, { global: true })).rejects.toThrow(
      "Missing required --repository value",
    );
    await expect(backupSqliteVerifyCommand(runtime, " ", {})).rejects.toThrow(
      "Missing required <snapshot> value",
    );
    await expect(backupSqliteRestoreCommand(runtime, "/tmp/snapshot", {})).rejects.toThrow(
      "Missing required --target value",
    );
  });

  it("rejects generic provider artifacts before verify or restore", async () => {
    const databasePath = state.path("generic.sqlite");
    const repositoryPath = state.path("snapshots");
    const restorePath = state.path("restore", "generic.sqlite");
    const sqlite = requireNodeSqlite();
    const database = new sqlite.DatabaseSync(databasePath);
    try {
      database.exec("CREATE TABLE entries (id INTEGER PRIMARY KEY);");
    } finally {
      database.close();
    }
    const snapshot = await createLocalSqliteSnapshotProvider({ repositoryPath }).create({
      path: databasePath,
      identity: { role: "generic", id: "generic-test" },
    });
    const runtime = createRuntime();

    await expect(backupSqliteListCommand(runtime, { repository: repositoryPath })).rejects.toThrow(
      /database role generic is not allowed/u,
    );
    await expect(backupSqliteVerifyCommand(runtime, snapshot.ref.path, {})).rejects.toThrow(
      /database role generic is not allowed/u,
    );
    await expect(
      backupSqliteRestoreCommand(runtime, snapshot.ref.path, { target: restorePath }),
    ).rejects.toThrow(/database role generic is not allowed/u);
    await expect(fs.access(restorePath)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

function createRuntime() {
  const runtime = createTestRuntime();
  runtime.exit.mockImplementation((code) => {
    throw new Error(`exit ${code}`);
  });
  return runtime;
}
