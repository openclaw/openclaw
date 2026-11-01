import fs from "node:fs/promises";
import path from "node:path";
import { expect, it, vi } from "vitest";
import {
  forkSessionRepositoryWorkspace,
  readSessionRepositoryArtifacts,
} from "./session-repository-checkpoints.js";
import { placements, SESSION_ID } from "./worker-turn-launcher.test-support.js";
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
