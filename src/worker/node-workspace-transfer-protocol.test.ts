import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { withTempDir } from "../test-utils/temp-dir.js";
import { NODE_WORKSPACE_GIT_HISTORY_SCRIPT } from "./node-workspace-transfer-protocol.js";

const run = promisify(execFile);
const git = (cwd: string, args: string[], input?: string) =>
  new Promise<string>((resolve, reject) => {
    const identity = ["user.name=Fixture", "user.email=fixture@example.invalid"];
    const config = [
      ...identity,
      "commit.gpgSign=false",
      "core.longpaths=true",
      "protocol.file.allow=always",
    ];
    const child = execFile(
      "git",
      [...config.flatMap((entry) => ["-c", entry]), "-C", cwd, ...args],
      { encoding: "utf8" },
      (error, stdout) =>
        error ? reject(new Error(error.message, { cause: error })) : resolve(stdout.trim()),
    );
    child.stdin?.end(input);
  });
const exportHistory = async (root: string, baseCommit: string, packPath: string) =>
  JSON.parse(
    (
      await run(
        process.execPath,
        ["-e", NODE_WORKSPACE_GIT_HISTORY_SCRIPT, root, baseCommit, packPath],
        { encoding: "utf8" },
      )
    ).stdout,
  );

async function source(dir: string, format: "sha1" | "sha256") {
  const root = path.join(dir, `source-${format}`);
  await git(dir, ["init", "--quiet", `--object-format=${format}`, root]);
  await git(root, ["config", "uploadpack.allowFilter", "true"]);
  for (const content of ["one", "two"]) {
    await fs.writeFile(path.join(root, "file.txt"), content);
    await git(root, ["add", "file.txt"]);
    await git(root, ["commit", "--quiet", "-m", content]);
  }
  return { root, baseCommit: await git(root, ["rev-parse", "HEAD"]) };
}

const partialClone = (sourcePath: string) => [
  "--depth=1",
  "--filter=blob:none",
  "--no-local",
  pathToFileURL(sourcePath).href,
];
const layouts = [
  { format: "sha1", clone: (sourcePath: string) => ["--", sourcePath] },
  { format: "sha256", clone: partialClone },
] as const;

it.each(layouts)("exports $format worker history from a standalone checkout", async (layout) => {
  const { format, clone } = layout;
  await withTempDir("openclaw-git-history-", async (dir) => {
    const base = await source(dir, format);
    const worker =
      process.platform === "win32" && format === "sha1"
        ? path.join(
            dir,
            ...Array.from({ length: 6 }, (_, index) => `long-${index}-${"x".repeat(44)}`),
            "worker",
          )
        : path.join(dir, "worker");
    await fs.mkdir(path.dirname(worker), { recursive: true });
    await git(dir, ["clone", "--quiet", ...clone(base.root), worker]);
    await fs.writeFile(path.join(worker, "file.txt"), "worker");
    await git(worker, ["commit", "--quiet", "-am", "worker"]);
    const headCommit = await git(worker, ["rev-parse", "HEAD"]);
    const packPath = path.join(dir, "result.pack");

    await expect(exportHistory(worker, base.baseCommit, packPath)).resolves.toEqual({
      baseCommit: base.baseCommit,
      headCommit,
      descendsFromBase: true,
    });
    const receiver = path.join(dir, "receiver");
    await git(dir, ["init", "--quiet", `--object-format=${format}`, receiver]);
    await fs.copyFile(packPath, path.join(receiver, ".git", "objects", "pack", "result.pack"));
    await git(receiver, ["index-pack", path.join(".git", "objects", "pack", "result.pack")]);
    expect(await git(receiver, ["cat-file", "-t", headCommit])).toBe("commit");
    expect(await fs.readdir(dir)).not.toContainEqual(expect.stringContaining("git-view-"));
  });
});

it("never lazily fetches through worker-controlled repository config", async () => {
  await withTempDir("openclaw-git-history-", async (dir) => {
    const base = await source(dir, "sha1");
    const worker = path.join(dir, "worker");
    const marker = path.join(dir, "executed");
    await git(dir, ["clone", "--quiet", ...partialClone(base.root), worker]);
    await git(worker, ["remote", "set-url", "origin", "ssh://example.invalid/repository.git"]);
    await git(worker, ["config", "core.sshCommand", `touch '${marker}' #`]);
    const blob = await git(worker, ["hash-object", "--stdin"], "promised but absent");
    const tree = await git(worker, ["mktree", "--missing"], `100644 blob ${blob}\tpromised.txt\n`);
    const commit = await git(worker, ["commit-tree", tree, "-p", "HEAD", "-m", "promised"]);
    await git(worker, ["update-ref", "HEAD", commit]);
    // Prove that this platform can execute the configured helper before testing its removal.
    await git(
      worker,
      ["pack-objects", "--revs", "--stdout"],
      `${commit}\n^${base.baseCommit}\n`,
    ).catch(() => undefined);
    await fs.access(marker);
    await fs.rm(marker);

    const history = await exportHistory(worker, base.baseCommit, path.join(dir, "result.pack"));
    expect(history).toMatchObject({ headCommit: commit, descendsFromBase: true });
    expect(history.unavailableReason).toMatch(/^Worker Git pack failed/u);
    await expect(fs.access(marker)).rejects.toThrow();
    await expect(fs.access(path.join(dir, "result.pack"))).rejects.toThrow();
  });
});

it("does not follow a gitdir pointer to another repository", async () => {
  await withTempDir("openclaw-git-history-", async (dir) => {
    const base = await source(dir, "sha1");
    await fs.writeFile(path.join(base.root, "host.txt"), "host only");
    await git(base.root, ["add", "host.txt"]);
    await git(base.root, ["commit", "--quiet", "-m", "host only"]);
    const worker = path.join(dir, "worker");
    await fs.mkdir(worker);
    await fs.writeFile(path.join(worker, ".git"), `gitdir: ${path.join(base.root, ".git")}\n`);

    const history = await exportHistory(worker, base.baseCommit, path.join(dir, "result.pack"));
    expect(history).toEqual({
      baseCommit: base.baseCommit,
      headCommit: base.baseCommit,
      descendsFromBase: false,
      unavailableReason: "worker Git repository is not a standalone checkout",
    });
    await expect(fs.access(path.join(dir, "result.pack"))).rejects.toThrow();
  });
});

it.each(["commondir", "alternates", "http-alternates", "objects-symlink"] as const)(
  "does not export worker history through %s metadata",
  async (layout) => {
    await withTempDir("openclaw-git-history-", async (dir) => {
      const base = await source(dir, "sha1");
      const worker = path.join(dir, "worker");
      await git(dir, ["clone", "--quiet", "--", base.root, worker]);
      const gitDir = path.join(worker, ".git");
      const outside = path.join(base.root, ".git");
      if (layout === "commondir") {
        await fs.writeFile(path.join(gitDir, "commondir"), outside + "\n");
      } else if (layout === "objects-symlink") {
        await fs.rm(path.join(gitDir, "objects"), { recursive: true });
        await fs.symlink(
          path.join(outside, "objects"),
          path.join(gitDir, "objects"),
          process.platform === "win32" ? "junction" : "dir",
        );
      } else {
        await fs.mkdir(path.join(gitDir, "objects", "info"), { recursive: true });
        await fs.writeFile(
          path.join(gitDir, "objects", "info", layout),
          path.join(outside, "objects") + "\n",
        );
      }
      await expect(
        exportHistory(worker, base.baseCommit, path.join(dir, "result.pack")),
      ).resolves.toMatchObject({
        descendsFromBase: false,
        unavailableReason: "worker Git repository is not a standalone checkout",
      });
      await expect(fs.access(path.join(dir, "result.pack"))).rejects.toThrow();
    });
  },
);
