import path from "node:path";
import { expect, it, vi } from "vitest";
import * as gitExec from "../../infra/git-exec.js";
import { requireGit } from "./git.js";
import { ManagedWorktreeService } from "./service.js";
import {
  materializeManagedWorktreeFixtures,
  useManagedWorktreeTestRepository,
} from "./service.test-support.js";
import { useWorktreeStateRoots } from "./state-fixture.test-support.js";

const roots = useWorktreeStateRoots();
const initializeRepository = useManagedWorktreeTestRepository();

it("cleans up active owners without ref mutations when there are no packs", async () => {
  const root = roots.make("worktree-gc-empty-packs-");
  const repo = await initializeRepository(root);
  const stateDir = path.join(root, "state");
  const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
  const records = await materializeManagedWorktreeFixtures({
    env,
    stateDir,
    repoRoot: repo,
    names: ["first", "second", "third", "fourth", "fifth"],
    ownerKind: "session",
    ownerId: "active-owner",
    now: 1,
  });
  const refs = await requireGit(repo, ["show-ref"]);
  const mutations = vi.spyOn(gitExec, "enqueueGitRefMutation");

  const result = await new ManagedWorktreeService({ env, getConfig: () => ({}) }).gc({
    readOwnerState: () => "active",
  });

  expect(result).toMatchObject({
    removed: [],
    orphansDeleted: 0,
    orphansRetired: 0,
    snapshotsPruned: 0,
    eligibleCount: 0,
    protectedCount: records.length,
    protectionReasons: { "owner is active": records.length },
    gitMaintenance: { stage: "completed", packsBefore: 0, packsAfter: 0 },
  });
  expect(mutations).not.toHaveBeenCalled();
  expect(await requireGit(repo, ["show-ref"])).toBe(refs);
});
