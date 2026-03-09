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
  });
});
