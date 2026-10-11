import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { closeStateDatabaseForTest } from "../../test-utils/database-cleanup.js";
import { addManagedWorktree } from "./checkout.js";
import { detectWorktreeFilesystemBackend } from "./filesystem-backend.js";
import { createCopyWorktreeBackend } from "./filesystem-backend.test-support.js";
import * as preparationTiming from "./preparation-timing.js";
import { ManagedWorktreeService } from "./service.js";
import { useManagedWorktreeTestRepository } from "./service.test-support.js";

vi.mock("./filesystem-backend.js", () => ({ detectWorktreeFilesystemBackend: vi.fn() }));

const execFileAsync = promisify(execFile);
async function git(cwd: string, ...args: string[]): Promise<string> {
  return (await execFileAsync("git", ["-C", cwd, ...args])).stdout.trim();
}

describe("managed Btrfs checkout selection", () => {
  const initializeRepository = useManagedWorktreeTestRepository();
  const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
    afterEach(async () => {
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
      await closeStateDatabaseForTest();
      cleanup();
    }),
  );
  it("does not charge shared disk admission only to the template sample", async () => {
    vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");
    vi.stubEnv("GIT_ATTR_NOSYSTEM", "1");
    const root = tempDirs.make("openclaw-btrfs-shared-cost-");
    const repo = await initializeRepository(root);
    const worktreeRoot = path.join(root, "worktrees");
    await fs.mkdir(worktreeRoot);
    const backend = createCopyWorktreeBackend();
    vi.mocked(detectWorktreeFilesystemBackend).mockResolvedValue(backend);
    let elapsed = 0;
    vi.spyOn(performance, "now").mockImplementation(() => elapsed);
    for (const name of ["cold", "warm", "still-cloned"]) {
      const destination = path.join(worktreeRoot, name);
      const result = await addManagedWorktree({
        env: { ...process.env, OPENCLAW_STATE_DIR: path.join(root, "state") },
        now: Date.now,
        enabled: true,
        repoRoot: repo,
        commonDir: path.join(repo, ".git"),
        worktreeRoot,
        destination,
        base: "HEAD",
        commitGuard: () => {},
        requireSpace: async () => {
          elapsed += 1_000;
        },
      });
      expect(result.code).toBe(0);
      expect(await fs.readFile(path.join(destination, "README.md"), "utf8")).toBe("base\n");
    }
    expect(backend.cloneTemplate).toHaveBeenCalledTimes(3);
  });

  it("selects Git after a slower warm snapshot and measures a new commit again", async () => {
    vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");
    vi.stubEnv("GIT_ATTR_NOSYSTEM", "1");
    const root = tempDirs.make("openclaw-btrfs-selection-");
    const repo = await initializeRepository(root);
    const env = { ...process.env, OPENCLAW_STATE_DIR: path.join(root, "state") };
    const backend = createCopyWorktreeBackend();
    vi.mocked(detectWorktreeFilesystemBackend).mockResolvedValue(backend);
    const service = new ManagedWorktreeService({ env, getConfig: () => ({}) });
    let elapsed = 0;
    vi.spyOn(performance, "now").mockImplementation(() => elapsed);
    const clone = createCopyWorktreeBackend().cloneTemplate;
    vi.mocked(backend.cloneTemplate).mockImplementation(async (...args) => {
      await clone(...args);
      elapsed += 1_000;
    });
    const diagnostics = vi.spyOn(preparationTiming, "setWorktreePreparationTemplate");
    for (const name of ["cold-sample", "warm-sample", "selected-git"]) {
      const created = await service.create({ repoRoot: repo, name, baseRef: "HEAD" });
      expect(await fs.readFile(path.join(created.path, "README.md"), "utf8")).toBe("base\n");
      expect(await git(created.path, "status", "--porcelain")).toBe("");
    }
    expect(backend.cloneTemplate).toHaveBeenCalledTimes(2);
    expect(diagnostics).toHaveBeenCalledWith("unavailable", { reason: "measured-git-faster" });
    await fs.writeFile(path.join(repo, "README.md"), "new commit\n");
    await git(repo, "commit", "-am", "new source");
    const next = await service.create({ repoRoot: repo, name: "new-generation", baseRef: "HEAD" });
    expect(await fs.readFile(path.join(next.path, "README.md"), "utf8")).toBe("new commit\n");
    expect(backend.cloneTemplate).toHaveBeenCalledTimes(3);
  });
});
