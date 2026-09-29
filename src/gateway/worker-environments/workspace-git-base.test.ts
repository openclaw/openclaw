import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { requireGit, runGit } from "../../agents/worktrees/git.js";
import {
  prepareWorkerProjectSnapshot,
  prepareWorkerWorkspaceGitPack,
} from "./workspace-git-base.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

async function createRepository(root: string) {
  await fs.mkdir(root);
  await requireGit(root, ["init", "--quiet"]);
  await requireGit(root, ["config", "user.name", "Project Test"]);
  await requireGit(root, ["config", "user.email", "project@example.invalid"]);
  await fs.writeFile(path.join(root, "input.txt"), "committed input\n");
  await requireGit(root, ["add", "."]);
  await requireGit(root, ["commit", "--quiet", "-m", "base"]);
}

describe("prepared worker projects", () => {
  it("shares a project across linked worktrees and commits while isolating repositories and gateways", async () => {
    const root = await fs.realpath(tempDirs.make("worker-project-identity-"));
    const repository = path.join(root, "repository");
    const worktree = path.join(root, "linked");
    await createRepository(repository);
    await requireGit(repository, ["worktree", "add", "--detach", worktree, "HEAD"]);
    const prepare = (localPath: string, namespace = "gateway-one") =>
      prepareWorkerProjectSnapshot({ localPath, namespace });
    const original = await prepare(repository);
    expect(original).toBeDefined();
    expect(await prepare(worktree)).toEqual({ ...original, label: "linked" });

    await fs.writeFile(path.join(worktree, "input.txt"), "next commit\n");
    await requireGit(worktree, ["commit", "--quiet", "-am", "next"]);
    const updated = await prepare(worktree);
    expect(updated?.key).toBe(original?.key);
    expect(updated?.baseCommit).not.toBe(original?.baseCommit);
    expect(updated?.baseCommit).toBe(await requireGit(worktree, ["rev-parse", "HEAD"]));
    expect((await prepare(worktree, "gateway-two"))?.key).not.toBe(original?.key);
    expect(
      await prepareWorkerProjectSnapshot({
        localPath: worktree,
        namespace: "gateway-one",
        baseCommit: original!.baseCommit,
      }),
    ).toEqual({ ...original, label: "linked" });
    await expect(
      prepareWorkerProjectSnapshot({
        localPath: worktree,
        namespace: "gateway-one",
        baseCommit: "HEAD",
      }),
    ).rejects.toThrow("not a commit id");

    const unrelated = path.join(root, "unrelated");
    await createRepository(unrelated);
    expect((await prepare(unrelated))?.key).not.toBe(original?.key);
  });

  it.each(["checkout", "unborn", "bare"] as const)(
    "reopens the admitted linked commit from its %s donor after removing the seed checkout",
    async (shape) => {
      const root = await fs.realpath(tempDirs.make("worker-project-donor-"));
      const repository = path.join(root, "repository");
      await createRepository(repository);
      const donor = shape === "bare" ? path.join(root, "bare.git") : repository;
      if (shape === "bare") {
        await requireGit(root, ["clone", "--bare", repository, donor]);
        await requireGit(donor, ["config", "user.name", "Project Test"]);
        await requireGit(donor, ["config", "user.email", "project@example.invalid"]);
        expect(
          await prepareWorkerProjectSnapshot({ localPath: donor, namespace: "gateway" }),
        ).toMatchObject({
          root: donor,
          baseCommit: await requireGit(donor, ["rev-parse", "HEAD"]),
        });
      }
      await requireGit(donor, ["config", "commit.gpgsign", "false"]);
      const worktree = path.join(root, "seed");
      await requireGit(donor, ["worktree", "add", "--detach", worktree, "HEAD"]);
      await fs.writeFile(path.join(worktree, "input.txt"), "linked-only commit\n");
      await requireGit(worktree, ["commit", "--quiet", "-am", "session commit"]);
      const project = await prepareWorkerProjectSnapshot({
        localPath: worktree,
        namespace: "gateway",
      });
      expect(project).toBeDefined();
      expect(project?.baseCommit).not.toBe(await requireGit(donor, ["rev-parse", "HEAD"]));
      await requireGit(donor, ["worktree", "remove", worktree]);
      if (shape === "unborn") {
        await requireGit(donor, ["symbolic-ref", "HEAD", "refs/heads/unborn"]);
      }
      const reopened = await prepareWorkerProjectSnapshot({
        localPath: project!.root,
        baseCommit: project!.baseCommit,
        namespace: "gateway",
      });
      expect(reopened).toMatchObject({
        key: project!.key,
        baseCommit: project!.baseCommit,
        root: donor,
      });
      expect(await requireGit(reopened!.root, ["show", `${reopened!.baseCommit}:input.txt`])).toBe(
        "linked-only commit",
      );
    },
  );

  it("labels snapshots from the normalized origin, falling back to the project directory", async () => {
    const root = await fs.realpath(tempDirs.make("worker-project-label-"));
    const repository = path.join(root, "project");
    await createRepository(repository);
    const prepare = () =>
      prepareWorkerProjectSnapshot({ localPath: repository, namespace: "gateway" });
    const original = await prepare();
    expect(original?.label).toBe("project");

    await requireGit(repository, ["remote", "add", "origin", "git@example.invalid:Team/Repo.git"]);
    expect(await prepare()).toEqual({ ...original, label: "example.invalid/team/repo" });

    await requireGit(repository, ["remote", "set-url", "origin", "/local/repository.git"]);
    expect(await prepare()).toEqual(original);
  });

  it("does not invent a project snapshot for a plain or unborn workspace", async () => {
    const root = await fs.realpath(tempDirs.make("worker-project-unborn-"));
    const prepare = () => prepareWorkerProjectSnapshot({ localPath: root, namespace: "gateway" });
    expect(await prepare()).toBeUndefined();
    await expect(
      prepareWorkerProjectSnapshot({
        localPath: root,
        namespace: "gateway",
        baseCommit: "a".repeat(40),
      }),
    ).rejects.toThrow("no longer available");
    await requireGit(root, ["init", "--quiet"]);
    await fs.writeFile(path.join(root, "input.txt"), "uncommitted\n");
    await requireGit(root, ["add", "."]);
    expect(await prepare()).toBeUndefined();
  });

  it("packs only the pinned commit and tree without local credentials, overlays, or history", async () => {
    const root = await fs.realpath(tempDirs.make("worker-project-pack-"));
    const repository = path.join(root, "repository");
    await createRepository(repository);
    const ancestor = await requireGit(repository, ["rev-parse", "HEAD"]);
    const oldBlob = await requireGit(repository, ["rev-parse", "HEAD:input.txt"]);
    await fs.writeFile(path.join(repository, "input.txt"), "prepared project\n");
    await requireGit(repository, ["commit", "--quiet", "-am", "prepared"]);
    await requireGit(repository, [
      "remote",
      "add",
      "origin",
      "https://example.invalid/private/repository.git",
    ]);
    const project = await prepareWorkerProjectSnapshot({
      localPath: repository,
      namespace: "gateway",
    });
    expect(project).toBeDefined();
    await fs.writeFile(path.join(repository, "input.txt"), "later commit\n");
    await requireGit(repository, ["commit", "--quiet", "-am", "later"]);
    const later = await requireGit(repository, ["rev-parse", "HEAD"]);
    await fs.writeFile(path.join(repository, "input.txt"), "dirty session input\n");
    await fs.writeFile(path.join(repository, "private.txt"), "untracked session file\n");
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
    expect(await requireGit(unpacked, ["show", `${project!.baseCommit}:input.txt`])).toBe(
      "prepared project",
    );
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
});
