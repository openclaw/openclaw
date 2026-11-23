import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { prepareGitHubPublicationTarget } from "./github-publication-target.js";

vi.mock("./github-publication-availability.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./github-publication-availability.js")>()),
  assertExpectedSharedGitHubPublisher() {},
  prepareGitHubPublicationRepositoryIdentity: async () => ({
    originUrl: "https://github.com/test/repository.git",
  }),
}));
vi.mock("./github-publication-git-transport.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./github-publication-git-transport.js")>()),
  requirePublicationCommand: async (argv: string[], options: { cwd?: string }) => {
    if (argv[0] === "gh") {
      return JSON.stringify({ fork: false, default_branch: "main" });
    }
    return execFileSync(argv[0]!, argv.slice(1), { cwd: options.cwd, encoding: "utf8" }).trim();
  },
  runPublicationCommand: async (argv: string[], options: { cwd?: string }) => {
    if (argv[0] === "gh") {
      return { code: 1, stdout: Buffer.alloc(0), stderr: Buffer.from("gh: Not Found (HTTP 404)") };
    }
    const { spawnSync } = await import("node:child_process");
    const result = spawnSync(argv[0]!, argv.slice(1), { cwd: options.cwd });
    return { code: result.status, stdout: result.stdout, stderr: result.stderr };
  },
}));
const directories: string[] = [];
afterEach(() => {
  for (const dir of directories.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
it("targets the default branch through publication preparation for a short commit base", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "publication-base-target-"));
  directories.push(root);
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  git("init", "--quiet", "-b", "feature");
  git(
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "-c",
    "commit.gpgSign=false",
    "commit",
    "--quiet",
    "--allow-empty",
    "-m",
    "fixture",
  );
  const baseRef = git("rev-parse", "HEAD").slice(0, 11);
  const result = await prepareGitHubPublicationTarget({
    worktree: {
      id: "fixture",
      name: "fixture",
      repoFingerprint: "0123456789abcdef",
      repoRoot: root,
      path: root,
      branch: "feature",
      baseRef,
      ownerKind: "manual",
      createdAt: 0,
      lastActiveAt: 0,
    },
    identity: {
      source: "system-detected",
      host: "github.com",
      account: { accountId: 1, login: "fixture", avatarUrl: null },
      env: {},
    },
    assertCurrent() {},
  });
  expect(result.baseBranch).toBe("main");
});
