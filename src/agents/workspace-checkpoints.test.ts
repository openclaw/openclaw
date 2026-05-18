import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.js";
import {
  resolveWorkspaceCheckpointConfig,
  type WorkspaceCheckpoint,
  WorkspaceCheckpointManager,
} from "./workspace-checkpoints.js";

let cleanupDirs: string[] = [];

async function makeHarness() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-checkpoints-"));
  cleanupDirs.push(root);
  const workspaceDir = path.join(root, "workspace");
  const storeRoot = path.join(root, "state", "checkpoints");
  await fs.mkdir(workspaceDir, { recursive: true });
  return {
    workspaceDir,
    manager: new WorkspaceCheckpointManager({
      enabled: true,
      storeRoot,
      maxSnapshots: 10,
      maxFileBytes: 1024 * 1024,
      maxFiles: 1000,
    }),
  };
}

afterEach(async () => {
  const dirs = cleanupDirs;
  cleanupDirs = [];
  await Promise.all(dirs.map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("WorkspaceCheckpointManager", () => {
  it("merges per-agent overrides over global checkpoint config", () => {
    const config = {
      tools: {
        checkpoints: {
          enabled: false,
          maxSnapshots: 4,
          maxFileBytes: 5000,
          exclude: ["global/**"],
        },
      },
    } as OpenClawConfig;

    const merged = resolveWorkspaceCheckpointConfig(config, {
      enabled: true,
      maxSnapshots: 2,
      exclude: ["agent/**"],
    });

    expect(merged.enabled).toBe(true);
    expect(merged.maxSnapshots).toBe(2);
    expect(merged.maxFileBytes).toBe(5000);
    expect(merged.exclude).toEqual(expect.arrayContaining(["global/**", "agent/**"]));
  });

  it("stores snapshots outside the workspace and restores modified/deleted files", async () => {
    const { workspaceDir, manager } = await makeHarness();
    await fs.writeFile(path.join(workspaceDir, "note.txt"), "seed\n", "utf8");

    const checkpoint = await manager.createCheckpoint(workspaceDir, "seed");
    expect(checkpoint?.reason).toBe("seed");
    expect(await exists(path.join(workspaceDir, ".git"))).toBe(false);

    await fs.writeFile(path.join(workspaceDir, "note.txt"), "changed\n", "utf8");
    await fs.writeFile(path.join(workspaceDir, "new.txt"), "new\n", "utf8");
    const diff = await manager.diff(workspaceDir, "latest");
    expect(diff.diff).toContain("-seed");
    expect(diff.diff).toContain("+changed");
    expect(diff.diff).toContain("new.txt");

    const restored = await manager.restore(workspaceDir, "latest");
    expect(restored.restored).toBe(true);
    expect(restored.preRestoreCheckpoint?.reason).toMatch(/^pre-restore:/);
    await expect(fs.readFile(path.join(workspaceDir, "note.txt"), "utf8")).resolves.toBe("seed\n");
    await expect(fs.access(path.join(workspaceDir, "new.txt"))).rejects.toThrow();
  });

  it("restores a single file and deletes it when absent from the checkpoint", async () => {
    const { workspaceDir, manager } = await makeHarness();
    await fs.writeFile(path.join(workspaceDir, "kept.txt"), "kept\n", "utf8");
    await manager.createCheckpoint(workspaceDir, "before-new-file");

    await fs.writeFile(path.join(workspaceDir, "new.txt"), "new\n", "utf8");
    const restored = await manager.restore(workspaceDir, "latest", "new.txt");
    expect(restored.filePath).toBe("new.txt");
    await expect(fs.access(path.join(workspaceDir, "new.txt"))).rejects.toThrow();
    await expect(fs.readFile(path.join(workspaceDir, "kept.txt"), "utf8")).resolves.toBe("kept\n");
  });

  it("restores a directory and removes files added under it after the checkpoint", async () => {
    const { workspaceDir, manager } = await makeHarness();
    await fs.mkdir(path.join(workspaceDir, "src"), { recursive: true });
    await fs.writeFile(path.join(workspaceDir, "src", "kept.txt"), "seed\n", "utf8");
    await manager.createCheckpoint(workspaceDir, "before-dir-extra");

    await fs.writeFile(path.join(workspaceDir, "src", "kept.txt"), "changed\n", "utf8");
    await fs.writeFile(path.join(workspaceDir, "src", "extra.txt"), "extra\n", "utf8");
    await manager.restore(workspaceDir, "latest", "src");

    await expect(fs.readFile(path.join(workspaceDir, "src", "kept.txt"), "utf8")).resolves.toBe(
      "seed\n",
    );
    await expect(fs.access(path.join(workspaceDir, "src", "extra.txt"))).rejects.toThrow();
  });

  it("restores a checkpointed directory over a current file of the same name", async () => {
    const { workspaceDir, manager } = await makeHarness();
    await fs.mkdir(path.join(workspaceDir, "src"), { recursive: true });
    await fs.writeFile(path.join(workspaceDir, "src", "file.txt"), "seed\n", "utf8");
    await manager.createCheckpoint(workspaceDir, "before-dir-file-conflict");

    await fs.rm(path.join(workspaceDir, "src"), { recursive: true, force: true });
    await fs.writeFile(path.join(workspaceDir, "src"), "plain-file\n", "utf8");
    await manager.restore(workspaceDir, "latest", "src");

    await expect(fs.readFile(path.join(workspaceDir, "src", "file.txt"), "utf8")).resolves.toBe(
      "seed\n",
    );
  });

  it("restores a targeted nested file when a current ancestor is a file", async () => {
    const { workspaceDir, manager } = await makeHarness();
    await fs.mkdir(path.join(workspaceDir, "src"), { recursive: true });
    await fs.writeFile(path.join(workspaceDir, "src", "app.ts"), "seed\n", "utf8");
    await manager.createCheckpoint(workspaceDir, "before-ancestor-conflict");

    await fs.rm(path.join(workspaceDir, "src"), { recursive: true, force: true });
    await fs.writeFile(path.join(workspaceDir, "src"), "plain-file\n", "utf8");
    await manager.restore(workspaceDir, "latest", "src/app.ts");

    await expect(fs.readFile(path.join(workspaceDir, "src", "app.ts"), "utf8")).resolves.toBe(
      "seed\n",
    );
  });

  it("restores a checkpointed file over a current directory of the same name", async () => {
    const { workspaceDir, manager } = await makeHarness();
    await fs.writeFile(path.join(workspaceDir, "target"), "seed\n", "utf8");
    await manager.createCheckpoint(workspaceDir, "before-file-dir-conflict");

    await fs.rm(path.join(workspaceDir, "target"), { force: true });
    await fs.mkdir(path.join(workspaceDir, "target"), { recursive: true });
    await fs.writeFile(path.join(workspaceDir, "target", "nested.txt"), "nested\n", "utf8");
    await manager.restore(workspaceDir, "latest");

    await expect(fs.readFile(path.join(workspaceDir, "target"), "utf8")).resolves.toBe("seed\n");
  });

  it("leaves default-excluded files untouched during restore", async () => {
    const { workspaceDir, manager } = await makeHarness();
    await fs.writeFile(path.join(workspaceDir, "note.txt"), "seed\n", "utf8");
    await fs.writeFile(path.join(workspaceDir, ".env"), "SECRET=one\n", "utf8");
    await manager.createCheckpoint(workspaceDir, "exclude-secret");

    await fs.writeFile(path.join(workspaceDir, "note.txt"), "changed\n", "utf8");
    await fs.writeFile(path.join(workspaceDir, ".env"), "SECRET=two\n", "utf8");
    await manager.restore(workspaceDir, "latest");

    await expect(fs.readFile(path.join(workspaceDir, "note.txt"), "utf8")).resolves.toBe("seed\n");
    await expect(fs.readFile(path.join(workspaceDir, ".env"), "utf8")).resolves.toBe(
      "SECRET=two\n",
    );
  });

  it("rejects targeted restores for excluded files", async () => {
    const { workspaceDir, manager } = await makeHarness();
    await fs.writeFile(path.join(workspaceDir, "note.txt"), "seed\n", "utf8");
    await fs.writeFile(path.join(workspaceDir, ".env"), "SECRET=one\n", "utf8");
    await manager.createCheckpoint(workspaceDir, "exclude-secret");

    await fs.writeFile(path.join(workspaceDir, ".env"), "SECRET=two\n", "utf8");
    await expect(manager.restore(workspaceDir, "latest", ".env")).rejects.toThrow(
      /excluded from checkpoints/,
    );
    await expect(fs.readFile(path.join(workspaceDir, ".env"), "utf8")).resolves.toBe(
      "SECRET=two\n",
    );
  });

  it.each(["auth-profiles.json", "id.key", "credentials/token.json"])(
    "rejects targeted restores for root-level secret-like path %s",
    async (relativePath) => {
      const { workspaceDir, manager } = await makeHarness();
      const fullPath = path.join(workspaceDir, relativePath);
      await fs.mkdir(path.dirname(fullPath), { recursive: true });
      await fs.writeFile(path.join(workspaceDir, "note.txt"), "seed\n", "utf8");
      await fs.writeFile(fullPath, "secret-one\n", "utf8");
      await manager.createCheckpoint(workspaceDir, "exclude-secret-path");

      await fs.writeFile(fullPath, "secret-two\n", "utf8");
      await expect(manager.restore(workspaceDir, "latest", relativePath)).rejects.toThrow(
        /excluded from checkpoints/,
      );
      await expect(fs.readFile(fullPath, "utf8")).resolves.toBe("secret-two\n");
    },
  );

  it("skips oversized files before git hashes them into the checkpoint store", async () => {
    const { workspaceDir, manager } = await makeHarness();
    const oversized = crypto.randomBytes(2 * 1024 * 1024);
    await fs.writeFile(path.join(workspaceDir, "note.txt"), "seed\n", "utf8");
    await fs.writeFile(path.join(workspaceDir, "large.bin"), oversized);

    await expect(manager.createCheckpoint(workspaceDir, "large-file")).resolves.toBeDefined();
    expect(await directorySize(manager.rootDir)).toBeLessThan(512 * 1024);

    await fs.writeFile(path.join(workspaceDir, "note.txt"), "changed\n", "utf8");
    await manager.restore(workspaceDir, "latest");
    await expect(fs.readFile(path.join(workspaceDir, "large.bin"))).resolves.toEqual(oversized);
  });

  it("includes non-excluded gitignored files in checkpoints", async () => {
    const { workspaceDir, manager } = await makeHarness();
    await fs.writeFile(path.join(workspaceDir, ".gitignore"), "ignored.txt\n.env\n", "utf8");
    await fs.writeFile(path.join(workspaceDir, "ignored.txt"), "seed\n", "utf8");
    await fs.writeFile(path.join(workspaceDir, ".env"), "SECRET=one\n", "utf8");
    await manager.createCheckpoint(workspaceDir, "ignored-file");

    await fs.writeFile(path.join(workspaceDir, "ignored.txt"), "changed\n", "utf8");
    await fs.writeFile(path.join(workspaceDir, ".env"), "SECRET=two\n", "utf8");
    await manager.restore(workspaceDir, "latest");

    await expect(fs.readFile(path.join(workspaceDir, "ignored.txt"), "utf8")).resolves.toBe(
      "seed\n",
    );
    await expect(fs.readFile(path.join(workspaceDir, ".env"), "utf8")).resolves.toBe(
      "SECRET=two\n",
    );
  });

  it("does not count excluded trees against the checkpoint file limit", async () => {
    const { workspaceDir, manager } = await makeHarness();
    const limited = new WorkspaceCheckpointManager({
      enabled: true,
      storeRoot: manager.rootDir,
      maxFiles: 1,
      exclude: ["scratch/**"],
    });
    await fs.mkdir(path.join(workspaceDir, "scratch"), { recursive: true });
    await fs.writeFile(path.join(workspaceDir, "note.txt"), "seed\n", "utf8");
    await fs.writeFile(path.join(workspaceDir, "scratch", "one.txt"), "one\n", "utf8");
    await fs.writeFile(path.join(workspaceDir, "scratch", "two.txt"), "two\n", "utf8");

    await expect(limited.createCheckpoint(workspaceDir, "limited")).resolves.toBeDefined();
  });

  it("creates at most one automatic checkpoint per turn", async () => {
    const { workspaceDir, manager } = await makeHarness();
    await fs.writeFile(path.join(workspaceDir, "note.txt"), "one\n", "utf8");
    await expect(manager.ensureCheckpoint(workspaceDir, "tool:write")).resolves.toBeDefined();

    await fs.writeFile(path.join(workspaceDir, "note.txt"), "two\n", "utf8");
    await expect(manager.ensureCheckpoint(workspaceDir, "tool:edit")).resolves.toBeUndefined();
    expect(await manager.listCheckpoints(workspaceDir)).toHaveLength(1);

    manager.newTurn();
    await expect(manager.ensureCheckpoint(workspaceDir, "tool:edit")).resolves.toBeDefined();
    expect(await manager.listCheckpoints(workspaceDir)).toHaveLength(2);
  });

  it("awaits an in-flight automatic checkpoint before concurrent calls proceed", async () => {
    const { workspaceDir, manager } = await makeHarness();
    let calls = 0;
    let releaseCheckpoint: (() => void) | undefined;
    const checkpointStarted = new Promise<void>((resolve) => {
      const originalCreateCheckpoint = manager.createCheckpoint.bind(manager);
      manager.createCheckpoint = async (dir, reason): Promise<WorkspaceCheckpoint | undefined> => {
        calls += 1;
        resolve();
        await new Promise<void>((release) => {
          releaseCheckpoint = release;
        });
        return await originalCreateCheckpoint(dir, reason);
      };
    });
    await fs.writeFile(path.join(workspaceDir, "note.txt"), "one\n", "utf8");

    const first = manager.ensureCheckpoint(workspaceDir, "tool:write");
    await checkpointStarted;
    let secondSettled = false;
    const second = manager.ensureCheckpoint(workspaceDir, "tool:edit").finally(() => {
      secondSettled = true;
    });
    await Promise.resolve();
    expect(secondSettled).toBe(false);
    expect(calls).toBe(1);

    releaseCheckpoint?.();
    await Promise.all([first, second]);
    expect(secondSettled).toBe(true);
    expect(await manager.listCheckpoints(workspaceDir)).toHaveLength(1);
  });

  it("rejects single-file restore paths outside the workspace", async () => {
    const { workspaceDir, manager } = await makeHarness();
    await fs.writeFile(path.join(workspaceDir, "note.txt"), "seed\n", "utf8");
    await manager.createCheckpoint(workspaceDir, "seed");

    await expect(manager.restore(workspaceDir, "latest", "../outside.txt")).rejects.toThrow(
      /inside the checkpoint workspace/,
    );
  });
});

async function exists(candidate: string): Promise<boolean> {
  try {
    await fs.access(candidate);
    return true;
  } catch {
    return false;
  }
}

async function directorySize(root: string): Promise<number> {
  let total = 0;
  async function walk(dir: string): Promise<void> {
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
        continue;
      }
      total += (await fs.lstat(full)).size;
    }
  }
  await walk(root);
  return total;
}
