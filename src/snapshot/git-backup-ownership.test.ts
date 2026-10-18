import fs from "node:fs/promises";
import path from "node:path";
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
import { withDatabase } from "./local-repository.test-support.js";

const roots = useAutoCleanupTempDirTracker(afterEach);

const expectMissing = async (file: string) =>
  expect(fs.stat(file)).rejects.toMatchObject({ code: "ENOENT" });
const expectContents = async (file: string, contents: string) =>
  expect(fs.readFile(file, "utf8")).resolves.toBe(contents);
const expectPayload = (file: string, value: string) =>
  withDatabase(
    file,
    (database) =>
      expect(database.prepare("SELECT value FROM payload WHERE id = 1").get()).toEqual({ value }),
    { readOnly: true },
  );

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
    withDatabase(database.path, (source) => {
      source.exec("CREATE TABLE payload (id INTEGER PRIMARY KEY, value TEXT)");
      source.prepare("INSERT INTO payload VALUES (1, ?)").run(database.identity.role);
    });
  }
  const repositoryPath = path.join(root, "repository");
  await initializeGitBackupRepository({ repositoryPath, stateDir });
  await requireGit(repositoryPath, ["config", "user.name", "Backup fixture"]);
  await requireGit(repositoryPath, ["config", "user.email", "backup@example.invalid"]);
  const git = (...args: string[]) => requireGit(repositoryPath, args);
  const repoFile = (relative: string) => path.join(repositoryPath, relative);
  const backup = (databases = [global, agent]) =>
    createGitBackup({ repositoryPath, stateDir, databases, all: true });
  return { root, repositoryPath, stateDir, global, agent, git, repoFile, backup };
}

describe("Git backup artifact ownership", () => {
  it("preserves extras and their staging while refreshing and pruning declared artifacts", async () => {
    const { root, repositoryPath, global, agent, git, repoFile, backup } = await fixture();
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
      const destination = repoFile(file);
      await fs.mkdir(path.dirname(destination), { recursive: true });
      await fs.writeFile(destination, `operator document: ${file}\n`);
    }
    await git("add", "--", ...extras);
    const first = await backup();
    expect(first.commit).toMatch(/^[a-f0-9]{40}$/u);
    const staged = () => git("diff", "--cached", "--name-only");
    expect((await staged()).split("\n").toSorted()).toEqual(extras.toSorted());
    const firstTree = await git("ls-tree", "-r", "--name-only", "HEAD");
    for (const file of extras) {
      expect(firstTree.split("\n")).not.toContain(file);
    }
    const restored = await restoreGitBackupRef({
      repositoryPath,
      identity: agent.identity,
      targetPath: path.join(root, "restored.sqlite"),
    });
    expectPayload(restored.targetPath, "agent");

    for (const file of [
      "global/manifest.json",
      "agents/main/manifest.json",
      "agents/main/schema.sql",
      "agents/main/tables/payload.jsonl",
    ]) {
      await fs.rm(repoFile(file));
    }
    await expect(backup()).resolves.toMatchObject({ noChanges: true });
    expect((await staged()).split("\n").toSorted()).toEqual(extras.toSorted());

    withDatabase(agent.path, (source) => source.exec("DROP TABLE payload"));
    await backup();
    await expectMissing(repoFile("agents/main/tables/payload.jsonl"));
    expect(await git("ls-tree", "HEAD", "agents/main/tables/payload.jsonl")).toBe("");

    await fs.rm(repoFile("agents/main/manifest.json"));
    const pruned = await backup([global]);
    expect(pruned.commit).toMatch(/^[a-f0-9]{40}$/u);
    expect(await git("ls-tree", "HEAD", "agents/main")).toBe("");
    await expectMissing(repoFile("agents/main/manifest.json"));
    for (const file of extras) {
      await expectContents(repoFile(file), `operator document: ${file}\n`);
    }
    expect((await staged()).split("\n").toSorted()).toEqual(extras.toSorted());
    await expect(backup([global])).resolves.toMatchObject({ noChanges: true });
    expect(await git("rev-parse", "HEAD")).toBe(pruned.commit);
  });

  it("restores legacy refs without interpreting extras or rewriting their history", async () => {
    const { root, repositoryPath, global, agent, git, repoFile, backup } = await fixture();
    await backup();
    const extras = [
      "global/.DS_Store",
      "global/notes.txt",
      "global/tables/notes.jsonl",
      "agents/.DS_Store",
      "agents/main/.DS_Store",
      "agents/main/tables/.DS_Store",
    ];
    for (const file of extras) {
      await fs.writeFile(repoFile(file), `legacy operator document: ${file}\n`);
    }
    await git("add", "--", ...extras);
    await git("commit", "-m", "Operator documents");
    const legacy = await git("rev-parse", "HEAD");
    for (const database of [global, agent]) {
      const restored = await restoreGitBackupRef({
        repositoryPath,
        identity: database.identity,
        ref: legacy,
        targetPath: path.join(root, `${database.identity.role}-restored.sqlite`),
      });
      expectPayload(restored.targetPath, database.identity.role);
      expect(
        (
          await verifyGitBackupRef({ repositoryPath, identity: database.identity, ref: legacy })
        ).tables.every((table) => table.ok),
      ).toBe(true);
    }
    const stagedFile = "agents/main/.DS_Store";
    await fs.writeFile(repoFile(stagedFile), "operator staged revision\n");
    await git("add", "--", stagedFile);
    const stagedBlob = await git("rev-parse", `:${stagedFile}`);
    await fs.writeFile(repoFile(stagedFile), "operator unstaged revision\n");
    await expect(backup()).resolves.toMatchObject({ noChanges: true });
    expect(await git("rev-parse", "HEAD")).toBe(legacy);
    withDatabase(agent.path, (source) =>
      source.exec("UPDATE payload SET value = 'updated' WHERE id = 1"),
    );
    expect((await backup()).commit).not.toBe(legacy);
    for (const file of extras) {
      expect(await git("show", `HEAD:${file}`)).toBe(`legacy operator document: ${file}`);
      await expectContents(
        repoFile(file),
        file === stagedFile
          ? "operator unstaged revision\n"
          : `legacy operator document: ${file}\n`,
      );
    }
    expect(await git("rev-parse", `:${stagedFile}`)).toBe(stagedBlob);
    expect(await git("status", "--porcelain")).toBe(`MM ${stagedFile}`);
  });

  it("refuses actual artifact collisions before refresh or stale-scope cleanup", async () => {
    const { root, global, git, repoFile, backup } = await fixture();
    const first = await backup();
    const stale = repoFile("agents/old-agent");
    await writeBackupManifest(stale, "old-agent");
    const collision = repoFile("global/tables/new_table.jsonl");
    await fs.writeFile(collision, "operator document\n");
    withDatabase(global.path, (source) => {
      source.exec("CREATE TABLE new_table (value TEXT); INSERT INTO new_table VALUES ('database')");
    });
    await expect(backup()).rejects.toThrow(/non-backup-owned path/u);
    await expectContents(collision, "operator document\n");
    expect(await git("rev-parse", "HEAD")).toBe(first.commit);
    await expect(fs.stat(path.join(stale, "manifest.json"))).resolves.toBeDefined();

    await git("add", "--", "global/tables/new_table.jsonl");
    const stagedBlob = await git("rev-parse", ":global/tables/new_table.jsonl");
    await fs.rm(collision);
    await expect(backup()).rejects.toThrow(/non-backup-owned path/u);
    expect(await git("rev-parse", ":global/tables/new_table.jsonl")).toBe(stagedBlob);
    expect(await git("rev-parse", "HEAD")).toBe(first.commit);
    await expectMissing(collision);
    await expect(fs.stat(path.join(stale, "manifest.json"))).resolves.toBeDefined();

    await git("commit", "-m", "Operator document");
    const operatorHead = await git("rev-parse", "HEAD");
    await expect(backup()).rejects.toThrow(/non-backup-owned path/u);
    expect(await git("rev-parse", "HEAD")).toBe(operatorHead);
    expect(await git("show", "HEAD:global/tables/new_table.jsonl")).toBe("operator document");
    await expectMissing(collision);

    await git("rm", "--cached", "--", "global/tables/new_table.jsonl");
    await git("commit", "-m", "Remove operator document");
    const cleanHead = await git("rev-parse", "HEAD");

    if (process.platform !== "win32") {
      const external = path.join(root, "operator-schema.sql");
      await fs.writeFile(external, "operator schema\n");
      const schema = repoFile("global/schema.sql");
      await fs.rm(schema);
      await fs.symlink(external, schema);
      await expect(backup()).rejects.toThrow(/non-backup-owned path/u);
      expect((await fs.lstat(schema)).isSymbolicLink()).toBe(true);
      await expectContents(external, "operator schema\n");
      expect(await git("rev-parse", "HEAD")).toBe(cleanHead);
      await expect(fs.stat(path.join(stale, "manifest.json"))).resolves.toBeDefined();
    }
  });

  it("leaves a pending operator merge and its index unchanged", async () => {
    const { repositoryPath, stateDir, agent, git, repoFile } = await fixture();
    const params = { repositoryPath, stateDir, databases: [agent] };
    await createGitBackup(params);
    const branch = await git("branch", "--show-current");
    await git("checkout", "-b", "incoming");
    await fs.writeFile(repoFile("incoming.txt"), "incoming changes\n");
    await git("add", "incoming.txt");
    await git("commit", "-m", "Incoming changes");
    await git("checkout", branch);
    await fs.writeFile(repoFile("operator.txt"), "operator changes\n");
    await git("add", "operator.txt");
    await git("commit", "-m", "Operator changes");
    await git("merge", "--no-commit", "--no-ff", "incoming");
    const head = await git("rev-parse", "HEAD");
    const mergeHead = await git("rev-parse", "MERGE_HEAD");
    const staged = await git("diff", "--cached", "--raw");
    const artifact = repoFile("agents/main/tables/payload.jsonl");
    withDatabase(agent.path, (source) =>
      source.exec("UPDATE payload SET value = 'updated' WHERE id = 1"),
    );
    await expect(createGitBackup(params)).rejects.toThrow(/Git operation/u);
    expect(await git("rev-parse", "HEAD")).toBe(head);
    expect(await git("rev-parse", "MERGE_HEAD")).toBe(mergeHead);
    expect(await git("diff", "--cached", "--raw")).toBe(staged);
    await expectContents(artifact, '{"id":1,"value":"agent"}\n');
  });

  it("replaces owned directory entries without overwriting hardlink aliases", async () => {
    const { root, repositoryPath, stateDir, agent, repoFile } = await fixture();
    const params = { repositoryPath, stateDir, databases: [agent] };
    await createGitBackup(params);
    const payload = repoFile("agents/main/tables/payload.jsonl");
    const alias = path.join(root, "operator-copy.jsonl");
    await fs.link(payload, alias);
    const original = '{"id":1,"value":"agent"}\n';
    await expectContents(alias, original);
    withDatabase(agent.path, (source) =>
      source.exec("UPDATE payload SET value = 'updated' WHERE id = 1"),
    );
    await createGitBackup(params);
    await expectContents(alias, original);
    await expectContents(payload, '{"id":1,"value":"updated"}\n');
  });

  it("still refuses missing, non-regular, and corrupted declared payloads", async () => {
    const { root, repositoryPath, stateDir, agent, git, repoFile } = await fixture();
    const first = await createGitBackup({ repositoryPath, stateDir, databases: [agent] });
    const file = "agents/main/tables/payload.jsonl";
    const payload = repoFile(file);
    const cases =
      process.platform === "win32" ? ["missing", "corrupt"] : ["missing", "symlink", "corrupt"];
    for (const condition of cases) {
      await git("restore", `--source=${first.commit}`, "--", file);
      await fs.rm(payload);
      if (condition === "symlink") {
        await fs.symlink(path.join(root, "outside.jsonl"), payload);
      } else if (condition === "corrupt") {
        await fs.writeFile(payload, '{"id":1,"value":"tampered"}\n');
      }
      await git("add", "-A", "--", file);
      await git("commit", "-m", `Invalid declared payload: ${condition}`);
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
      await expectMissing(targetPath);
    }
  });
});
