import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as contentBudget from "../../infra/git-content-budget.js";
import { gitNullConfigPath } from "../../infra/git-exec.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { WorktreeGcProgress } from "./gc-progress.js";
import { createWorktreeGitMaintenance } from "./git-maintenance.js";
import { requireGit } from "./git.js";

const inventory = vi.hoisted(() => ({ roots: [] as string[] }));
// mock-isolation: Supply synthetic repository inventory without reading the live registry.
vi.mock("./registry-read.js", () => ({
  readRegistryWorktrees: async () => inventory.roots.map((repoRoot) => ({ repoRoot })),
}));

const roots: string[] = [];
const gitEnv = {
  GIT_NO_LAZY_FETCH: "1",
  GIT_ALLOW_PROTOCOL: "",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: gitNullConfigPath(),
  GIT_AUTHOR_NAME: "Synthetic Test",
  GIT_AUTHOR_EMAIL: "synthetic@example.invalid",
  GIT_COMMITTER_NAME: "Synthetic Test",
  GIT_COMMITTER_EMAIL: "synthetic@example.invalid",
};

async function repository() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "git-maintenance-order-"));
  roots.push(root);
  await requireGit(root, ["init"], { env: gitEnv });
  await requireGit(root, ["config", "gc.auto", "0"], { env: gitEnv });
  await fs.writeFile(path.join(root, "content"), "synthetic committed content\n");
  await requireGit(root, ["add", "content"], { env: gitEnv });
  await requireGit(root, ["commit", "-m", "synthetic base"], { env: gitEnv });
  const head = await requireGit(root, ["rev-parse", "HEAD"], { env: gitEnv });
  const directory = path.join(root, ".git", "objects", "pack");
  for (const input of ["first packed blob\n", "second packed blob\n"]) {
    const oid = await requireGit(root, ["hash-object", "-w", "--stdin"], { env: gitEnv, input });
    await requireGit(root, ["pack-objects", path.join(directory, "pack")], {
      env: gitEnv,
      input: oid + "\n",
    });
  }
  await requireGit(root, ["multi-pack-index", "write"], { env: gitEnv });
  inventory.roots = [root];
  return { root, head, directory };
}

afterEach(async () => {
  vi.restoreAllMocks();
  inventory.roots = [];
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("managed Git maintenance admission", () => {
  it("settles maintenance and content writers publishing refs under saturated content capacity", async () => {
    const { root } = await repository();
    const controller = new AbortController();
    const writersReady = [createDeferredCore(), createDeferredCore()];
    const publish = createDeferredCore();
    const maintenanceWaiting = createDeferredCore();
    const acquire = contentBudget.withContentGitSlot;
    let admissions = 0;
    // Observe real admission without replacing either lock owner or its wait behavior.
    vi.spyOn(contentBudget, "withContentGitSlot").mockImplementation((run, signal) => {
      if (++admissions === 3) {
        maintenanceWaiting.resolve();
      }
      return acquire(run, signal);
    });
    const writers = writersReady.map((ready, index) =>
      contentBudget.withContentGitSlot(async () => {
        const oid = await requireGit(root, ["hash-object", "-w", "--stdin"], {
          env: gitEnv,
          input: "writer content " + index + "\n",
        });
        ready.resolve();
        await publish.promise;
        await requireGit(root, ["update-ref", "refs/openclaw/writer-" + index, oid], {
          env: gitEnv,
          signal: controller.signal,
        });
        return oid;
      }, controller.signal),
    );
    await Promise.all(writersReady.map((ready) => ready.promise));
    const progress = new WorktreeGcProgress();
    const maintenance = createWorktreeGitMaintenance(gitEnv)({
      signal: controller.signal,
      progress,
    });
    const settled = Promise.all([...writers, maintenance]);
    // This deadline detects the actual circular wait; abort then joins every owner.
    const deadline = setTimeout(() => controller.abort(new Error("content/ref deadlock")), 2000);
    try {
      await maintenanceWaiting.promise;
      publish.resolve();
      await settled;
      expect(progress.result.gitMaintenance?.stage).toBe("completed");
      for (let index = 0; index < writers.length; index++) {
        expect(
          await requireGit(root, ["rev-parse", "refs/openclaw/writer-" + index], { env: gitEnv }),
        ).toBe(await writers[index]);
        expect(
          await requireGit(root, ["cat-file", "blob", "refs/openclaw/writer-" + index], {
            env: gitEnv,
          }),
        ).toBe("writer content " + index);
      }
      await requireGit(root, ["multi-pack-index", "verify"], { env: gitEnv });
    } finally {
      clearTimeout(deadline);
      controller.abort();
      publish.resolve();
      await Promise.allSettled([...writers, maintenance]);
    }
  });

  it("retains the old atomic MIDX when replacement cannot acquire its lock", async () => {
    const { root, head, directory } = await repository();
    const index = path.join(directory, "multi-pack-index");
    const before = await fs.readFile(index);
    // A new pack forces Git to publish a replacement instead of reusing its index.
    const extra = await requireGit(root, ["hash-object", "-w", "--stdin"], {
      env: gitEnv,
      input: "new pack outside the old index\n",
    });
    await requireGit(root, ["pack-objects", path.join(directory, "pack")], {
      env: gitEnv,
      input: extra + "\n",
    });
    const lock = index + ".lock";
    await fs.writeFile(lock, "synthetic concurrent index writer\n", { flag: "wx" });
    const progress = new WorktreeGcProgress();
    try {
      await createWorktreeGitMaintenance(gitEnv)({ progress });
      expect(progress.result.gitMaintenance?.stage).toBe("suspended");
      expect(await fs.readFile(index)).toEqual(before);
      expect(await requireGit(root, ["rev-parse", "HEAD"], { env: gitEnv })).toBe(head);
      expect(await requireGit(root, ["show", "HEAD:content"], { env: gitEnv })).toBe(
        "synthetic committed content",
      );
    } finally {
      await fs.unlink(lock);
    }
    await requireGit(root, ["multi-pack-index", "verify"], { env: gitEnv });
  });
});
