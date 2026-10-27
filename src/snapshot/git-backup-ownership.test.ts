import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
} from "../state/openclaw-agent-db.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
} from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import type { GitBackupIdentity } from "./git-backup-codec.js";
import { createGitBackup, restoreGitBackupRef, verifyGitBackupRef } from "./git-backup.js";
import {
  expectDatabaseRows,
  gitBackupRepository,
  writeBackupManifest,
} from "./git-backup.test-support.js";
import {
  createAgentDatabase,
  createGlobalDatabase,
} from "./local-repository.schema.test-support.js";
import { expectMissing, withDatabase } from "./local-repository.test-support.js";

const roots = useAutoCleanupTempDirTracker(afterEach);

const expectContents = async (file: string, contents: string) =>
  expect(fs.readFile(file, "utf8")).resolves.toBe(contents);

afterEach(async () => {
  await closeOpenClawAgentDatabasesAsync();
  await closeOpenClawStateDatabaseAsync();
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
});

async function fixture(all = true) {
  const root = roots.make("git-backup-ownership-");
  const repository = gitBackupRepository(root);
  const { stateDir, repositoryPath, file: repoFile } = repository;
  const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
  const global = {
    path: resolveOpenClawStateSqlitePath(env),
    identity: { role: "global" } as const,
  };
  const agent = {
    path: path.join(root, "agent.sqlite"),
    identity: { role: "agent", agentId: "main" } as const,
  };
  await fs.mkdir(path.dirname(global.path), { recursive: true });
  createGlobalDatabase(global.path);
  createAgentDatabase(agent.path, "main");
  for (const database of [global, agent]) {
    withDatabase(database.path, (source) => {
      source.exec("CREATE TABLE payload (id INTEGER PRIMARY KEY, value TEXT)");
      source.prepare("INSERT INTO payload VALUES (1, ?)").run(database.identity.role);
    });
  }
  await repository.init();
  await repository.configureIdentity();
  const backup = (databases = all ? [global, agent] : [agent]) =>
    createGitBackup({ repositoryPath, stateDir, databases, all });
  const updateAgent = () =>
    withDatabase(agent.path, (source) =>
      source.exec("UPDATE payload SET value = 'updated' WHERE id = 1"),
    );
  const restore = (name: string, identity: GitBackupIdentity = agent.identity, ref?: string) =>
    restoreGitBackupRef({
      repositoryPath,
      identity,
      ref,
      targetPath: path.join(root, `${name}.sqlite`),
    });
  return { ...repository, global, agent, repoFile, backup, updateAgent, restore };
}

it("preserves extras and their staging while refreshing and pruning declared artifacts", async () => {
  const { global, agent, git, repoFile, backup, write } = await fixture();
  const extras = [
    "unrelated.txt",
    "agents/.DS_Store",
    "agents/operator/notes.txt",
    "agents/main/notes.txt",
    "agents/main/tables/notes.jsonl",
    "global/.DS_Store",
    "global/tables/notes.jsonl",
  ];
  for (const file of extras) {
    await write(file, `operator document: ${file}\n`);
  }
  await git("add", "--", ...extras);
  await backup();
  const staged = () => git("diff", "--cached", "--name-only");
  expect((await staged()).split("\n").toSorted()).toEqual(extras.toSorted());
  const firstTree = await git("ls-tree", "-r", "--name-only", "HEAD");
  for (const file of extras) {
    expect(firstTree.split("\n")).not.toContain(file);
  }

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
  const expired = repoFile("agents/expired");
  await writeBackupManifest(expired, "expired");
  const untracked = "agents/operator-untracked/notes.txt";
  await write(untracked, "operator-owned\n");
  const pruned = await backup([global]);
  await expectMissing(expired);
  expect(await git("ls-tree", "HEAD", "agents/main")).toBe("");
  await expectMissing(repoFile("agents/main/manifest.json"));
  for (const file of extras) {
    await expectContents(repoFile(file), `operator document: ${file}\n`);
  }
  await expectContents(repoFile(untracked), "operator-owned\n");
  expect(await git("status", "--porcelain", "--untracked-files=all", "--", untracked)).toBe(
    `?? ${untracked}`,
  );
  expect((await staged()).split("\n").toSorted()).toEqual(extras.toSorted());
  await expect(backup([global])).resolves.toMatchObject({ noChanges: true });
  expect(await git("rev-parse", "HEAD")).toBe(pruned.commit);
});

it("restores legacy refs without interpreting extras or rewriting their history", async () => {
  const { repositoryPath, global, agent, git, repoFile, backup, updateAgent, restore } =
    await fixture();
  await backup();
  const extras = [
    "global/.DS_Store",
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
    const restored = await restore(`${database.identity.role}-restored`, database.identity, legacy);
    expectDatabaseRows(restored.targetPath, {
      "SELECT value FROM payload WHERE id = 1": [{ value: database.identity.role }],
    });
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
  updateAgent();
  expect((await backup()).commit).not.toBe(legacy);
  for (const file of extras) {
    expect(await git("show", `HEAD:${file}`)).toBe(`legacy operator document: ${file}`);
    await expectContents(
      repoFile(file),
      file === stagedFile ? "operator unstaged revision\n" : `legacy operator document: ${file}\n`,
    );
  }
  expect(await git("rev-parse", `:${stagedFile}`)).toBe(stagedBlob);
  expect(await git("status", "--porcelain")).toBe(`MM ${stagedFile}`);
});

it.each(
  process.platform === "win32"
    ? ["untracked", "staged", "committed"]
    : ["untracked", "staged", "committed", "symlink"],
)("refuses a %s artifact collision before refresh or stale-scope cleanup", async (kind) => {
  const { root, global, git, repoFile, backup } = await fixture();
  await backup();
  const stale = repoFile("agents/old-agent");
  await writeBackupManifest(stale, "old-agent");
  const external = path.join(root, "operator-schema.sql");
  const relative = kind === "symlink" ? "global/schema.sql" : "global/tables/new_table.jsonl";
  const collision = repoFile(relative);
  if (kind === "symlink") {
    await fs.writeFile(external, "operator schema\n");
    await fs.rm(collision);
    await fs.symlink(external, collision);
  } else {
    withDatabase(global.path, (source) =>
      source.exec("CREATE TABLE new_table (value TEXT); INSERT INTO new_table VALUES ('database')"),
    );
    await fs.writeFile(collision, "operator document\n");
    if (kind !== "untracked") {
      await git("add", "--", relative);
      if (kind === "committed") {
        await git("commit", "-m", "Operator document");
      }
      await fs.rm(collision);
    }
  }
  const head = await git("rev-parse", "HEAD");
  const staged = kind === "staged" ? await git("rev-parse", `:${relative}`) : undefined;
  await expect(backup()).rejects.toThrow(/non-backup-owned path/u);
  expect(await git("rev-parse", "HEAD")).toBe(head);
  await expect(fs.stat(path.join(stale, "manifest.json"))).resolves.toBeDefined();
  if (kind === "symlink") {
    expect((await fs.lstat(collision)).isSymbolicLink()).toBe(true);
    await expectContents(external, "operator schema\n");
  } else if (kind === "untracked") {
    await expectContents(collision, "operator document\n");
  } else {
    await expectMissing(collision);
    if (kind === "staged") {
      expect(await git("rev-parse", `:${relative}`)).toBe(staged);
    } else {
      expect(await git("show", `HEAD:${relative}`)).toBe("operator document");
    }
  }
});

it("leaves a pending operator merge and its index unchanged", async () => {
  const { git, repoFile, backup, updateAgent, write, commit } = await fixture(false);
  await backup();
  const branch = await git("branch", "--show-current");
  await git("checkout", "-b", "incoming");
  await write("incoming.txt", "incoming changes\n");
  await commit("Incoming changes", "incoming.txt");
  await git("checkout", branch);
  await write("operator.txt", "operator changes\n");
  await commit("Operator changes", "operator.txt");
  await git("merge", "--no-commit", "--no-ff", "incoming");
  const head = await git("rev-parse", "HEAD");
  const mergeHead = await git("rev-parse", "MERGE_HEAD");
  const staged = await git("diff", "--cached", "--raw");
  const artifact = repoFile("agents/main/tables/payload.jsonl");
  updateAgent();
  await expect(backup()).rejects.toThrow(/Git operation/u);
  expect(await git("rev-parse", "HEAD")).toBe(head);
  expect(await git("rev-parse", "MERGE_HEAD")).toBe(mergeHead);
  expect(await git("diff", "--cached", "--raw")).toBe(staged);
  await expectContents(artifact, '{"id":1,"value":"agent"}\n');
});

it("replaces owned directory entries without overwriting hardlink aliases", async () => {
  const { root, repoFile, backup, updateAgent } = await fixture(false);
  await backup();
  const payload = repoFile("agents/main/tables/payload.jsonl");
  const alias = path.join(root, "operator-copy.jsonl");
  await fs.link(payload, alias);
  const original = '{"id":1,"value":"agent"}\n';
  await expectContents(alias, original);
  updateAgent();
  await backup();
  await expectContents(alias, original);
  await expectContents(payload, '{"id":1,"value":"updated"}\n');
});

it("still refuses missing, non-regular, and corrupted declared payloads", async () => {
  const { root, git, repoFile, backup, restore } = await fixture(false);
  const first = await backup();
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
    await expect(restore(condition)).rejects.toThrow(
      condition === "missing"
        ? /does not contain|ENOENT/u
        : condition === "symlink"
          ? /regular/u
          : /hash mismatch/u,
    );
    await expectMissing(path.join(root, `${condition}.sqlite`));
  }
});
