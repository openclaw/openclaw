import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import { createLocalSqliteSnapshotProvider } from "../snapshot/local-repository.js";
import { createGlobalDatabase } from "../snapshot/local-repository.schema.test-support.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "../state/openclaw-state-db-contract.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
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
    ...createTestConfigReadMocks(configMocks, "getRuntimeConfig"),
    readConfigFileSnapshot: async () => ({ config: configMocks.getRuntimeConfig() }),
  };
});

let state: OpenClawTestState;
let runtime: ReturnType<typeof createTestRuntime>;

beforeEach(async () => {
  // Rejected requests can record outcomes too; every case must own its state.
  state = await createOpenClawTestState({
    prefix: "openclaw-backup-sqlite-",
    layout: "state-only",
  });
  configMocks.getRuntimeConfig.mockReset().mockReturnValue({
    agents: { entries: { main: {}, "ops-team": {} } },
  });
  runtime = createTestRuntime();
  runtime.exit.mockImplementation((code) => {
    throw new Error(`exit ${code}`);
  });
});

afterEach(async () => {
  await state.cleanup();
});

describe("SQLite backup commands", () => {
  it("creates, lists, verifies, and fresh-restores SQLite in a mixed-engine config", async () => {
    configMocks.getRuntimeConfig.mockReturnValue({
      database: { families: { workboard: { engine: "postgres" } } },
    });
    const repositoryPath = state.path("snapshots");
    const scratchPath = state.path("scratch");
    const restorePath = state.path("restore", "openclaw.sqlite");
    const databasePath = resolveOpenClawStateSqlitePath();
    await fs.mkdir(path.dirname(databasePath), { recursive: true });
    await fs.mkdir(scratchPath, { mode: 0o700 });
    await fs.chmod(scratchPath, 0o700);
    createGlobalDatabase(databasePath);
    const sqlite = requireNodeSqlite();
    {
      using source = new sqlite.DatabaseSync(databasePath);
      source.exec(
        "CREATE TABLE durable_entries (value TEXT); INSERT INTO durable_entries VALUES ('kept');",
      );
    }

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

    const missingScratchPath = state.path("missing-scratch");
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

    using restoredDatabase = new sqlite.DatabaseSync(restorePath, { readOnly: true });
    expect(restoredDatabase.prepare("SELECT value FROM durable_entries").all()).toEqual([
      { value: "kept" },
    ]);
  });

  it("reports missing snapshot paths for verify and restore", async () => {
    const repositoryPath = state.path("snapshots");
    const snapshotPath = path.join(repositoryPath, "missing-snapshot");
    const restorePath = state.path("restored.sqlite");
    const missingRepositoryMessage = `SQLite snapshot repository does not exist: ${repositoryPath}. Check the snapshot path or create a snapshot with \`openclaw backup sqlite create\`.`;

    await expectUnreadableSnapshot(snapshotPath, restorePath, missingRepositoryMessage);

    await fs.mkdir(repositoryPath, { mode: 0o700 });
    const missingSnapshotMessage = `SQLite snapshot does not exist: ${snapshotPath}. Run \`openclaw backup sqlite list --repository ${repositoryPath}\` to inspect available snapshots.`;
    await expectUnreadableSnapshot(snapshotPath, restorePath, missingSnapshotMessage);
  });

  it("reports a repository-format mismatch when listing a Git backup as SQLite", async () => {
    const repositoryPath = path.join(state.root, "git-backup");
    const gitPath = path.join(repositoryPath, ".git");
    await fs.mkdir(gitPath, { recursive: true });

    await expect(
      backupSqliteListCommand(runtime, { repository: repositoryPath, json: true }),
    ).rejects.toThrow(
      `Git backup repository is not a SQLite snapshot repository: ${repositoryPath}. Use \`openclaw backup git log --repository <path>\` instead.`,
    );
  });

  it.each([
    [{}, "Choose a SQLite snapshot source"],
    [{ global: true, agent: "main" }, "Choose exactly one SQLite snapshot source"],
    [
      { agent: "nope-agent" },
      'Unknown agent id "nope-agent". Run openclaw agents list to see configured agents.',
    ],
    [{ agent: "   " }, "--agent must not be blank"],
    [{ global: true, repository: undefined }, "Missing required --repository value"],
  ] as const)("rejects invalid SQLite snapshot source %j", async (options, message) => {
    await expect(
      backupSqliteCreateCommand(runtime, {
        repository: "/tmp/snapshots",
        ...options,
      }),
    ).rejects.toThrow(message);
  });

  it("does not claim completion when a corrupt database also rejects outcome recording", async () => {
    const repositoryPath = state.path("snapshots");
    const databasePath = resolveOpenClawStateSqlitePath();
    await fs.mkdir(path.dirname(databasePath), { recursive: true });
    await fs.writeFile(databasePath, Buffer.alloc(32));

    await expect(
      backupSqliteCreateCommand(runtime, { global: true, repository: repositoryPath }),
    ).rejects.toThrow(/cannot be snapshotted safely/u);

    expect(runtime.error).toHaveBeenCalledExactlyOnceWith(
      `Warning: the backup outcome could not be recorded: Cannot admit backup.recordOutcome for backup outcome ledger in state root ${path.dirname(path.dirname(databasePath))}: failed to acquire gateway state ownership | file is not a database | ERR_SQLITE_ERROR. No local mutation was attempted. Inspect openclaw gateway status. Update the Gateway or fix authentication and retry. To run offline, stop the Gateway through its service owner, wait for ownership to release, then rerun this exact command. | ERR_SQLITE_ERROR`,
    );
    await expect(fs.readdir(repositoryPath)).resolves.toEqual([]);
  });

  it("requires snapshot and restore target paths", async () => {
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
    {
      using database = new sqlite.DatabaseSync(databasePath);
      database.exec("CREATE TABLE entries (id INTEGER PRIMARY KEY);");
    }
    const snapshot = await createLocalSqliteSnapshotProvider({ repositoryPath }).create({
      path: databasePath,
      identity: { role: "generic", id: "generic-test" },
    });

    await expect(backupSqliteListCommand(runtime, { repository: repositoryPath })).rejects.toThrow(
      /database role generic is not allowed/u,
    );
    await expectUnreadableSnapshot(
      snapshot.ref.path,
      restorePath,
      /database role generic is not allowed/u,
    );
    await expect(fs.access(restorePath)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

async function expectUnreadableSnapshot(
  snapshot: string,
  target: string,
  message: string | RegExp,
) {
  await expect(backupSqliteVerifyCommand(runtime, snapshot, {})).rejects.toThrow(message);
  await expect(backupSqliteRestoreCommand(runtime, snapshot, { target })).rejects.toThrow(message);
}
