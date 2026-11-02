import fs from "node:fs/promises";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { getRuntimeConfig } from "../../config/io.js";
import { prepareSessionWorktreeCreation } from "../session-worktree-preparation.js";
import {
  forkSessionRepositoryWorkspace,
  readSessionRepositoryArtifacts,
  withSessionRepositoryCheckpoint,
} from "./session-repository-checkpoints.js";
import { placements, SESSION_ID, sessionTarget } from "./worker-turn-launcher.test-support.js";
import { requireWorkspaceResultGit as git } from "./workspace-result-git.js";
import { useRepositoryWorkspaceResultFixture } from "./workspace-result-repository.test-support.js";

// mock-isolation: Local repository origin; result custody, capture and stores are real.
vi.mock("./repository-github-identity.js", () => ({
  prepareRepositoryGitHubIdentity: async (_agentId: string, assertCurrent: () => void) => ({
    token: undefined,
    assertSelected: assertCurrent,
    start: async (start: () => Promise<unknown>) => await start(),
  }),
}));
const { fixture } = useRepositoryWorkspaceResultFixture();
const refs = (root: string) =>
  git(root, ["for-each-ref", "--format=%(refname) %(objectname)", "refs/openclaw/"]);

it.each(["worker-turn", "remote-exec"] as const)(
  "%s settles its accepted disk turn without capturing a mirror",
  async (mode) => {
    const f = await fixture(mode);
    const mirrored = await f.resolveWorkspace();
    const bound = await f.bindDisk();
    const capture = vi.spyOn(f.tunnel, "reconcileWorkspace");
    const journal = vi.spyOn(placements, "beginWorkspaceReconciliation");
    const closeTools = vi.spyOn(placements, "closeWorkerTurnToolState");
    const owned = await f.beginTurn("disk-turn");
    await f.write("turn.txt", "disk turn bytes\n");
    const publish = vi.fn(async () => {
      expect(await placements.listPendingWorkspaceResultsAsync()).toMatchObject([
        { repositoryDiskAuthority: bound.diskAuthority, workspaceAcceptedAtMs: expect.any(Number) },
      ]);
      expect(placements.get(SESSION_ID)?.turnClaim).not.toBeNull();
    });
    const prepare = vi.fn(async () => {
      expect(placements.preparedWorkspaceResult(owned.turnClaim)?.workspaceAcceptedAtMs).toBeNull();
    });
    await f.finishTurn(owned, publish, {
      // A stale workspace read cannot reinterpret the accepted disk result as mirrored.
      workspace: mirrored,
      prepareAcceptedWorkspacePublication: prepare,
    });
    await f.expectSettled();
    expect(capture).not.toHaveBeenCalled();
    expect(journal).not.toHaveBeenCalled();
    expect(publish).toHaveBeenCalledOnce();
    expect(prepare).toHaveBeenCalledOnce();
    expect(closeTools).toHaveBeenCalledTimes(mode === "worker-turn" ? 1 : 0);
    expect(await f.store.get(bound.workspaceId)).toEqual(bound);
    expect(await fs.readFile(path.join(f.remote, "turn.txt"), "utf8")).toBe("disk turn bytes\n");
  },
);

it("inherits fresh disk history and dirty files without sharing or releasing the active parent's disk", async () => {
  const f = await fixture("worker-turn");
  const repository = await f.bindDisk();
  const originalRefs = await refs(f.store.artifactPath(repository.workspaceId));
  const active = await f.beginTurn("parent-spawning");
  await f.write("private.txt", "committed on disk\n");
  await git(f.remote, ["add", "private.txt"]);
  await git(f.remote, [
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "-m",
    "private history",
  ]);
  const head = await git(f.remote, ["rev-parse", "HEAD"]);
  await f.write("dirty.txt", "staged parent bytes\n");
  await git(f.remote, ["add", "dirty.txt"]);
  await f.write("dirty.txt", "fresh disk bytes\n");
  const target = {
    agentId: sessionTarget.agentId,
    key: "agent:main:dashboard:disk-child",
    storePath: sessionTarget.storePath,
  };
  const prepared = await prepareSessionWorktreeCreation({
    cfg: getRuntimeConfig(),
    target,
    inheritParentKey: sessionTarget.sessionKey,
    repositoryMutations: f.mutations,
    deferWorktree: false,
    titleSource: "disk child",
    label: "disk child",
    useRequestedTitleSelection: false,
    runSetupScript: false,
    commitGuard() {},
    onTitleError() {},
    onTitleStateChanged() {},
  });
  expect(prepared.ok).toBe(true);
  if (!prepared.ok) {
    throw new Error(prepared.error.message);
  }
  const child = (await f.store.get(prepared.value.repositoryWorkspaceId!))!;
  expect(child.workspaceId).not.toBe(repository.workspaceId);
  expect(child.diskAuthority).toBeUndefined();
  expect(child.branch).not.toBe(repository.branch);
  expect(await refs(f.store.artifactPath(repository.workspaceId))).toBe(originalRefs);
  expect(await f.store.get(repository.workspaceId)).toEqual(repository);
  expect(await git(f.remote, ["show", ":dirty.txt"])).toBe("staged parent bytes");
  expect(placements.get(SESSION_ID)?.turnClaim?.claimId).toBe(active.turnClaim.claimId);
  await f.write("dirty.txt", "parent changed later\n");
  await withSessionRepositoryCheckpoint({ workspaceId: child.workspaceId }, async (snapshot) => {
    expect(snapshot.gitHistory?.headCommit).toBe(head);
    expect(await fs.readFile(path.join(snapshot.stagingRoot, "dirty.txt"), "utf8")).toBe(
      "fresh disk bytes\n",
    );
  });
  await f.finishTurn(active);
  await f.expectSettled();
});

it("rolls back an unexposed disk child when resuming its parent fails", async () => {
  const f = await fixture("worker-turn");
  const repository = await f.bindDisk();
  const originalRefs = await refs(f.store.artifactPath(repository.workspaceId));
  await f.write("dirty.txt", "current bytes\n");
  const quiesce = f.tunnel.quiesceWorkspace.bind(f.tunnel);
  vi.spyOn(f.tunnel, "quiesceWorkspace").mockImplementation(async (...args) => {
    const held = await quiesce(...args);
    return {
      ...held,
      resume: async () => {
        await held.resume();
        throw new Error("resume reply lost");
      },
    };
  });
  const target = {
    agentId: sessionTarget.agentId,
    sessionKey: "agent:main:dashboard:failed-disk-child",
  };
  await expect(
    f.mutations.fork({
      ...sessionTarget,
      repository,
      target,
      runSetupScript: false,
      assertCurrent() {},
    }),
  ).rejects.toThrow("resume reply lost");
  expect(await f.store.find(target)).toBeUndefined();
  expect(await refs(f.store.artifactPath(repository.workspaceId))).toBe(originalRefs);
  expect(await f.store.get(repository.workspaceId)).toEqual(repository);
  expect(await fs.readFile(path.join(f.remote, "dirty.txt"), "utf8")).toBe("current bytes\n");
  await f.expectSettled();
});

it("refuses implicit checkpoints and forks after the original disk becomes authoritative", async () => {
  const f = await fixture("worker-turn");
  const repository = await f.bindDisk();
  await f.write("new-on-disk.txt", "not in the old mirror");
  const target = { agentId: repository.agentId, sessionKey: "agent:main:retained-fork" };
  await expect(
    forkSessionRepositoryWorkspace({
      ...target,
      sourceWorkspaceId: repository.workspaceId,
      assertCurrent() {},
    }),
  ).rejects.toThrow("fresh disk export");
  expect(await f.store.find(target)).toBeUndefined();
  await expect(
    readSessionRepositoryArtifacts({ workspaceId: repository.workspaceId, assertCurrent() {} }),
  ).rejects.toThrow("fresh disk export");
  expect(await f.store.get(repository.workspaceId)).toEqual(repository);
});
