import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { requireGitCommand as requireGit } from "../infra/git-exec.js";
import {
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
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
import { writeBackupManifest } from "./git-backup.test-support.js";

const roots = useAutoCleanupTempDirTracker(afterEach);

afterEach(async () => {
  await closeOpenClawAgentDatabasesAsync();
  await closeOpenClawStateDatabaseAsync();
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
});

async function fixture() {
  const root = roots.make("git-backup-ownership-");
  const stateDir = path.join(root, "state");
  const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
  openOpenClawStateDatabase({ env });
  await closeOpenClawStateDatabaseAsync();
  closeOpenClawStateDatabaseForTest();
  const global = {
    path: resolveOpenClawStateSqlitePath(env),
    identity: { role: "global" } as const,
  };
  const agent = {
    path: path.join(root, "agent.sqlite"),
    identity: { role: "agent", agentId: "main" } as const,
  };
  openOpenClawAgentDatabase({ agentId: "main", path: agent.path, env });
  await closeOpenClawAgentDatabasesAsync();
  closeOpenClawAgentDatabasesForTest();
  await closeOpenClawStateDatabaseAsync();
  closeOpenClawStateDatabaseForTest();
  for (const database of [global, agent]) {
    const source = new DatabaseSync(database.path);
    try {
      source.exec("CREATE TABLE payload (id INTEGER PRIMARY KEY, value TEXT)");
      source.prepare("INSERT INTO payload VALUES (1, ?)").run(database.identity.role);
    } finally {
      source.close();
    }
  }
  const repositoryPath = path.join(root, "repository");
  await initializeGitBackupRepository({ repositoryPath, stateDir });
  await requireGit(repositoryPath, ["config", "user.name", "Backup fixture"]);
  await requireGit(repositoryPath, ["config", "user.email", "backup@example.invalid"]);
  return { root, repositoryPath, stateDir, global, agent };
}

describe("Git backup artifact ownership", () => {
  it("preserves extras and their staging while refreshing and pruning declared artifacts", async () => {
    const { root, repositoryPath, stateDir, global, agent } = await fixture();
    const extras = [
      "unrelated.txt",
      "agents/.DS_Store",
      "agents/desktop.ini",
      "agents/operator/notes.txt",
      "agents/main/notes.txt",
      "agents/main/tables/notes.jsonl",
      "global/.DS_Store",
      "global/tables/notes.jsonl",
    ];
    for (const file of extras) {
      const destination = path.join(repositoryPath, file);
      await fs.mkdir(path.dirname(destination), { recursive: true });
      await fs.writeFile(destination, `operator document: ${file}\n`);
    }
    await requireGit(repositoryPath, ["add", "--", ...extras]);
    const first = await createGitBackup({
      repositoryPath,
      stateDir,
      databases: [global, agent],
      all: true,
    });
    expect(first.commit).toMatch(/^[a-f0-9]{40}$/u);
    const staged = () => requireGit(repositoryPath, ["diff", "--cached", "--name-only"]);
    expect((await staged()).split("\n").toSorted()).toEqual(extras.toSorted());
    const firstTree = await requireGit(repositoryPath, ["ls-tree", "-r", "--name-only", "HEAD"]);
    for (const file of extras) {
      expect(firstTree.split("\n")).not.toContain(file);
    }
    const restored = await restoreGitBackupRef({
      repositoryPath,
      identity: agent.identity,
      targetPath: path.join(root, "restored.sqlite"),
    });
    const recovered = new DatabaseSync(restored.targetPath, { readOnly: true });
    try {
      expect(recovered.prepare("SELECT value FROM payload WHERE id = 1").get()).toEqual({
        value: "agent",
      });
    } finally {
      recovered.close();
    }

    for (const file of [
      "global/manifest.json",
      "agents/main/manifest.json",
      "agents/main/schema.sql",
      "agents/main/tables/payload.jsonl",
    ]) {
      await fs.rm(path.join(repositoryPath, file));
    }
    await expect(
      createGitBackup({ repositoryPath, stateDir, databases: [global, agent], all: true }),
    ).resolves.toMatchObject({ noChanges: true });
    expect((await staged()).split("\n").toSorted()).toEqual(extras.toSorted());

    const source = new DatabaseSync(agent.path);
    try {
      source.exec("DROP TABLE payload");
    } finally {
      source.close();
    }
    await createGitBackup({ repositoryPath, stateDir, databases: [global, agent], all: true });
    await expect(
      fs.stat(path.join(repositoryPath, "agents/main/tables/payload.jsonl")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(
      await requireGit(repositoryPath, ["ls-tree", "HEAD", "agents/main/tables/payload.jsonl"]),
    ).toBe("");

    await fs.rm(path.join(repositoryPath, "agents/main/manifest.json"));
    const pruned = await createGitBackup({
      repositoryPath,
      stateDir,
      databases: [global],
      all: true,
    });
    expect(pruned.commit).toMatch(/^[a-f0-9]{40}$/u);
    expect(await requireGit(repositoryPath, ["ls-tree", "HEAD", "agents/main"])).toBe("");
    await expect(
      fs.stat(path.join(repositoryPath, "agents/main/manifest.json")),
    ).rejects.toMatchObject({
      code: "ENOENT",
    });
    for (const file of extras) {
      await expect(fs.readFile(path.join(repositoryPath, file), "utf8")).resolves.toBe(
        `operator document: ${file}\n`,
      );
    }
    expect((await staged()).split("\n").toSorted()).toEqual(extras.toSorted());
    await expect(
      createGitBackup({ repositoryPath, stateDir, databases: [global], all: true }),
    ).resolves.toMatchObject({ noChanges: true });
    expect(await requireGit(repositoryPath, ["rev-parse", "HEAD"])).toBe(pruned.commit);
  });

  it("restores legacy refs without interpreting extras or rewriting their history", async () => {
    const { root, repositoryPath, stateDir, global, agent } = await fixture();
    const params = { repositoryPath, stateDir, databases: [global, agent], all: true };
    await createGitBackup(params);
    const extras = [
      "global/.DS_Store",
      "global/notes.txt",
      "global/tables/notes.jsonl",
      "agents/.DS_Store",
      "agents/main/.DS_Store",
      "agents/main/tables/.DS_Store",
    ];
    for (const file of extras) {
      await fs.writeFile(path.join(repositoryPath, file), `legacy operator document: ${file}\n`);
    }
    await requireGit(repositoryPath, ["add", "--", ...extras]);
    await requireGit(repositoryPath, ["commit", "-m", "Operator documents"]);
    const legacy = await requireGit(repositoryPath, ["rev-parse", "HEAD"]);
    for (const database of [global, agent]) {
      const restored = await restoreGitBackupRef({
        repositoryPath,
        identity: database.identity,
        ref: legacy,
        targetPath: path.join(root, `${database.identity.role}-restored.sqlite`),
      });
      const recovered = new DatabaseSync(restored.targetPath, { readOnly: true });
      try {
        expect(recovered.prepare("SELECT value FROM payload WHERE id = 1").get()).toEqual({
          value: database.identity.role,
        });
      } finally {
        recovered.close();
      }
      expect(
        (
          await verifyGitBackupRef({ repositoryPath, identity: database.identity, ref: legacy })
        ).tables.every((table) => table.ok),
      ).toBe(true);
    }
    const stagedFile = "agents/main/.DS_Store";
    await fs.writeFile(path.join(repositoryPath, stagedFile), "operator staged revision\n");
    await requireGit(repositoryPath, ["add", "--", stagedFile]);
    const stagedBlob = await requireGit(repositoryPath, ["rev-parse", `:${stagedFile}`]);
    await fs.writeFile(path.join(repositoryPath, stagedFile), "operator unstaged revision\n");
    await expect(createGitBackup(params)).resolves.toMatchObject({ noChanges: true });
    expect(await requireGit(repositoryPath, ["rev-parse", "HEAD"])).toBe(legacy);
    const source = new DatabaseSync(agent.path);
    try {
      source.exec("UPDATE payload SET value = 'updated' WHERE id = 1");
    } finally {
      source.close();
    }
    expect((await createGitBackup(params)).commit).not.toBe(legacy);
    for (const file of extras) {
      expect(await requireGit(repositoryPath, ["show", `HEAD:${file}`])).toBe(
        `legacy operator document: ${file}`,
      );
      await expect(fs.readFile(path.join(repositoryPath, file), "utf8")).resolves.toBe(
        file === stagedFile
          ? "operator unstaged revision\n"
          : `legacy operator document: ${file}\n`,
      );
    }
    expect(await requireGit(repositoryPath, ["rev-parse", `:${stagedFile}`])).toBe(stagedBlob);
    expect(await requireGit(repositoryPath, ["status", "--porcelain"])).toBe(`MM ${stagedFile}`);
  });

  it("refuses actual artifact collisions before refresh or stale-scope cleanup", async () => {
    const { root, repositoryPath, stateDir, global, agent } = await fixture();
    const params = { repositoryPath, stateDir, databases: [global, agent], all: true };
    const first = await createGitBackup(params);
    const stale = path.join(repositoryPath, "agents/old-agent");
    await writeBackupManifest(stale, "old-agent");
    const collision = path.join(repositoryPath, "global/tables/new_table.jsonl");
    await fs.writeFile(collision, "operator document\n");
    const source = new DatabaseSync(global.path);
    try {
      source.exec("CREATE TABLE new_table (value TEXT); INSERT INTO new_table VALUES ('database')");
    } finally {
      source.close();
    }
    await expect(createGitBackup(params)).rejects.toThrow(/non-backup-owned path/u);
    await expect(fs.readFile(collision, "utf8")).resolves.toBe("operator document\n");
    expect(await requireGit(repositoryPath, ["rev-parse", "HEAD"])).toBe(first.commit);
    await expect(fs.stat(path.join(stale, "manifest.json"))).resolves.toBeDefined();

    await requireGit(repositoryPath, ["add", "--", "global/tables/new_table.jsonl"]);
    const stagedBlob = await requireGit(repositoryPath, [
      "rev-parse",
      ":global/tables/new_table.jsonl",
    ]);
    await fs.rm(collision);
    await expect(createGitBackup(params)).rejects.toThrow(/non-backup-owned path/u);
    expect(await requireGit(repositoryPath, ["rev-parse", ":global/tables/new_table.jsonl"])).toBe(
      stagedBlob,
    );
    expect(await requireGit(repositoryPath, ["rev-parse", "HEAD"])).toBe(first.commit);
    await expect(fs.stat(collision)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.stat(path.join(stale, "manifest.json"))).resolves.toBeDefined();

    await requireGit(repositoryPath, ["commit", "-m", "Operator document"]);
    const operatorHead = await requireGit(repositoryPath, ["rev-parse", "HEAD"]);
    await expect(createGitBackup(params)).rejects.toThrow(/non-backup-owned path/u);
    expect(await requireGit(repositoryPath, ["rev-parse", "HEAD"])).toBe(operatorHead);
    expect(await requireGit(repositoryPath, ["show", "HEAD:global/tables/new_table.jsonl"])).toBe(
      "operator document",
    );
    await expect(fs.stat(collision)).rejects.toMatchObject({ code: "ENOENT" });

    await requireGit(repositoryPath, ["rm", "--cached", "--", "global/tables/new_table.jsonl"]);
    await requireGit(repositoryPath, ["commit", "-m", "Remove operator document"]);
    const cleanHead = await requireGit(repositoryPath, ["rev-parse", "HEAD"]);

    if (process.platform !== "win32") {
      const external = path.join(root, "operator-schema.sql");
      await fs.writeFile(external, "operator schema\n");
      const schema = path.join(repositoryPath, "global/schema.sql");
      await fs.rm(schema);
      await fs.symlink(external, schema);
      await expect(createGitBackup(params)).rejects.toThrow(/non-backup-owned path/u);
      expect((await fs.lstat(schema)).isSymbolicLink()).toBe(true);
      await expect(fs.readFile(external, "utf8")).resolves.toBe("operator schema\n");
      expect(await requireGit(repositoryPath, ["rev-parse", "HEAD"])).toBe(cleanHead);
      await expect(fs.stat(path.join(stale, "manifest.json"))).resolves.toBeDefined();
    }
  });

  it("leaves a pending operator merge and its index unchanged", async () => {
    const { repositoryPath, stateDir, agent } = await fixture();
    const params = { repositoryPath, stateDir, databases: [agent] };
    await createGitBackup(params);
    const branch = await requireGit(repositoryPath, ["branch", "--show-current"]);
    await requireGit(repositoryPath, ["checkout", "-b", "incoming"]);
    await fs.writeFile(path.join(repositoryPath, "incoming.txt"), "incoming changes\n");
    await requireGit(repositoryPath, ["add", "incoming.txt"]);
    await requireGit(repositoryPath, ["commit", "-m", "Incoming changes"]);
    await requireGit(repositoryPath, ["checkout", branch]);
    await fs.writeFile(path.join(repositoryPath, "operator.txt"), "operator changes\n");
    await requireGit(repositoryPath, ["add", "operator.txt"]);
    await requireGit(repositoryPath, ["commit", "-m", "Operator changes"]);
    await requireGit(repositoryPath, ["merge", "--no-commit", "--no-ff", "incoming"]);
    const head = await requireGit(repositoryPath, ["rev-parse", "HEAD"]);
    const mergeHead = await requireGit(repositoryPath, ["rev-parse", "MERGE_HEAD"]);
    const staged = await requireGit(repositoryPath, ["diff", "--cached", "--raw"]);
    const artifact = path.join(repositoryPath, "agents/main/tables/payload.jsonl");
    const source = new DatabaseSync(agent.path);
    try {
      source.exec("UPDATE payload SET value = 'updated' WHERE id = 1");
    } finally {
      source.close();
    }
    await expect(createGitBackup(params)).rejects.toThrow(/Git operation/u);
    expect(await requireGit(repositoryPath, ["rev-parse", "HEAD"])).toBe(head);
    expect(await requireGit(repositoryPath, ["rev-parse", "MERGE_HEAD"])).toBe(mergeHead);
    expect(await requireGit(repositoryPath, ["diff", "--cached", "--raw"])).toBe(staged);
    await expect(fs.readFile(artifact, "utf8")).resolves.toBe('{"id":1,"value":"agent"}\n');
  });

  it("replaces owned directory entries without overwriting hardlink aliases", async () => {
    const { root, repositoryPath, stateDir, agent } = await fixture();
    const params = { repositoryPath, stateDir, databases: [agent] };
    await createGitBackup(params);
    const payload = path.join(repositoryPath, "agents/main/tables/payload.jsonl");
    const alias = path.join(root, "operator-copy.jsonl");
    await fs.link(payload, alias);
    const original = '{"id":1,"value":"agent"}\n';
    await expect(fs.readFile(alias, "utf8")).resolves.toBe(original);
    const source = new DatabaseSync(agent.path);
    try {
      source.exec("UPDATE payload SET value = 'updated' WHERE id = 1");
    } finally {
      source.close();
    }
    await createGitBackup(params);
    await expect(fs.readFile(alias, "utf8")).resolves.toBe(original);
    await expect(fs.readFile(payload, "utf8")).resolves.toBe('{"id":1,"value":"updated"}\n');
  });

  it("still refuses missing, non-regular, and corrupted declared payloads", async () => {
    const { root, repositoryPath, stateDir, agent } = await fixture();
    const first = await createGitBackup({ repositoryPath, stateDir, databases: [agent] });
    const file = "agents/main/tables/payload.jsonl";
    const payload = path.join(repositoryPath, file);
    const cases =
      process.platform === "win32" ? ["missing", "corrupt"] : ["missing", "symlink", "corrupt"];
    for (const condition of cases) {
      await requireGit(repositoryPath, ["restore", `--source=${first.commit}`, "--", file]);
      await fs.rm(payload);
      if (condition === "symlink") {
        await fs.symlink(path.join(root, "outside.jsonl"), payload);
      } else if (condition === "corrupt") {
        await fs.writeFile(payload, '{"id":1,"value":"tampered"}\n');
      }
      await requireGit(repositoryPath, ["add", "-A", "--", file]);
      await requireGit(repositoryPath, ["commit", "-m", `Invalid declared payload: ${condition}`]);
      const targetPath = path.join(root, `${condition}.sqlite`);
      await expect(
        restoreGitBackupRef({ repositoryPath, identity: agent.identity, targetPath }),
      ).rejects.toThrow(
        condition === "missing"
          ? /does not contain|ENOENT/u
          : condition === "symlink"
            ? /regular/u
            : /hash mismatch/u,
      );
      await expect(fs.stat(targetPath)).rejects.toMatchObject({ code: "ENOENT" });
    }
  });
});
