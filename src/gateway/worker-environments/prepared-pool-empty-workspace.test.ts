import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { requireGit } from "../../agents/worktrees/git.js";
import { usePreparedPoolFixture } from "./prepared-pool.test-support.js";
import { createWorkerProviderIntent } from "./provider-intent.js";

describe("empty workspace prepared worker reserves", () => {
  const fixture = usePreparedPoolFixture();
  const projectOptions = (projectPath: string) => ({
    projectPath,
    executionMode: "worker-turn" as const,
  });
  const available = () =>
    fixture
      .reserves()
      .filter((record) => record.state === "ready" && record.preparation?.consumedAtMs === null);

  async function repository(name: string, contents?: string) {
    const root = path.join(fixture.root, name);
    await fs.mkdir(root);
    await requireGit(root, ["init", "--quiet", "-b", "main"]);
    if (contents !== undefined) {
      await fs.writeFile(path.join(root, "input.txt"), contents);
      await requireGit(root, ["add", "."]);
    }
    await requireGit(root, [
      "-c",
      "user.name=Prepared Workspace Test",
      "-c",
      "user.email=prepared@example.invalid",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "--allow-empty",
      "--quiet",
      "-m",
      name,
    ]);
    return root;
  }

  const createIntentOwner = () =>
    createWorkerProviderIntent(fixture.intentOwnerOptions("empty-workspace-pool-test"));

  function createPool(owner: ReturnType<typeof createIntentOwner>, warn = vi.fn()) {
    return fixture.pool({
      warn,
      prepareIntent: owner.prepareIntent,
      prepareRetention: owner.prepareRetention,
      assertIntentCurrent: owner.assertPreparedIntentCurrent,
      reconcile: async (record, _signal, beforeReconcile) => {
        beforeReconcile();
        if (record.destroyRequestedAtMs !== null) {
          await fixture.destroy(record);
        } else if (record.state === "requested") {
          await fixture.ready(record);
        }
      },
    });
  }

  it("refills an activated empty reserve across independent repositories and database reopen", async () => {
    const owner = createIntentOwner();
    const pool = createPool(owner);
    const uncommittedRoot = path.join(fixture.root, "uncommitted");
    await fs.mkdir(uncommittedRoot);
    const uncommitted = projectOptions(uncommittedRoot);
    const uncommittedIntent = await owner.prepareIntent("development", uncommitted);
    expect(uncommittedIntent.profileSnapshot.project).toBeUndefined();
    expect(uncommittedIntent.profileSnapshot.runtimePreparation).toBeUndefined();
    await requireGit(uncommittedRoot, ["init", "--quiet", "-b", "main"]);
    const unbornIntent = await owner.prepareIntent("development", uncommitted);
    expect(unbornIntent.profileSnapshot.project).toBeUndefined();
    expect(unbornIntent.profileSnapshot.runtimePreparation).toBeUndefined();

    const firstRoot = await repository("first-empty");
    const source = await owner.createWithProfile(
      "development",
      "first-allocation",
      projectOptions(firstRoot),
    );
    await fixture.schedule(pool);
    expect(fixture.reserves()).toEqual([]);
    const activated = await fixture.attach(source);
    await pool.maintain(activated.environmentId);

    expect(available()).toHaveLength(1);
    const spare = available()[0]!;
    const key = spare.preparation!.key;
    expect(spare.profileSnapshot.project).toBeUndefined();
    expect(spare.profileSnapshot.runtimePreparation).toMatchObject({ source: "empty", key });
    expect(JSON.stringify(spare.profileSnapshot)).not.toContain(fixture.root);
    expect(spare.attachedSessionIds).toEqual([]);
    expect(fixture.provider.notePreparedDemand).toHaveBeenLastCalledWith(
      { leaseId: activated.leaseId, profile: {} },
      { preparationKey: key, demandAtMs: fixture.nowMs },
    );

    const secondRoot = await repository("second-empty");
    const second = await owner.prepareIntent("development", projectOptions(secondRoot));
    expect(second.profileSnapshot.runtimePreparation?.key).toBe(key);
    expect(second.profileSnapshot.project).toBeUndefined();
    expect(pool.candidates(second)).toEqual([spare]);

    const projectRoot = await repository("project", "project content\n");
    const projectIntent = await owner.prepareIntent("development", projectOptions(projectRoot));
    const projectPreparationKey = projectIntent.profileSnapshot.project?.preparation?.key;
    expect(projectPreparationKey).not.toBe(key);
    expect(pool.candidates(projectIntent)).toEqual([]);
    const project = await fixture.attach(
      await owner.createWithProfile(
        "development",
        "project-allocation",
        { executionMode: "worker-turn" },
        projectIntent,
      ),
    );
    await pool.maintain(project.environmentId);
    const projectSpare = available().find(
      (record) => record.preparation?.key === projectPreparationKey,
    );
    expect(projectSpare).toBeDefined();
    expect(pool.candidates(projectIntent)).toEqual([projectSpare]);
    expect(pool.candidates(second)).toEqual([spare]);

    fixture.nowMs += 100;
    const consumed = await fixture.attach(spare);
    expect(consumed.preparation?.consumedAtMs).toBe(fixture.nowMs);
    expect(pool.candidates(second)).toEqual([]);
    await pool.noteDemand(consumed.environmentId);
    await fixture.teardown(activated);
    await Promise.all([firstRoot, secondRoot].map((root) => fs.rm(root, { recursive: true })));
    await fixture.reopenStore();
    await fixture.schedule(createPool(createIntentOwner()));

    const refills = available().filter((record) => record.preparation?.key === key);
    expect(refills).toHaveLength(1);
    expect(refills[0]?.environmentId).not.toBe(spare.environmentId);
    expect(refills[0]?.preparation).toMatchObject({ key, demandAtMs: fixture.nowMs });
    expect(refills[0]?.profileSnapshot.project).toBeUndefined();
    expect(JSON.stringify(refills[0]?.profileSnapshot)).not.toContain(fixture.root);
  });

  it.each(["readyWorkers", "maxTotal"] as const)(
    "drains an empty reserve when %s is disabled",
    async (policy) => {
      const root = await repository("empty");
      const owner = createIntentOwner();
      const source = await fixture.attach(
        await owner.createWithProfile("development", "empty-allocation", projectOptions(root)),
      );
      const warn = vi.fn();
      const pool = createPool(owner, warn);
      await pool.maintain(source.environmentId);
      expect(fixture.reserves()).toHaveLength(1);
      const spare = fixture.reserves()[0]!;
      expect(spare.state).toBe("ready");

      if (policy === "readyWorkers") {
        fixture.developmentProfile.readyWorkers = 0;
      } else {
        fixture.config.cloudWorkers!.preparedPool = { maxTotal: 0 };
      }
      await fixture.schedule(pool);
      await fixture.schedule(pool);

      expect(fixture.store.get(spare.environmentId)?.state).toBe("destroyed");
      expect(fixture.reserves().filter((record) => record.state === "ready")).toEqual([]);
      expect(warn).toHaveBeenCalledExactlyOnceWith(
        expect.stringContaining(
          `: profile removed or capacity disabled (readyWorkers=${policy === "readyWorkers" ? 0 : 1}, maxTotal=${policy === "maxTotal" ? 0 : 4})`,
        ),
      );
    },
  );
});
