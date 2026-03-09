import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearConfigCache, readConfigFileSnapshot } from "../config/config.js";
import { createTempHomeEnv, type TempHomeEnv } from "../test-utils/temp-home.js";
import { backupRestoreCommand } from "./backup-restore.js";
import { backupCreateCommand } from "./backup.js";

describe("backupRestoreCommand", () => {
  let sourceHome: TempHomeEnv;
  const extraHomes: string[] = [];

  async function createExtraHome(prefix: string): Promise<string> {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
    await fs.mkdir(path.join(home, ".openclaw"), { recursive: true });
    extraHomes.push(home);
    return home;
  }

  function setActiveHome(home: string, configPath?: string): void {
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    process.env.OPENCLAW_STATE_DIR = path.join(home, ".openclaw");
    if (configPath) {
      process.env.OPENCLAW_CONFIG_PATH = configPath;
    } else {
      delete process.env.OPENCLAW_CONFIG_PATH;
    }
    clearConfigCache();
  }

  beforeEach(async () => {
    sourceHome = await createTempHomeEnv("openclaw-backup-restore-source-");
    delete process.env.OPENCLAW_CONFIG_PATH;
    clearConfigCache();
  });

  afterEach(async () => {
    delete process.env.OPENCLAW_CONFIG_PATH;
    clearConfigCache();
    await sourceHome.restore();
    while (extraHomes.length > 0) {
      const home = extraHomes.pop();
      if (home) {
        await fs.rm(home, { recursive: true, force: true });
      }
    }
  });

  it("restores a backup into a new home and rewrites workspace config paths", async () => {
    const sourceStateDir = path.join(sourceHome.home, ".openclaw");
    const sourceConfigPath = path.join(sourceHome.home, "custom-config.json");
    const sourceWorkspace = path.join(sourceHome.home, "workspace-external");
    const archiveDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-backup-restore-out-"));

    try {
      setActiveHome(sourceHome.home, sourceConfigPath);
      await fs.mkdir(path.join(sourceStateDir, "credentials"), { recursive: true });
      await fs.mkdir(sourceWorkspace, { recursive: true });
      await fs.writeFile(
        sourceConfigPath,
        JSON.stringify({
          agents: {
            defaults: {
              workspace: sourceWorkspace,
            },
          },
        }),
        "utf8",
      );
      await fs.writeFile(path.join(sourceStateDir, "state.txt"), "state\n", "utf8");
      await fs.writeFile(path.join(sourceStateDir, "credentials", "oauth.json"), "{}", "utf8");
      await fs.writeFile(path.join(sourceWorkspace, "SOUL.md"), "# soul\n", "utf8");

      const runtime = {
        log: vi.fn(),
        error: vi.fn(),
        exit: vi.fn(),
      };
      const created = await backupCreateCommand(runtime, {
        output: archiveDir,
      });

      const targetHome = await createExtraHome("openclaw-backup-restore-target-");
      setActiveHome(targetHome);

      const restored = await backupRestoreCommand(runtime, {
        archive: created.archivePath,
      });

      expect(await fs.readFile(path.join(targetHome, ".openclaw", "state.txt"), "utf8")).toBe(
        "state\n",
      );
      expect(
        await fs.readFile(path.join(targetHome, ".openclaw", "credentials", "oauth.json"), "utf8"),
      ).toBe("{}");
      expect(
        await fs.readFile(path.join(targetHome, "workspace-external", "SOUL.md"), "utf8"),
      ).toBe("# soul\n");

      const restoredSnapshot = await readConfigFileSnapshot();
      expect(restoredSnapshot.valid).toBe(true);
      expect(restoredSnapshot.config?.agents?.defaults?.workspace).toBe(
        path.join(targetHome, "workspace-external"),
      );
      expect(restored.updatedConfigWorkspacePaths).toBe(1);
    } finally {
      await fs.rm(archiveDir, { recursive: true, force: true });
    }
  });

  it("supports dry-run without writing restore targets", async () => {
    const sourceStateDir = path.join(sourceHome.home, ".openclaw");
    const archiveDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-backup-restore-dry-"));

    try {
      await fs.writeFile(path.join(sourceStateDir, "openclaw.json"), JSON.stringify({}), "utf8");
      await fs.writeFile(path.join(sourceStateDir, "state.txt"), "state\n", "utf8");

      const runtime = {
        log: vi.fn(),
        error: vi.fn(),
        exit: vi.fn(),
      };
      const created = await backupCreateCommand(runtime, {
        output: archiveDir,
      });

      const targetHome = await createExtraHome("openclaw-backup-restore-dry-target-");
      setActiveHome(targetHome);

      const result = await backupRestoreCommand(runtime, {
        archive: created.archivePath,
        dryRun: true,
      });

      expect(result.dryRun).toBe(true);
      await expect(fs.access(path.join(targetHome, ".openclaw", "state.txt"))).rejects.toThrow();
    } finally {
      await fs.rm(archiveDir, { recursive: true, force: true });
    }
  });

  it("surfaces restore conflicts during dry-run", async () => {
    const sourceStateDir = path.join(sourceHome.home, ".openclaw");
    const archiveDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "openclaw-backup-restore-dry-conflict-"),
    );

    try {
      await fs.writeFile(path.join(sourceStateDir, "openclaw.json"), JSON.stringify({}), "utf8");
      await fs.writeFile(path.join(sourceStateDir, "state.txt"), "state\n", "utf8");

      const runtime = {
        log: vi.fn(),
        error: vi.fn(),
        exit: vi.fn(),
      };
      const created = await backupCreateCommand(runtime, {
        output: archiveDir,
      });

      const targetHome = await createExtraHome("openclaw-backup-restore-dry-conflict-target-");
      setActiveHome(targetHome);
      await fs.writeFile(path.join(targetHome, ".openclaw", "existing.txt"), "existing\n", "utf8");

      await expect(
        backupRestoreCommand(runtime, {
          archive: created.archivePath,
          dryRun: true,
        }),
      ).rejects.toThrow(/rerun with --force/i);
    } finally {
      await fs.rm(archiveDir, { recursive: true, force: true });
    }
  });

  it("refuses to overwrite existing restore targets without --force", async () => {
    const sourceStateDir = path.join(sourceHome.home, ".openclaw");
    const archiveDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "openclaw-backup-restore-conflict-"),
    );

    try {
      await fs.writeFile(path.join(sourceStateDir, "openclaw.json"), JSON.stringify({}), "utf8");
      await fs.writeFile(path.join(sourceStateDir, "state.txt"), "state\n", "utf8");

      const runtime = {
        log: vi.fn(),
        error: vi.fn(),
        exit: vi.fn(),
      };
      const created = await backupCreateCommand(runtime, {
        output: archiveDir,
      });

      const targetHome = await createExtraHome("openclaw-backup-restore-conflict-target-");
      setActiveHome(targetHome);
      await fs.writeFile(path.join(targetHome, ".openclaw", "existing.txt"), "existing\n", "utf8");

      await expect(
        backupRestoreCommand(runtime, {
          archive: created.archivePath,
        }),
      ).rejects.toThrow(/restore target already exists/i);
    } finally {
      await fs.rm(archiveDir, { recursive: true, force: true });
    }
  });

  it("replaces existing restore targets with --force", async () => {
    const sourceStateDir = path.join(sourceHome.home, ".openclaw");
    const archiveDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-backup-restore-force-"));

    try {
      await fs.writeFile(path.join(sourceStateDir, "openclaw.json"), JSON.stringify({}), "utf8");
      await fs.writeFile(path.join(sourceStateDir, "state.txt"), "state\n", "utf8");

      const runtime = {
        log: vi.fn(),
        error: vi.fn(),
        exit: vi.fn(),
      };
      const created = await backupCreateCommand(runtime, {
        output: archiveDir,
      });

      const targetHome = await createExtraHome("openclaw-backup-restore-force-target-");
      setActiveHome(targetHome);
      await fs.writeFile(path.join(targetHome, ".openclaw", "old.txt"), "old\n", "utf8");

      await backupRestoreCommand(runtime, {
        archive: created.archivePath,
        force: true,
      });

      expect(await fs.readFile(path.join(targetHome, ".openclaw", "state.txt"), "utf8")).toBe(
        "state\n",
      );
      await expect(fs.access(path.join(targetHome, ".openclaw", "old.txt"))).rejects.toThrow();
    } finally {
      await fs.rm(archiveDir, { recursive: true, force: true });
    }
  });

  it("rolls back live targets and preserves the backup archive when restore publication fails", async () => {
    const sourceStateDir = path.join(sourceHome.home, ".openclaw");
    const sourceConfigPath = path.join(sourceHome.home, "backup-config.json");
    const archiveDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "openclaw-backup-restore-rollback-"),
    );
    const realCp = fs.cp.bind(fs);
    const cpSpy = vi.spyOn(fs, "cp");

    try {
      setActiveHome(sourceHome.home, sourceConfigPath);
      await fs.writeFile(
        sourceConfigPath,
        JSON.stringify({ agents: { defaults: { workspace: "workspace" } } }),
        "utf8",
      );
      await fs.writeFile(path.join(sourceStateDir, "state.txt"), "new-state\n", "utf8");

      const runtime = {
        log: vi.fn(),
        error: vi.fn(),
        exit: vi.fn(),
      };
      const created = await backupCreateCommand(runtime, {
        output: archiveDir,
      });

      const targetHome = await createExtraHome("openclaw-backup-restore-rollback-target-");
      const targetConfigPath = path.join(targetHome, "target-config.json");
      setActiveHome(targetHome, targetConfigPath);
      await fs.writeFile(
        targetConfigPath,
        JSON.stringify({ agents: { defaults: { workspace: "old-workspace" } } }),
        "utf8",
      );
      await fs.writeFile(path.join(targetHome, ".openclaw", "state.txt"), "old-state\n", "utf8");

      let publishCopies = 0;
      cpSpy.mockImplementation(async (...args) => {
        publishCopies += 1;
        if (publishCopies === 2) {
          throw new Error("simulated restore copy failure");
        }
        return await realCp(...args);
      });

      await expect(
        backupRestoreCommand(runtime, {
          archive: created.archivePath,
          force: true,
        }),
      ).rejects.toThrow(/simulated restore copy failure/i);

      expect(await fs.readFile(created.archivePath, "utf8")).not.toHaveLength(0);
      expect(await fs.readFile(path.join(targetHome, ".openclaw", "state.txt"), "utf8")).toBe(
        "old-state\n",
      );
      expect(await fs.readFile(targetConfigPath, "utf8")).toContain("old-workspace");
    } finally {
      cpSpy.mockRestore();
      await fs.rm(archiveDir, { recursive: true, force: true });
    }
  });

  it("fails closed when multiple workspace targets are ambiguous", async () => {
    const sourceStateDir = path.join(sourceHome.home, ".openclaw");
    const sourceConfigPath = path.join(sourceHome.home, "custom-config.json");
    const sourceWorkspaceA = await fs.mkdtemp(
      path.join(os.tmpdir(), "openclaw-restore-workspace-a-"),
    );
    const sourceWorkspaceB = await fs.mkdtemp(
      path.join(os.tmpdir(), "openclaw-restore-workspace-b-"),
    );
    const archiveDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "openclaw-backup-restore-ambiguous-"),
    );
    let targetWorkspaceA: string | null = null;
    let targetWorkspaceB: string | null = null;

    try {
      setActiveHome(sourceHome.home, sourceConfigPath);
      await fs.writeFile(
        sourceConfigPath,
        JSON.stringify({
          agents: {
            defaults: {
              workspace: sourceWorkspaceA,
            },
            list: [{ id: "second", workspace: sourceWorkspaceB }],
          },
        }),
        "utf8",
      );
      await fs.writeFile(path.join(sourceStateDir, "state.txt"), "state\n", "utf8");
      await fs.writeFile(path.join(sourceWorkspaceA, "A.txt"), "a\n", "utf8");
      await fs.writeFile(path.join(sourceWorkspaceB, "B.txt"), "b\n", "utf8");

      const runtime = {
        log: vi.fn(),
        error: vi.fn(),
        exit: vi.fn(),
      };
      const created = await backupCreateCommand(runtime, {
        output: archiveDir,
      });

      const targetHome = await createExtraHome("openclaw-backup-restore-ambiguous-target-");
      const targetConfigPath = path.join(targetHome, "target-config.json");
      targetWorkspaceB = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-restore-target-b-"));
      targetWorkspaceA = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-restore-target-a-"));
      setActiveHome(targetHome, targetConfigPath);
      await fs.writeFile(
        targetConfigPath,
        JSON.stringify({
          agents: {
            defaults: {
              workspace: targetWorkspaceB,
            },
            list: [{ id: "second", workspace: targetWorkspaceA }],
          },
        }),
        "utf8",
      );

      await expect(
        backupRestoreCommand(runtime, {
          archive: created.archivePath,
        }),
      ).rejects.toThrow(/cannot determine restore targets/i);
    } finally {
      await fs.rm(sourceWorkspaceA, { recursive: true, force: true });
      await fs.rm(sourceWorkspaceB, { recursive: true, force: true });
      if (targetWorkspaceA) {
        await fs.rm(targetWorkspaceA, { recursive: true, force: true });
      }
      if (targetWorkspaceB) {
        await fs.rm(targetWorkspaceB, { recursive: true, force: true });
      }
      await fs.rm(archiveDir, { recursive: true, force: true });
    }
  });
});
