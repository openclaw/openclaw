import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { ManagedWorktreeService } from "./service.js";

const execFileAsync = promisify(execFile);
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

async function git(cwd: string, ...args: string[]): Promise<void> {
  await execFileAsync("git", ["-C", cwd, ...args]);
}

describe("ManagedWorktreeService branch discovery", () => {
  let root: string;
  let repo: string;
  let service: ManagedWorktreeService;

  beforeEach(async () => {
    root = tempDirs.make("openclaw-worktree-branches-", await fs.realpath(os.tmpdir()));
    const template = path.join(root, "git-template");
    repo = path.join(root, "repo");
    await fs.mkdir(path.join(template, "hooks"), { recursive: true });
    await fs.mkdir(repo);
    await git(repo, "init", "-b", "main", `--template=${template}`);
    await git(repo, "config", "user.name", "OpenClaw Test");
    await git(repo, "config", "user.email", "openclaw-test@example.invalid");
    await fs.writeFile(path.join(repo, "README.md"), "base\n");
    await git(repo, "add", "README.md");
    await git(repo, "commit", "-m", "initial");
    service = new ManagedWorktreeService({
      env: { ...process.env, OPENCLAW_STATE_DIR: path.join(root, "state") },
    });
  });

  afterEach(async () => {
    closeOpenClawStateDatabaseForTest();
    await fs.rm(root, { recursive: true, force: true });
  });

  it("reports Git, plain-directory, and unavailable repository status", async () => {
    const nested = path.join(repo, "packages", "app");
    await fs.mkdir(nested, { recursive: true });
    await expect(
      service.listRepositoryBranches(nested, { includeRepositoryStatus: true }),
    ).resolves.toMatchObject({ repositoryStatus: "git" });

    const plain = path.join(root, "plain");
    await fs.mkdir(plain);
    await expect(
      service.listRepositoryBranches(plain, { includeRepositoryStatus: true }),
    ).resolves.toEqual({ branches: [], repositoryStatus: "not_git" });
    await expect(service.listRepositoryBranches(plain)).rejects.toThrow("not a git checkout");

    const malformed = path.join(root, "malformed");
    await fs.mkdir(malformed);
    await fs.writeFile(path.join(malformed, ".git"), "not a gitdir pointer\n");
    await expect(
      service.listRepositoryBranches(malformed, { includeRepositoryStatus: true }),
    ).resolves.toEqual({ branches: [], repositoryStatus: "unavailable" });
    await expect(
      service.listRepositoryBranches(path.join(root, "missing"), {
        includeRepositoryStatus: true,
      }),
    ).resolves.toEqual({ branches: [], repositoryStatus: "unavailable" });
  });

  it.skipIf(process.platform !== "win32")(
    "lists branches when Windows Git emits MSYS paths and preserves HEAD^{commit}",
    async () => {
      const result = await service.listRepositoryBranches(repo);

      expect(result.headBranch).toBe("main");
      expect(result.branches).toContainEqual({ name: "main", kind: "local" });
    },
  );

  it("keeps large repositories usable with bounded suggestions and an explicit unlisted base", async () => {
    const { stdout } = await execFileAsync("git", ["-C", repo, "rev-parse", "HEAD"]);
    const commit = stdout.trim();
    const refs = [
      ...["refs/heads", "refs/remotes/origin"].flatMap((prefix) =>
        Array.from(
          { length: 3_000 },
          (_, index) => `${prefix}/overflow-${String(index).padStart(80, "0")}`,
        ),
      ),
      "refs/remotes/origin/z-default",
    ].toSorted();
    await fs.writeFile(
      path.join(repo, ".git", "packed-refs"),
      "# pack-refs with: peeled fully-peeled sorted\n" +
        refs.map((ref) => `${commit} ${ref}`).join("\n") +
        "\n",
    );

    await git(repo, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/z-default");
    await git(repo, "switch", "-c", "z-current");
    const inventory = await execFileAsync("git", [
      "-C",
      repo,
      "for-each-ref",
      "--format=%(refname)",
      "refs/remotes",
    ]);
    expect(Buffer.byteLength(inventory.stdout)).toBeGreaterThan(256 * 1024);

    const result = await service.listRepositoryBranches(repo, { includeRepositoryStatus: true });
    expect(result.repositoryStatus).toBe("git");
    expect(result.branches.length).toBeLessThanOrEqual(202);
    expect(result.defaultBranch).toBe("origin/z-default");
    expect(result.headBranch).toBe("z-current");
    expect(result.branches.slice(0, 2)).toEqual([
      { name: "origin/z-default", kind: "remote" },
      { name: "z-current", kind: "local" },
    ]);
    const baseRef = `origin/overflow-${String(2_999).padStart(80, "0")}`;
    expect(result.branches.some((branch) => branch.name === baseRef)).toBe(false);
    const worktree = await service.create({ repoRoot: repo, name: "unlisted-base", baseRef });
    const createdHead = await execFileAsync("git", ["-C", worktree.path, "rev-parse", "HEAD"]);
    expect(createdHead.stdout.trim()).toBe(commit);
    await expect(
      service.create({ repoRoot: repo, name: "invalid-base", baseRef: "missing-branch" }),
    ).rejects.toThrow(/base ref|resolve|revision/i);
  });

  it("retains Git availability without parsing suggestions that exceed the byte guard", async () => {
    const { stdout } = await execFileAsync("git", ["-C", repo, "rev-parse", "HEAD"]);
    const prefix = "segment/".repeat(400);
    const refs = Array.from(
      { length: 100 },
      (_, index) =>
        `${stdout.trim()} refs/remotes/origin/${prefix}${String(index).padStart(3, "0")}`,
    );
    await fs.writeFile(path.join(repo, ".git", "packed-refs"), `${refs.join("\n")}\n`);

    await expect(
      service.listRepositoryBranches(repo, { includeRepositoryStatus: true }),
    ).resolves.toEqual({
      repositoryStatus: "git",
      branchesUnavailable: true,
      branches: [{ name: "main", kind: "local" }],
      headBranch: "main",
    });
  });

  it.each(["local", "current", "default", "remote"] as const)(
    "keeps ambiguous %s branch suggestions usable even when Git warnings are disabled",
    async (selection) => {
      const initial = await execFileAsync("git", ["-C", repo, "rev-parse", "HEAD"]);
      const branchCommit = await execFileAsync("git", [
        "-C",
        repo,
        "commit-tree",
        "HEAD^{tree}",
        "-p",
        initial.stdout.trim(),
        "-m",
        "branch target",
      ]);
      const commit = branchCommit.stdout.trim();
      const remote = selection === "remote";
      const ref = remote ? "refs/remotes/origin/z-selected" : "refs/heads/z-selected";
      await git(repo, "config", "core.warnAmbiguousRefs", "false");
      await git(repo, "tag", remote ? "origin/z-selected" : "z-selected");
      await git(repo, "update-ref", ref, commit);
      if (selection !== "local") {
        const fillers = ["refs/heads", "refs/remotes/origin"].flatMap((prefix) =>
          Array.from(
            { length: 150 },
            (_, index) =>
              `${initial.stdout.trim()} ${prefix}/filler-${String(index).padStart(3, "0")}`,
          ),
        );
        await fs.writeFile(path.join(repo, ".git", "packed-refs"), `${fillers.join("\n")}\n`);
      }
      if (selection === "current") {
        await git(repo, "symbolic-ref", "HEAD", ref);
      }
      if (selection === "default" || remote) {
        await git(repo, "update-ref", "refs/remotes/origin/z-selected", commit);
        await git(
          repo,
          "symbolic-ref",
          "refs/remotes/origin/HEAD",
          "refs/remotes/origin/z-selected",
        );
      }

      const result = await service.listRepositoryBranches(repo, { includeRepositoryStatus: true });
      const expected = remote ? "remotes/origin/z-selected" : "heads/z-selected";
      expect(result.branches).toContainEqual({ name: expected, kind: remote ? "remote" : "local" });
      expect(result.branches.length).toBeLessThanOrEqual(202);
      if (selection === "current") {
        expect(result.headBranch).toBe(expected);
      }
      if (selection === "default" || remote) {
        expect(result.defaultBranch).toBe(expected);
      }
      const created = await service.create({
        repoRoot: repo,
        name: "disambiguated",
        baseRef: expected,
      });
      const head = await execFileAsync("git", ["-C", created.path, "rev-parse", "HEAD"]);
      expect(head.stdout.trim()).toBe(commit);
    },
  );
});
