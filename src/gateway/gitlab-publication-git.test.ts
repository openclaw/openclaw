import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { prepareGitLabPublicationGit } from "./gitlab-publication-git.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

it("creates a GitLab provenance commit from the accepted tree without changing the source checkout", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "gitlab-publication-fixture-"));
  roots.push(root);
  const source = path.join(root, "source");
  await fs.mkdir(source);
  const git = (args: string[], input?: string | Buffer, env?: NodeJS.ProcessEnv) =>
    execFileSync("git", ["-C", source, ...args], {
      encoding: "utf8",
      input,
      env: { ...process.env, GIT_CONFIG_GLOBAL: os.devNull, GIT_CONFIG_SYSTEM: os.devNull, ...env },
    }).trim();
  git(["init", "--quiet", "--initial-branch=master", "--object-format=sha1"]);
  await fs.writeFile(path.join(source, "base.txt"), "base\n");
  git(["add", "base.txt"]);
  git([
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.test",
    "commit",
    "--quiet",
    "-m",
    "base",
  ]);
  const baseCommit = git(["rev-parse", "HEAD"]);
  const baseTree = git(["rev-parse", "HEAD^{tree}"]);
  const content = Buffer.from("accepted change\n");
  const fixtureIndex = path.join(root, "fixture.index");
  const fixtureEnv = { GIT_INDEX_FILE: fixtureIndex };
  git(["read-tree", baseTree], undefined, fixtureEnv);
  const sha = git(["hash-object", "-w", "--stdin"], content, fixtureEnv);
  git(
    ["update-index", "--add", "--cacheinfo", "100644", sha, "accepted.txt"],
    undefined,
    fixtureEnv,
  );
  const workspaceTree = git(["write-tree"], undefined, fixtureEnv);
  const inheritedGitDir = process.env.GIT_DIR;
  const inheritedObjectDirectory = process.env.GIT_OBJECT_DIRECTORY;
  process.env.GIT_DIR = path.join(root, "untrusted-git-dir");
  process.env.GIT_OBJECT_DIRECTORY = path.join(root, "untrusted-objects");
  let prepared: Awaited<ReturnType<typeof prepareGitLabPublicationGit>>;
  try {
    prepared = await prepareGitLabPublicationGit({
      repositoryRoot: source,
      snapshot: {
        baseCommit,
        baseTree,
        workspaceTree,
      },
      parentCommit: baseCommit,
      message: "Publish accepted change\n\nOpenClaw-Publication: request-1\n",
      author: {
        name: "Verified User",
        email: "verified@example.test",
        date: "2026-10-26T12:00:00.000Z",
      },
      target: {
        issuer: "https://gitlab.example.test",
        projectId: 17,
        projectPath: "group/repo",
        gitUrl: "https://gitlab.example.test/group/repo.git",
        webUrl: "https://gitlab.example.test/group/repo",
        baseBranch: "master",
      },
      assertCurrent: () => {},
    });
  } finally {
    if (inheritedGitDir === undefined) {
      delete process.env.GIT_DIR;
    } else {
      process.env.GIT_DIR = inheritedGitDir;
    }
    if (inheritedObjectDirectory === undefined) {
      delete process.env.GIT_OBJECT_DIRECTORY;
    } else {
      process.env.GIT_OBJECT_DIRECTORY = inheritedObjectDirectory;
    }
  }
  try {
    expect(await prepared.run(["rev-parse", `${prepared.headCommit}^{tree}`])).toBe(workspaceTree);
    expect(await prepared.run(["rev-parse", `${prepared.headCommit}^`])).toBe(baseCommit);
    const commit = await prepared.run(["cat-file", "-p", prepared.headCommit]);
    expect(commit).toContain("author Verified User <verified@example.test>");
    expect(commit).toContain("committer Verified User <verified@example.test>");
    expect(commit).toContain("OpenClaw-Publication: request-1");
    expect(git(["rev-parse", "HEAD"])).toBe(baseCommit);
    expect(git(["status", "--porcelain"])).toBe("");
  } finally {
    await prepared.close();
  }
});
