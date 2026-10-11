import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { requireGitCommand as requireGit } from "../infra/git-exec.js";
import {
  openOpenClawAgentDatabase,
  closeOpenClawAgentDatabaseByPath,
} from "../state/openclaw-agent-db.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import {
  createGitBackup,
  initializeGitBackupRepository,
  restoreGitBackupRef,
  verifyGitBackupRef,
} from "./git-backup.js";
import { createFinderMetadataFixture, writeBackupManifest } from "./git-backup.test-support.js";

const roots = useAutoCleanupTempDirTracker(afterEach);

afterEach(async () => {
  await closeOpenClawStateDatabaseAsync();
  closeOpenClawStateDatabaseForTest();
});

function createStateDatabaseFixture(root: string) {
  const stateDir = path.join(root, "state");
  const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
  openOpenClawStateDatabase({ env });
  closeOpenClawStateDatabaseForTest();
  return {
    stateDir,
    database: { path: resolveOpenClawStateSqlitePath(env), identity: { role: "global" } as const },
  };
}

describe("Finder metadata ownership in Git backups", () => {
  it("stages only backup-owned paths in an adopted repository", async () => {
    const root = roots.make("git-backup-finder-");
    const { stateDir, database } = createStateDatabaseFixture(root);
    const repositoryPath = path.join(root, "repository");
    await initializeGitBackupRepository({ repositoryPath, stateDir });
    await requireGit(repositoryPath, ["config", "user.name", "OpenClaw Backup Test"]);
    await requireGit(repositoryPath, ["config", "user.email", "backup@example.invalid"]);
    await fs.writeFile(path.join(repositoryPath, "unrelated.txt"), "operator-owned\n");
    await requireGit(repositoryPath, ["add", "unrelated.txt"]);
    const finderPath = path.join(repositoryPath, "agents", ".DS_Store");
    await fs.mkdir(path.dirname(finderPath), { recursive: true });
    await fs.writeFile(finderPath, createFinderMetadataFixture());
    await requireGit(repositoryPath, ["add", "agents/.DS_Store"]);

    const created = await createGitBackup({ repositoryPath, stateDir, databases: [database] });
    const unchanged = await createGitBackup({ repositoryPath, stateDir, databases: [database] });

    expect(created.noChanges).toBe(false);
    expect(unchanged.noChanges).toBe(true);
    expect(unchanged).not.toHaveProperty("commit");
    expect(await requireGit(repositoryPath, ["status", "--porcelain", "--", "unrelated.txt"])).toBe(
      "A  unrelated.txt",
    );
    const committedPaths = (
      await requireGit(repositoryPath, ["show", "--pretty=format:", "--name-only", "HEAD"])
    )
      .split("\n")
      .filter(Boolean);
    expect(committedPaths.length).toBeGreaterThan(0);
    expect(
      committedPaths.every(
        (entry) =>
          entry === "global" ||
          entry.startsWith("global/") ||
          entry === "agents" ||
          entry.startsWith("agents/"),
      ),
    ).toBe(true);
    expect(committedPaths).not.toContain("unrelated.txt");
    expect(committedPaths).not.toContain("agents/.DS_Store");
    expect(
      await requireGit(repositoryPath, ["status", "--porcelain", "--", "agents/.DS_Store"]),
    ).toBe("A  agents/.DS_Store");
    expect(
      await requireGit(repositoryPath, ["ls-tree", "-r", "--name-only", "HEAD"]),
    ).not.toContain("unrelated.txt");
    expect(await requireGit(repositoryPath, ["rev-list", "--count", "HEAD"])).toBe("1");
  });
  it("ignores regular Finder metadata across all-scope backups and restores", async () => {
    const root = roots.make("git-backup-finder-");
    const { stateDir, database } = createStateDatabaseFixture(root);
    await closeOpenClawStateDatabaseAsync();
    const source = new DatabaseSync(database.path);
    try {
      source.exec(
        "CREATE TABLE finder_fixture (value TEXT); INSERT INTO finder_fixture VALUES ('backup survives Finder');",
      );
    } finally {
      source.close();
    }
    const repositoryPath = path.join(root, "repository");
    await initializeGitBackupRepository({ repositoryPath, stateDir });
    const finderPath = path.join(repositoryPath, "agents", ".DS_Store");
    await fs.mkdir(path.dirname(finderPath), { recursive: true });
    await fs.writeFile(finderPath, createFinderMetadataFixture());
    const params = { repositoryPath, stateDir, databases: [database], all: true };

    const first = await createGitBackup(params);
    expect(first.commit).toMatch(/^[a-f0-9]{40}$/u);
    await expect(fs.readFile(finderPath)).resolves.toEqual(createFinderMetadataFixture());
    expect(
      await requireGit(repositoryPath, ["ls-tree", "-r", "--name-only", "HEAD"]),
    ).not.toContain(".DS_Store");

    await fs.writeFile(finderPath, createFinderMetadataFixture(101));
    const second = await createGitBackup(params);
    expect(second).toMatchObject({ noChanges: true });
    expect(second.commit).toBeUndefined();
    expect(await requireGit(repositoryPath, ["rev-parse", "HEAD"])).toBe(first.commit);
    await expect(fs.readFile(finderPath)).resolves.toEqual(createFinderMetadataFixture(101));

    const restored = await restoreGitBackupRef({
      repositoryPath,
      identity: { role: "global" },
      targetPath: path.join(root, "restored.sqlite"),
    });
    expect(restored.tables.every((table) => table.ok)).toBe(true);
    expect(restored.manifest.tables).toEqual(first.manifests[0]?.tables);
    const restoredDatabase = new DatabaseSync(restored.targetPath, { readOnly: true });
    try {
      expect(restoredDatabase.prepare("SELECT value FROM finder_fixture").get()).toEqual({
        value: "backup survives Finder",
      });
    } finally {
      restoredDatabase.close();
    }
  });

  it.each(["agents/.DS_Store", "agents/main/.DS_Store", "agents/main/tables/.DS_Store"])(
    "preserves an ordinary document in history and on disk at %s",
    async (file) => {
      const root = roots.make("git-backup-finder-document-");
      const databasePath = path.join(root, "agent.sqlite");
      const database = openOpenClawAgentDatabase({
        agentId: "main",
        path: databasePath,
        env: { ...process.env, OPENCLAW_STATE_DIR: path.join(root, "state") },
      });
      closeOpenClawAgentDatabaseByPath(database.path);
      const repositoryPath = path.join(root, "repository");
      const params = {
        repositoryPath,
        stateDir: path.join(root, "state"),
        databases: [{ path: databasePath, identity: { role: "agent", agentId: "main" } as const }],
        all: true,
      };
      await createGitBackup(params);
      const document = "operator document with Finder's basename\n";
      const finderPath = path.join(repositoryPath, file);
      await fs.mkdir(path.dirname(finderPath), { recursive: true });
      await fs.writeFile(finderPath, document);
      await requireGit(repositoryPath, ["add", "--", file]);
      await requireGit(repositoryPath, [
        "-c",
        "user.name=Backup test",
        "-c",
        "user.email=backup@example.invalid",
        "commit",
        "-m",
        "Operator document",
      ]);
      const head = await requireGit(repositoryPath, ["rev-parse", "HEAD"]);
      await expect(createGitBackup(params)).rejects.toThrow(/non-Finder file in backup history/u);
      expect(await requireGit(repositoryPath, ["rev-parse", "HEAD"])).toBe(head);
      expect(await requireGit(repositoryPath, ["show", `HEAD:${file}`])).toBe(document.trim());
      await expect(fs.readFile(finderPath, "utf8")).resolves.toBe(document);
      if (file !== "agents/.DS_Store") {
        await expect(
          restoreGitBackupRef({
            repositoryPath,
            identity: { role: "agent", agentId: "main" },
            ref: head,
            targetPath: path.join(root, "refused.sqlite"),
          }),
        ).rejects.toThrow(/unexpected file/u);
        await expect(fs.stat(path.join(root, "refused.sqlite"))).rejects.toMatchObject({
          code: "ENOENT",
        });
      }
    },
  );

  it("refuses uncommitted namesake documents before replacing a selected scope", async () => {
    const root = roots.make("git-backup-finder-document-");
    const databasePath = path.join(root, "agent.sqlite");
    const database = openOpenClawAgentDatabase({
      agentId: "main",
      path: databasePath,
      env: { ...process.env, OPENCLAW_STATE_DIR: path.join(root, "state") },
    });
    closeOpenClawAgentDatabaseByPath(database.path);
    const repositoryPath = path.join(root, "repository");
    const params = {
      repositoryPath,
      stateDir: path.join(root, "state"),
      databases: [{ path: databasePath, identity: { role: "agent", agentId: "main" } as const }],
    };
    const first = await createGitBackup(params);
    const finderPath = path.join(repositoryPath, "agents/main/.DS_Store");
    await fs.writeFile(finderPath, "user document");
    await expect(createGitBackup(params)).rejects.toThrow(/non-backup-owned path/u);
    await expect(fs.readFile(finderPath, "utf8")).resolves.toBe("user document");
    expect(await requireGit(repositoryPath, ["rev-parse", "HEAD"])).toBe(first.commit);
    await fs.rm(finderPath);
    const nestedPath = path.join(repositoryPath, "agents/main/notes/.DS_Store");
    await fs.mkdir(path.dirname(nestedPath), { recursive: true });
    await fs.writeFile(nestedPath, "nested operator document");
    await expect(createGitBackup(params)).rejects.toThrow(/non-backup-owned path/u);
    await expect(fs.readFile(nestedPath, "utf8")).resolves.toBe("nested operator document");
    const other = openOpenClawAgentDatabase({
      agentId: "other",
      path: path.join(root, "other.sqlite"),
      env: { ...process.env, OPENCLAW_STATE_DIR: params.stateDir },
    });
    closeOpenClawAgentDatabaseByPath(other.path);
    await expect(
      createGitBackup({
        ...params,
        all: true,
        databases: [{ path: other.path, identity: { role: "agent", agentId: "other" } }],
      }),
    ).rejects.toThrow(/non-backup-owned path/u);
    await expect(fs.readFile(nestedPath, "utf8")).resolves.toBe("nested operator document");
    await fs.rm(path.join(repositoryPath, "agents/main/notes"), { recursive: true });
    const truncated = createFinderMetadataFixture().subarray(0, 32);
    const invalidBounds = createFinderMetadataFixture();
    invalidBounds.writeUInt32BE(0xffffffff, 12);
    const oversized = Buffer.concat([createFinderMetadataFixture(), Buffer.alloc(1024 * 1024)]);
    for (const invalid of [truncated, invalidBounds, oversized]) {
      await fs.writeFile(finderPath, invalid);
      await expect(createGitBackup(params)).rejects.toThrow(/non-backup-owned path/u);
      await expect(fs.readFile(finderPath)).resolves.toEqual(invalid);
      expect(await requireGit(repositoryPath, ["rev-parse", "HEAD"])).toBe(first.commit);
      await requireGit(repositoryPath, ["add", "--", "agents/main/.DS_Store"]);
      await requireGit(repositoryPath, [
        "-c",
        "user.name=Backup test",
        "-c",
        "user.email=backup@example.invalid",
        "commit",
        "-m",
        "Invalid namesake metadata",
      ]);
      await expect(
        verifyGitBackupRef({ repositoryPath, identity: { role: "agent", agentId: "main" } }),
      ).rejects.toThrow(/unexpected file/u);
      await requireGit(repositoryPath, ["reset", "--mixed", first.commit!]);
    }
  });

  it("removes committed Finder metadata when refreshing otherwise unchanged database scopes", async () => {
    const root = roots.make("git-backup-finder-");
    const stateDir = path.join(root, "state");
    const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
    openOpenClawStateDatabase({ env });
    closeOpenClawStateDatabaseForTest();
    const agentPath = path.join(root, "agent.sqlite");
    const agentDatabase = openOpenClawAgentDatabase({ agentId: "main", path: agentPath, env });
    closeOpenClawAgentDatabaseByPath(agentDatabase.path);
    const databases = [
      { path: resolveOpenClawStateSqlitePath(env), identity: { role: "global" } as const },
      { path: agentPath, identity: { role: "agent", agentId: "main" } as const },
    ];
    const repositoryPath = path.join(root, "repository");
    const params = { repositoryPath, stateDir, databases, all: true };
    const first = await createGitBackup(params);
    const metadataPaths = [
      "global/.DS_Store",
      "global/tables/.DS_Store",
      "agents/main/.DS_Store",
      "agents/main/tables/.DS_Store",
      "agents/.DS_Store",
    ];
    for (const file of metadataPaths) {
      await fs.writeFile(path.join(repositoryPath, file), createFinderMetadataFixture());
    }
    await requireGit(repositoryPath, ["add", "--", ...metadataPaths]);
    await requireGit(repositoryPath, [
      "-c",
      "user.name=Backup test",
      "-c",
      "user.email=backup@example.invalid",
      "commit",
      "-m",
      "Seed existing repository metadata",
    ]);

    const legacyRef = await requireGit(repositoryPath, ["rev-parse", "HEAD"]);
    for (const [index, database] of databases.entries()) {
      expect(
        (
          await verifyGitBackupRef({ repositoryPath, identity: database.identity, ref: legacyRef })
        ).tables.every((table) => table.ok),
      ).toBe(true);
      const legacy = await restoreGitBackupRef({
        repositoryPath,
        identity: database.identity,
        ref: legacyRef,
        targetPath: path.join(root, `legacy-${index}.sqlite`),
      });
      expect(legacy.manifest.tables).toEqual(first.manifests[index]?.tables);
    }
    const refreshed = await createGitBackup(params);
    expect(refreshed.commit).toMatch(/^[a-f0-9]{40}$/u);
    await expect(fs.readFile(path.join(repositoryPath, "agents/.DS_Store"))).resolves.toEqual(
      createFinderMetadataFixture(),
    );
    expect(
      await requireGit(repositoryPath, ["ls-tree", "-r", "--name-only", "HEAD"]),
    ).not.toContain(".DS_Store");
    for (const [index, database] of databases.entries()) {
      const restored = await restoreGitBackupRef({
        repositoryPath,
        identity: database.identity,
        targetPath: path.join(root, `restored-${index}.sqlite`),
      });
      expect(restored.tables.every((table) => table.ok)).toBe(true);
      expect(restored.manifest.tables).toEqual(first.manifests[index]?.tables);
    }
    expect(await createGitBackup(params)).toMatchObject({ noChanges: true });
  });

  it.skipIf(process.platform === "win32").each(["empty-directory", "directory", "symlink"])(
    "refuses a Finder-named %s before cleaning any agent scopes",
    async (kind) => {
      const root = roots.make("git-backup-finder-");
      const stateDir = path.join(root, "state");
      const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
      openOpenClawStateDatabase({ env });
      closeOpenClawStateDatabaseForTest();
      const database = {
        path: resolveOpenClawStateSqlitePath(env),
        identity: { role: "global" } as const,
      };
      const repositoryPath = path.join(root, "repository");
      await initializeGitBackupRepository({ repositoryPath, stateDir });
      const ownedAgentPath = path.join(repositoryPath, "agents", "old-agent");
      await writeBackupManifest(ownedAgentPath, "old-agent");
      const finderPath = path.join(repositoryPath, "agents", ".DS_Store");
      const payloadPath =
        kind === "symlink"
          ? path.join(root, "operator.txt")
          : path.join(finderPath, "operator.txt");
      if (kind === "symlink") {
        await fs.writeFile(payloadPath, "operator-owned\n");
        await fs.symlink(payloadPath, finderPath);
      } else {
        await fs.mkdir(finderPath);
        if (kind === "directory") {
          await fs.writeFile(payloadPath, "operator-owned\n");
        }
      }

      await expect(
        createGitBackup({ repositoryPath, stateDir, databases: [database], all: true }),
      ).rejects.toThrow(/Refusing to replace non-backup-owned path/u);
      const entry = await fs.lstat(finderPath);
      expect(kind === "symlink" ? entry.isSymbolicLink() : entry.isDirectory()).toBe(true);
      if (kind !== "empty-directory") {
        await expect(fs.readFile(payloadPath, "utf8")).resolves.toBe("operator-owned\n");
      }
      await expect(
        fs.readFile(path.join(ownedAgentPath, "manifest.json"), "utf8"),
      ).resolves.toContain('"schemaVersion":1');
    },
  );
});
