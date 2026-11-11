import { createCipheriv } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, afterEach, beforeEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
} from "../../state/openclaw-state-db.js";
import { WorktreeGcProgress } from "./gc-progress.js";
import { createWorktreeGitMaintenance } from "./git-maintenance.js";
import { requireGit, requireGitBuffer } from "./git.js";
import { insertRegistryWorktree } from "./registry.js";
import { makeWorktreeRecord, useManagedWorktreeTestRepository } from "./service.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterAll(async () => {
    await closeOpenClawStateDatabaseAsync();
    closeOpenClawStateDatabaseForTest();
    cleanup();
  }),
);
let env: NodeJS.ProcessEnv;
const initRepo = useManagedWorktreeTestRepository();
const git = (repo: string, ...args: string[]) =>
  requireGit(repo, args, {
    env: { GIT_NO_LAZY_FETCH: "1", GIT_ALLOW_PROTOCOL: "" },
    executionIntent: "agent-tool",
  });
beforeEach(() => {
  env = { ...process.env, OPENCLAW_STATE_DIR: tempDirs.make("worktree-pack-state-") };
  setRuntimeConfigSnapshot({});
});
afterEach(() => clearRuntimeConfigSnapshot());

it.each([false, true])(
  "compresses separately acquired revisions (promisor=%s)",
  async (promisor) => {
    const repo = await initRepo(tempDirs.make("worktree-revision-packs-"));
    await insertRegistryWorktree(env, makeWorktreeRecord(repo, `revisions-${promisor}`));
    const directory = path.join(repo, ".git", "objects", "pack");
    const payload = createCipheriv("aes-256-ctr", Buffer.alloc(32), Buffer.alloc(16)).update(
      Buffer.alloc(256 * 1024),
    );
    const objects = [];
    for (let revision = 0; revision < 8; revision++) {
      const contents = Buffer.from(payload);
      contents.writeUInt32LE(revision);
      const oid = await requireGit(repo, ["hash-object", "-w", "--stdin"], { input: contents });
      const hash = await requireGit(
        repo,
        ["pack-objects", "--window=0", path.join(directory, "pack")],
        {
          input: `${oid}\n`,
        },
      );
      if (promisor) {
        await fs.writeFile(path.join(directory, `pack-${hash}.promisor`), "");
      }
      objects.push({ oid, contents });
    }
    await git(repo, "prune-packed");
    const packedBytes = async () => {
      const names = (await fs.readdir(directory)).filter((name) => name.endsWith(".pack"));
      return (
        await Promise.all(
          names.map(async (name) => (await fs.stat(path.join(directory, name))).size),
        )
      ).reduce((sum, bytes) => sum + bytes, 0);
    };
    const before = await packedBytes();
    const progress = new WorktreeGcProgress();
    await createWorktreeGitMaintenance(env)({ progress });
    expect(progress.result.gitMaintenance?.stage).toBe("completed");
    expect(await packedBytes()).toBeLessThan(before / 3);
    expect((await fs.readdir(directory)).filter((name) => name.endsWith(".promisor"))).toHaveLength(
      promisor ? 1 : 0,
    );
    for (const { oid, contents } of objects) {
      expect(await requireGitBuffer(repo, ["cat-file", "blob", oid])).toEqual(contents);
    }
  },
);

it("compacts committed loose packs while retaining unpublished temporary packs", async () => {
  const repo = await initRepo(tempDirs.make("worktree-loose-packs-"));
  await insertRegistryWorktree(
    env,
    makeWorktreeRecord(repo, "loose-pack-family", {
      repoFingerprint: "loose-pack-family",
      ownerKind: "manual",
    }),
  );
  await git(repo, "repack", "-a", "-d");
  const directory = path.join(repo, ".git", "objects", "pack");
  const canonical = (await fs.readdir(directory)).find((name) => name.endsWith(".pack"));
  expect(canonical).toMatch(/^pack-[a-f0-9]+\.pack$/);
  const hash = canonical!.slice("pack-".length, -".pack".length);
  const loose = "loose-" + hash;
  const temporary = ".tmp-123-pack-" + hash;
  for (const extension of ["pack", "idx"]) {
    const source = path.join(directory, "pack-" + hash + "." + extension);
    await fs.copyFile(source, path.join(directory, loose + "." + extension));
    await fs.copyFile(source, path.join(directory, temporary + "." + extension));
  }
  const progress = new WorktreeGcProgress();
  await createWorktreeGitMaintenance(env)({ progress });
  expect(progress.result.gitMaintenance).toMatchObject({
    packsBefore: 3,
    packsAfter: 2,
    stage: "completed",
  });
  await expect(fs.access(path.join(directory, loose + ".pack"))).rejects.toHaveProperty(
    "code",
    "ENOENT",
  );
  await expect(fs.access(path.join(directory, loose + ".idx"))).rejects.toHaveProperty(
    "code",
    "ENOENT",
  );
  await fs.access(path.join(directory, temporary + ".pack"));
  await fs.access(path.join(directory, temporary + ".idx"));
  await git(repo, "fsck", "--no-reflogs");
});
