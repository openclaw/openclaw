import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { requireGit, runGit } from "../../agents/worktrees/git.js";
import {
  prepareWorkerProjectSnapshot,
  prepareWorkerWorkspaceGitPack,
} from "./workspace-git-base.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const prepare = (localPath: string, namespace = "gateway", baseCommit?: string) =>
  prepareWorkerProjectSnapshot({ localPath, namespace, baseCommit });
const write = (root: string, content: string, file = "input.txt") =>
  fs.writeFile(path.join(root, file), content);
const setOrigin = (root: string, url: string, action = "add") =>
  requireGit(root, ["remote", action, "origin", url]);
const readCommittedInput = (root: string, commit: string) =>
  requireGit(root, ["show", `${commit}:input.txt`]);

async function createRepository(root: string) {
  await fs.mkdir(root);
  await requireGit(root, ["init", "--quiet"]);
  await requireGit(root, ["config", "user.name", "Project Test"]);
  await requireGit(root, ["config", "user.email", "project@example.invalid"]);
  await write(root, "committed input\n");
  await requireGit(root, ["add", "."]);
  await requireGit(root, ["commit", "--quiet", "-m", "base"]);
}

async function fixture() {
  const root = await fs.realpath(tempDirs.make("worker-project-"));
  const repository = path.join(root, "repository");
  await createRepository(repository);
  return { root, repository, worktree: path.join(root, "linked") };
}

it("shares a project across linked worktrees and commits while isolating repositories and gateways", async () => {
  const { root, repository, worktree } = await fixture();
  await requireGit(repository, ["worktree", "add", "--detach", worktree, "HEAD"]);
  const original = await prepare(repository, "gateway-one");
  expect(original).toMatchObject({ label: "repository" });
  expect(await prepare(worktree, "gateway-one")).toEqual(original);

  await write(worktree, "next commit\n");
  await requireGit(worktree, ["commit", "--quiet", "-am", "next"]);
  const updated = await prepare(worktree, "gateway-one");
  expect(updated?.key).toBe(original?.key);
  expect(updated?.baseCommit).not.toBe(original?.baseCommit);
  expect(updated?.baseCommit).toBe(await requireGit(worktree, ["rev-parse", "HEAD"]));
  expect((await prepare(worktree, "gateway-two"))?.key).not.toBe(original?.key);
  expect(await prepare(worktree, "gateway-one", original!.baseCommit)).toEqual(original);
  await expect(prepare(worktree, "gateway-one", "HEAD")).rejects.toThrow("not a commit id");

  const unrelated = path.join(root, "unrelated");
  await createRepository(unrelated);
  expect((await prepare(unrelated, "gateway-one"))?.key).not.toBe(original?.key);
});

it.each(["checkout", "unborn", "bare"] as const)(
  "reopens the admitted linked commit from its %s donor after removing the seed checkout",
  async (shape) => {
    const { root, repository } = await fixture();
    const donor = shape === "bare" ? path.join(root, "bare.git") : repository;
    if (shape === "bare") {
      await requireGit(root, ["clone", "--bare", repository, donor]);
      await requireGit(donor, ["config", "user.name", "Project Test"]);
      await requireGit(donor, ["config", "user.email", "project@example.invalid"]);
      expect(await prepare(donor)).toMatchObject({
        root: donor,
        baseCommit: await requireGit(donor, ["rev-parse", "HEAD"]),
      });
    }
    await requireGit(donor, ["config", "commit.gpgsign", "false"]);
    const worktree = path.join(root, "seed");
    await requireGit(donor, ["worktree", "add", "--detach", worktree, "HEAD"]);
    await write(worktree, "linked-only commit\n");
    await requireGit(worktree, ["commit", "--quiet", "-am", "session commit"]);
    const project = await prepare(worktree);
    expect(project).toBeDefined();
    expect(project?.baseCommit).not.toBe(await requireGit(donor, ["rev-parse", "HEAD"]));
    await requireGit(donor, ["worktree", "remove", worktree]);
    if (shape === "unborn") {
      await requireGit(donor, ["symbolic-ref", "HEAD", "refs/heads/unborn"]);
    }
    const reopened = await prepare(project!.root, "gateway", project!.baseCommit);
    expect(reopened).toEqual({ ...project, root: donor });
    expect(await readCommittedInput(reopened!.root, reopened!.baseCommit)).toBe(
      "linked-only commit",
    );
  },
);

it("labels snapshots from the normalized origin, falling back to the project directory", async () => {
  const { repository, worktree } = await fixture();
  await requireGit(repository, ["worktree", "add", "--detach", worktree, "HEAD"]);
  const original = await prepare(repository);
  expect(original?.label).toBe("repository");

  await setOrigin(repository, "git@example.invalid:Team/Repo.git");
  await requireGit(repository, ["config", "extensions.worktreeConfig", "true"]);
  await requireGit(worktree, ["config", "--worktree", "remote.origin.url", "git@other:repo"]);
  expect(await prepare(repository)).toEqual({ ...original, label: "example.invalid/team/repo" });
  expect(await prepare(worktree)).toEqual({ ...original, label: "example.invalid/team/repo" });

  await setOrigin(repository, "/local/repository.git", "set-url");
  expect(await prepare(repository)).toEqual(original);
  expect(await prepare(worktree)).toEqual(original);
});

it("does not invent a project snapshot for a plain or unborn workspace", async () => {
  const root = await fs.realpath(tempDirs.make("worker-project-unborn-"));
  expect(await prepare(root)).toBeUndefined();
  await expect(prepare(root, "gateway", "a".repeat(40))).rejects.toThrow("no longer available");
  await requireGit(root, ["init", "--quiet"]);
  await write(root, "uncommitted\n");
  await requireGit(root, ["add", "."]);
  expect(await prepare(root)).toBeUndefined();
});

it("packs only the pinned commit and tree without local credentials, overlays, or history", async () => {
  const { root, repository } = await fixture();
  const ancestor = await requireGit(repository, ["rev-parse", "HEAD"]);
  const oldBlob = await requireGit(repository, ["rev-parse", "HEAD:input.txt"]);
  await write(repository, "prepared project\n");
  await requireGit(repository, ["commit", "--quiet", "-am", "prepared"]);
  await setOrigin(repository, "https://example.invalid/private/repository.git");
  const project = await prepare(repository);
  expect(project).toBeDefined();
  await write(repository, "later commit\n");
  await requireGit(repository, ["commit", "--quiet", "-am", "later"]);
  const later = await requireGit(repository, ["rev-parse", "HEAD"]);
  await write(repository, "dirty session input\n");
  await write(repository, "untracked session file\n", "private.txt");
  const pack = await prepareWorkerWorkspaceGitPack({
    root: project!.root,
    baseCommit: project!.baseCommit,
    temporaryRoot: root,
    signal: new AbortController().signal,
  });
  const unpacked = path.join(root, "unpacked");
  await fs.mkdir(unpacked);
  await requireGit(unpacked, ["init", "--quiet"]);
  await requireGit(unpacked, ["index-pack", "--stdin"], { input: await fs.readFile(pack) });
  expect(await readCommittedInput(unpacked, project!.baseCommit)).toBe("prepared project");
  expect(await requireGit(unpacked, ["ls-tree", "--name-only", project!.baseCommit])).toBe(
    "input.txt",
  );
  for (const absent of [ancestor, oldBlob, later]) {
    expect((await runGit(unpacked, ["cat-file", "-e", absent])).code).not.toBe(0);
  }
  expect((await runGit(unpacked, ["remote", "get-url", "origin"])).code).not.toBe(0);
  expect(await fs.readFile(path.join(repository, "input.txt"), "utf8")).toBe(
    "dirty session input\n",
  );
});
