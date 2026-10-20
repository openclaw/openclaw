import fs from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { requireGit, runGit } from "../../agents/worktrees/git.js";
import { ManagedWorktreeService } from "../../agents/worktrees/service.js";
import { readWorkerProjectPreparation } from "./preparation-identity.schema.js";
import {
  createPreparationArtifacts,
  PREPARATION_TARGET,
  usePreparedPoolFixture,
} from "./prepared-pool.test-support.js";
import { readWorkerProjectSnapshot } from "./project-preparation.js";
import { createWorkerProviderIntent } from "./provider-intent.js";

const fixture = usePreparedPoolFixture();

it("refills the pinned preparation after its managed seed checkout is removed and the store reopens", async () => {
  const repository = path.join(fixture.root, "project");
  const commit = async (root: string, content: string, message: string) => {
    await fs.writeFile(path.join(root, "input.txt"), content);
    await requireGit(root, ["add", "."]);
    await requireGit(root, ["commit", "--quiet", "-m", message]);
    return requireGit(root, ["rev-parse", "HEAD"]);
  };
  await fs.mkdir(repository);
  await requireGit(repository, ["init", "--quiet", "-b", "main"]);
  await requireGit(repository, ["config", "user.name", "Prepared Project Test"]);
  await requireGit(repository, ["config", "user.email", "prepared@example.invalid"]);
  await requireGit(repository, ["config", "commit.gpgsign", "false"]);
  const commonCommit = await commit(repository, "shared base\n", "shared base");
  const worktrees = new ManagedWorktreeService({
    env: { OPENCLAW_STATE_DIR: fixture.root },
    getConfig: () => ({ worktreeRoot: path.join(fixture.root, "managed-worktrees") }),
  });
  const seed = await worktrees.create({
    repoRoot: repository,
    name: "prepared-seed",
    baseRef: "main",
    checkoutCommit: commonCommit,
    ownerKind: "session",
    ownerId: "prepared-seed-session",
    runSetupScript: false,
  });
  const pinnedCommit = await commit(seed.path, "pinned seed\n", "seed-only commit");
  const primaryCommit = await commit(repository, "new primary HEAD\n", "advance primary");
  expect(primaryCommit).not.toBe(pinnedCommit);
  expect(
    (await runGit(repository, ["merge-base", "--is-ancestor", pinnedCommit, primaryCommit])).code,
  ).toBe(1);
  expect(await requireGit(seed.path, ["rev-parse", "HEAD"])).toBe(pinnedCommit);

  fixture.provider = {
    ...fixture.provider,
    requiresNodeEnrollment: true,
    supportsProjectPreparation: () => true,
    resolvePreparationTarget: () => PREPARATION_TARGET,
  };
  const createIntentOwner = () =>
    createWorkerProviderIntent({
      store: fixture.store,
      getConfig: () => fixture.config,
      projectNamespace: "prepared-pool-test",
      providerFor: () => fixture.provider,
      prepareNodeArtifacts: async () => ({
        artifacts: createPreparationArtifacts(),
        assertCurrent: () => {},
      }),
      resumeProvision: async (record) => await fixture.ready(record),
      isStopping: () => false,
      withLock: async (_environmentId, task) => task(),
    });
  const createPool = (intentOwner: ReturnType<typeof createIntentOwner>) =>
    fixture.pool({
      prepareIntent: intentOwner.prepareIntent,
      prepareRetention: intentOwner.prepareRetention,
      assertIntentCurrent: intentOwner.assertPreparedIntentCurrent,
      reconcile: async (record, _signal, beforeReconcile) => {
        beforeReconcile();
        if (record.state === "requested" && record.destroyRequestedAtMs === null) {
          await fixture.ready(record);
        }
      },
    });
  const intentOwner = createIntentOwner();
  const source = await fixture.attach(
    await intentOwner.createWithProfile("development", "seed-allocation", {
      projectPath: seed.path,
      executionMode: "worker-turn",
    }),
  );
  const admittedProject = readWorkerProjectSnapshot(source.profileSnapshot.project)!;
  const admittedPreparation = readWorkerProjectPreparation(source.profileSnapshot.project)!;
  expect(admittedProject.baseCommit).toBe(pinnedCommit);
  await fixture.schedule(createPool(intentOwner));
  const spare = fixture.reserves().find((record) => record.state === "ready")!;
  expect(spare).toBeDefined();
  expect(readWorkerProjectSnapshot(spare.profileSnapshot.project)?.baseCommit).toBe(pinnedCommit);
  expect(spare.preparation?.key).toBe(admittedPreparation.key);

  fixture.nowMs += 100;
  const consumed = await fixture.attach(spare);
  expect(consumed.preparation?.consumedAtMs).toBe(fixture.nowMs);
  await fixture.teardown(source);
  const archived = await worktrees.remove({ id: seed.id, reason: "session-archive" });
  expect(archived).toMatchObject({ removed: true });
  await expect(fs.access(seed.path)).rejects.toMatchObject({ code: "ENOENT" });
  if (!archived.snapshotRef) {
    throw new Error("Managed archive did not retain its snapshot");
  }
  // The archive snapshot retains the seed commit even under immediate Git pruning.
  await requireGit(repository, ["-c", "gc.autoDetach=false", "gc", "--prune=now"]);
  await requireGit(repository, ["merge-base", "--is-ancestor", pinnedCommit, archived.snapshotRef]);

  await fixture.reopenStore();
  await fixture.schedule(createPool(createIntentOwner()));
  const available = fixture
    .reserves()
    .filter((record) => record.state === "ready" && record.preparation?.consumedAtMs === null);
  expect(available).toHaveLength(1);
  const refill = available[0]!;
  expect(refill.environmentId).not.toBe(spare.environmentId);
  expect(refill.preparation?.key).toBe(admittedPreparation.key);
  const refilledProject = readWorkerProjectSnapshot(refill.profileSnapshot.project)!;
  expect(refilledProject).toMatchObject({ key: admittedProject.key, baseCommit: pinnedCommit });
  expect("root" in refilledProject).toBe(true);
  if (!("root" in refilledProject)) {
    throw new Error("Expected the retained local Git project");
  }
  expect(await requireGit(refilledProject.root, ["show", `${pinnedCommit}:input.txt`])).toBe(
    "pinned seed",
  );
  expect(await requireGit(repository, ["rev-parse", "HEAD"])).toBe(primaryCommit);
});
