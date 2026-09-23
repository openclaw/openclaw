import { execFile } from "node:child_process";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { ManagedWorktreeService } from "./service.js";
import { useManagedWorktreeTestRepository } from "./service.test-support.js";

const execFileAsync = promisify(execFile);

async function git(cwd: string, ...args: string[]): Promise<string> {
  return (await execFileAsync("git", ["-C", cwd, ...args])).stdout.trim();
}

describe("ManagedWorktreeService submodule checkout", () => {
  const initializeRepository = useManagedWorktreeTestRepository();
  const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
    afterEach(() => {
      vi.restoreAllMocks();
      closeOpenClawStateDatabaseForTest();
      cleanup();
    }),
  );

  it("keeps active submodules unpopulated when repository recursion is enabled", async () => {
    const root = tempDirs.make("openclaw-worktree-submodules-");
    const repo = await initializeRepository(root);
    const moduleRepo = await initializeRepository(path.join(root, "module-source"));
    const moduleHead = await git(moduleRepo, "rev-parse", "HEAD");
    await git(repo, "-c", "protocol.file.allow=always", "submodule", "add", moduleRepo, "module");
    await git(repo, "commit", "-m", "add active submodule");
    await git(repo, "push", "origin", "main");
    await git(repo, "config", "submodule.recurse", "true");
    expect(await git(repo, "config", "--bool", "submodule.module.active")).toBe("true");
    expect(await git(path.join(repo, "module"), "rev-parse", "HEAD")).toBe(moduleHead);

    const disk = fsSync.statfsSync(root);
    vi.spyOn(fsSync, "statfsSync").mockReturnValue({
      type: disk.type,
      files: disk.files,
      frsize: disk.frsize,
      ffree: disk.ffree,
      bsize: 4096,
      blocks: 1024 ** 4 / 4096,
      bavail: (100 * 1024 ** 3) / 4096,
      bfree: (100 * 1024 ** 3) / 4096,
    });
    const service = new ManagedWorktreeService({
      env: { ...process.env, OPENCLAW_STATE_DIR: path.join(root, "state") },
      getConfig: () => ({ worktreeAcceleration: false }),
    });
    const created = await service.create({
      repoRoot: repo,
      name: "submodules",
      baseRef: "origin/main",
    });

    expect(await git(created.path, "submodule", "status", "--", "module")).toBe(
      `-${moduleHead} module`,
    );
    await expect(fs.access(path.join(created.path, "module", ".git"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(await git(created.path, "status", "--porcelain")).toBe("");
    expect(
      await git(created.path, "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"),
    ).toBe("origin/main");
    expect(await git(path.join(repo, "module"), "rev-parse", "HEAD")).toBe(moduleHead);
    expect(await fs.readFile(path.join(repo, "module", "README.md"), "utf8")).toBe("base\n");

    await fs.writeFile(path.join(created.path, "draft.txt"), "preserve this task\n");
    await expect(service.remove({ id: created.id, reason: "archive" })).rejects.toThrow(
      "nested git repositories cannot be snapshotted losslessly",
    );
    expect(await fs.readFile(path.join(created.path, "draft.txt"), "utf8")).toBe(
      "preserve this task\n",
    );
    expect(service.findLiveById(created.id)?.path).toBe(created.path);
  });
});
