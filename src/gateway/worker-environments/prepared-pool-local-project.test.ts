import fs from "node:fs/promises";
import path from "node:path";
import { assert, expect, it } from "vitest";
import { initializeGitFixture } from "../../agents/worktrees/git-fixture.test-support.js";
import { requireGit, runGit } from "../../agents/worktrees/git.js";
import { ManagedWorktreeService } from "../../agents/worktrees/service.js";
import { readWorkerProjectPreparation } from "./preparation-identity.schema.js";
import { usePreparedPoolFixture } from "./prepared-pool.test-support.js";
import { readWorkerProjectSnapshot } from "./project-preparation.js";
import { createWorkerProviderIntent } from "./provider-intent.js";

const f = usePreparedPoolFixture();

it("refills the pinned preparation after its managed seed checkout is removed and the store reopens", async () => {
  const repo = await initializeGitFixture(f.root, "project", "input.txt", "shared base\n");
  const commit = async (root: string, content: string, message: string) => {
    await fs.writeFile(path.join(root, "input.txt"), content);
    await requireGit(root, ["commit", "--quiet", "-am", message]);
    return requireGit(root, ["rev-parse", "HEAD"]);
  };
  const worktrees = new ManagedWorktreeService({
    env: { OPENCLAW_STATE_DIR: f.root },
    getConfig: () => ({ worktreeRoot: path.join(f.root, "managed-worktrees") }),
  });
  const seed = await worktrees.create({
    repoRoot: repo,
    name: "prepared-seed",
    baseRef: "main",
    ownerKind: "session",
    ownerId: "prepared-seed-session",
    runSetupScript: false,
  });
  const pinned = await commit(seed.path, "pinned seed\n", "seed-only commit");
  const primary = await commit(repo, "new primary HEAD\n", "advance primary");
  expect((await runGit(repo, ["merge-base", "--is-ancestor", pinned, primary])).code).toBe(1);

  f.provider = { ...f.provider };
  const createIntentOwner = () =>
    createWorkerProviderIntent(f.intentOwnerOptions("prepared-pool-test"));
  const createPool = (intentOwner: ReturnType<typeof createIntentOwner>) =>
    f.pool({
      prepareIntent: intentOwner.prepareIntent,
      prepareRetention: intentOwner.prepareRetention,
      assertIntentCurrent: intentOwner.assertPreparedIntentCurrent,
      reconcile: async (record, _signal, beforeReconcile) => {
        beforeReconcile();
        if (record.state === "requested" && record.destroyRequestedAtMs === null) {
          await f.ready(record);
        }
      },
    });
  const intentOwner = createIntentOwner();
  const source = await f.attach(
    await intentOwner.createWithProfile("development", "seed-allocation", {
      projectPath: seed.path,
      executionMode: "worker-turn",
    }),
  );
  const project = readWorkerProjectSnapshot(source.profileSnapshot.project)!;
  const preparation = readWorkerProjectPreparation(source.profileSnapshot.project)!;
  expect(project.baseCommit).toBe(pinned);
  await f.schedule(createPool(intentOwner));
  const spare = f.reserves().find((record) => record.state === "ready")!;
  expect(readWorkerProjectSnapshot(spare.profileSnapshot.project)?.baseCommit).toBe(pinned);
  expect(spare.preparation?.key).toBe(preparation.key);

  f.nowMs += 100;
  const consumed = await f.attach(spare);
  expect(consumed.preparation?.consumedAtMs).toBe(f.nowMs);
  await f.teardown(source);
  const archived = await worktrees.remove({ id: seed.id, reason: "session-archive" });
  expect(archived).toMatchObject({ removed: true });
  await expect(fs.access(seed.path)).rejects.toMatchObject({ code: "ENOENT" });
  assert(archived.snapshotRef, "Managed archive did not retain its snapshot");
  // The archive snapshot retains the seed commit even under immediate Git pruning.
  await requireGit(repo, ["-c", "gc.autoDetach=false", "gc", "--prune=now"]);
  await requireGit(repo, ["merge-base", "--is-ancestor", pinned, archived.snapshotRef]);

  await f.reopenStore();
  await f.schedule(createPool(createIntentOwner()));
  const available = f
    .reserves()
    .filter((record) => record.state === "ready" && record.preparation?.consumedAtMs === null);
  expect(available).toHaveLength(1);
  const refill = available[0]!;
  expect(refill.environmentId).not.toBe(spare.environmentId);
  expect(refill.preparation?.key).toBe(preparation.key);
  const refilledProject = readWorkerProjectSnapshot(refill.profileSnapshot.project)!;
  expect(refilledProject).toMatchObject({ key: project.key, baseCommit: pinned });
  assert("root" in refilledProject, "Expected the retained local Git project");
  expect(await requireGit(refilledProject.root, ["show", `${pinned}:input.txt`])).toBe(
    "pinned seed",
  );
  expect(await requireGit(repo, ["rev-parse", "HEAD"])).toBe(primary);
});
