import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readConfigFileSnapshot } from "../config/config.js";
import type { RuntimeEnv } from "../runtime.js";
import { createTempHomeEnv, type TempHomeEnv } from "../test-utils/temp-home.js";
import { encodeAbsolutePathForBackupArchive } from "./backup-shared.js";
import {
  getWorkspaceBackupStatus,
  workspaceBackupInitCommand,
  workspaceBackupRunCommand,
} from "./workspace-backup.js";

describe("workspace backup commands", () => {
  let tempHome: TempHomeEnv;
  let runtime: RuntimeEnv;
  let previousCwd: string;
  let targetDir: string | undefined;

  beforeEach(async () => {
    tempHome = await createTempHomeEnv("openclaw-workspace-backup-test-");
    previousCwd = process.cwd();
    runtime = {
      log: vi.fn() as RuntimeEnv["log"],
      error: vi.fn() as RuntimeEnv["error"],
      exit: vi.fn() as RuntimeEnv["exit"],
    };
  });

  afterEach(async () => {
    process.chdir(previousCwd);
    if (targetDir) {
      await fs.rm(targetDir, { recursive: true, force: true }).catch(() => undefined);
      targetDir = undefined;
    }
    await tempHome.restore();
  });

  it("initializes a target, mirrors the workspace, and reports status", async () => {
    const stateDir = path.join(tempHome.home, ".openclaw");
    const workspaceDir = path.join(stateDir, "workspace");
    targetDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-workspace-target-"));
    await fs.mkdir(workspaceDir, { recursive: true });
    await fs.writeFile(path.join(workspaceDir, "SOUL.md"), "# soul\n", "utf8");
    await fs.writeFile(
      path.join(stateDir, "openclaw.json"),
      JSON.stringify({
        agents: {
          defaults: {
            workspace: workspaceDir,
          },
        },
      }),
      "utf8",
    );

    const initResult = await workspaceBackupInitCommand(runtime, {
      target: targetDir,
    });
    expect(initResult.target).toBe(targetDir);

    const configSnapshot = await readConfigFileSnapshot();
    expect(configSnapshot.config.backup?.target).toBe(targetDir);

    const runResult = await workspaceBackupRunCommand(runtime, {});
    expect(runResult.workspaceCount).toBe(1);

    const mirroredDir = path.join(
      targetDir,
      "workspace",
      "mirrors",
      encodeAbsolutePathForBackupArchive(workspaceDir),
    );
    expect(await fs.readFile(path.join(mirroredDir, "SOUL.md"), "utf8")).toBe("# soul\n");

    const status = await getWorkspaceBackupStatus();
    expect(status.configured).toBe(true);
    expect(status.target).toBe(targetDir);
    expect(status.workspaceCount).toBe(1);
    expect(status.lastUpdatedAt).toBeTruthy();

    const statusFile = JSON.parse(
      await fs.readFile(path.join(targetDir, "workspace", "status.json"), "utf8"),
    ) as { schemaVersion: number; workspaces: Array<{ sourcePath: string; backupPath?: string }> };
    expect(statusFile.schemaVersion).toBe(2);
    expect(statusFile.workspaces).toEqual([{ sourcePath: workspaceDir }]);
    expect(statusFile.workspaces[0]?.backupPath).toBeUndefined();
  });

  it("recomputes stale mirror paths instead of trusting status.json backupPath values", async () => {
    const stateDir = path.join(tempHome.home, ".openclaw");
    const workspaceDir = path.join(stateDir, "workspace");
    const protectedDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-workspace-protected-"));
    targetDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-workspace-target-"));
    try {
      await fs.mkdir(workspaceDir, { recursive: true });
      await fs.writeFile(path.join(workspaceDir, "SOUL.md"), "# soul\n", "utf8");
      await fs.writeFile(path.join(protectedDir, "keep.txt"), "keep\n", "utf8");
      await fs.writeFile(
        path.join(stateDir, "openclaw.json"),
        JSON.stringify({
          agents: {
            defaults: {
              workspace: workspaceDir,
            },
          },
        }),
        "utf8",
      );

      await workspaceBackupInitCommand(runtime, { target: targetDir });
      await workspaceBackupRunCommand(runtime, {});

      await fs.writeFile(
        path.join(targetDir, "workspace", "status.json"),
        JSON.stringify({
          schemaVersion: 1,
          updatedAt: "2026-03-10T00:00:00.000Z",
          workspaces: [
            {
              sourcePath: path.join(stateDir, "removed-workspace"),
              backupPath: protectedDir,
            },
          ],
        }),
        "utf8",
      );

      await workspaceBackupRunCommand(runtime, {});

      expect(await fs.readFile(path.join(protectedDir, "keep.txt"), "utf8")).toBe("keep\n");
    } finally {
      await fs.rm(protectedDir, { recursive: true, force: true });
    }
  });

  it("rejects backup targets that resolve into the live state directory via symlink", async () => {
    const stateDir = path.join(tempHome.home, ".openclaw");
    const workspaceDir = path.join(tempHome.home, "workspace");
    const linkedTarget = path.join(tempHome.home, "BackupsLink");
    await fs.mkdir(workspaceDir, { recursive: true });
    await fs.mkdir(stateDir, { recursive: true });
    await fs.symlink(stateDir, linkedTarget);
    await fs.writeFile(
      path.join(stateDir, "openclaw.json"),
      JSON.stringify({
        agents: {
          defaults: {
            workspace: workspaceDir,
          },
        },
      }),
      "utf8",
    );

    await expect(
      workspaceBackupInitCommand(runtime, {
        target: linkedTarget,
      }),
    ).rejects.toThrow("backup.target must not be inside the live state directory.");
  });

  it("rejects workspace paths nested under backup workspace root", async () => {
    const stateDir = path.join(tempHome.home, ".openclaw");
    targetDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-workspace-target-"));
    const workspaceDir = path.join(targetDir, "workspace");
    await fs.mkdir(workspaceDir, { recursive: true });
    await fs.writeFile(
      path.join(stateDir, "openclaw.json"),
      JSON.stringify({
        agents: {
          defaults: {
            workspace: workspaceDir,
          },
        },
      }),
      "utf8",
    );

    await expect(
      workspaceBackupInitCommand(runtime, {
        target: targetDir,
      }),
    ).rejects.toThrow("workspace path must not be inside backup.target/workspace");
  });

  it("keeps existing mirrors when a configured workspace is temporarily missing", async () => {
    const stateDir = path.join(tempHome.home, ".openclaw");
    const workspaceB = path.join(tempHome.home, "workspace-b");
    targetDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-workspace-target-"));
    await fs.mkdir(workspaceB, { recursive: true });
    await fs.writeFile(path.join(workspaceB, "B.txt"), "b\n", "utf8");
    await fs.writeFile(
      path.join(stateDir, "openclaw.json"),
      JSON.stringify({
        agents: {
          defaults: {
            workspace: workspaceB,
          },
        },
      }),
      "utf8",
    );

    await workspaceBackupInitCommand(runtime, { target: targetDir });
    await workspaceBackupRunCommand(runtime, {});

    const mirrorB = path.join(
      targetDir,
      "workspace",
      "mirrors",
      encodeAbsolutePathForBackupArchive(workspaceB),
    );
    expect(await fs.readFile(path.join(mirrorB, "B.txt"), "utf8")).toBe("b\n");

    await fs.rm(workspaceB, { recursive: true, force: true });
    const rerun = await workspaceBackupRunCommand(runtime, {});

    expect(rerun.workspaceCount).toBe(0);
    expect(await fs.readFile(path.join(mirrorB, "B.txt"), "utf8")).toBe("b\n");

    const statusFile = JSON.parse(
      await fs.readFile(path.join(targetDir, "workspace", "status.json"), "utf8"),
    ) as { workspaces: Array<{ sourcePath: string }> };
    expect(statusFile.workspaces).toEqual([{ sourcePath: workspaceB }]);
  });
});
