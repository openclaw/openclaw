import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeEnv } from "../runtime.js";
import { createTempHomeEnv, type TempHomeEnv } from "../test-utils/temp-home.js";
import { backupListCommand } from "./backup-list.js";
import { backupPushCommand } from "./backup-push.js";
import { backupRestoreCommand } from "./backup-restore.js";

vi.mock("../daemon/service.js", () => ({
  resolveGatewayService: () => ({
    isLoaded: vi.fn(async () => false),
    stop: vi.fn(async () => undefined),
  }),
}));

describe("folder-backed snapshot backup commands", () => {
  let tempHome: TempHomeEnv;
  let runtime: RuntimeEnv;
  let previousCwd: string;
  let targetDir: string;

  beforeEach(async () => {
    tempHome = await createTempHomeEnv("openclaw-folder-backup-test-");
    previousCwd = process.cwd();
    runtime = {
      log: vi.fn() as RuntimeEnv["log"],
      error: vi.fn() as RuntimeEnv["error"],
      exit: vi.fn() as RuntimeEnv["exit"],
    };

    const stateDir = path.join(tempHome.home, ".openclaw");
    const workspaceDir = path.join(stateDir, "workspace");
    targetDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-backup-target-"));
    await fs.mkdir(workspaceDir, { recursive: true });
    await fs.writeFile(path.join(workspaceDir, "SOUL.md"), "# soul\n", "utf8");
    await fs.writeFile(path.join(stateDir, "state.txt"), "state\n", "utf8");
    await fs.writeFile(
      path.join(stateDir, "openclaw.json"),
      JSON.stringify({
        backup: {
          target: targetDir,
          encryption: {
            key: "test-secret",
          },
        },
      }),
      "utf8",
    );
  });

  afterEach(async () => {
    process.chdir(previousCwd);
    await fs.rm(targetDir, { recursive: true, force: true }).catch(() => undefined);
    await tempHome.restore();
  });

  it("pushes, lists, and restores an encrypted snapshot from the configured backup folder", async () => {
    const stateDir = path.join(tempHome.home, ".openclaw");
    const workspaceDir = path.join(stateDir, "workspace");

    const pushed = await backupPushCommand(runtime, {}, { nowMs: Date.UTC(2026, 2, 10) });
    expect(pushed.snapshotId).toContain("snap_");
    expect(pushed.installationId).toContain("inst_");

    const listed = await backupListCommand(runtime, {});
    expect(listed.installationId).toBe(pushed.installationId);
    expect(listed.snapshots).toHaveLength(1);
    expect(listed.snapshots[0]?.snapshotId).toBe(pushed.snapshotId);

    await fs.rm(stateDir, { recursive: true, force: true });
    await fs.mkdir(stateDir, { recursive: true });
    await fs.writeFile(
      path.join(stateDir, "openclaw.json"),
      JSON.stringify({
        backup: {
          target: targetDir,
          encryption: {
            key: "test-secret",
          },
        },
      }),
      "utf8",
    );

    const restored = await backupRestoreCommand(runtime, {
      snapshotId: pushed.snapshotId,
      installationId: pushed.installationId,
      mode: "full-host",
    });

    expect(restored.mode).toBe("full-host");
    expect(await fs.readFile(path.join(stateDir, "state.txt"), "utf8")).toBe("state\n");
    expect(await fs.readFile(path.join(workspaceDir, "SOUL.md"), "utf8")).toBe("# soul\n");
  });

  it("lists snapshots without encryption key configured", async () => {
    const stateDir = path.join(tempHome.home, ".openclaw");

    // Push a snapshot first (requires key).
    const pushed = await backupPushCommand(runtime, {}, { nowMs: Date.UTC(2026, 2, 10) });
    expect(pushed.snapshotId).toContain("snap_");

    // Remove the encryption key from config, keeping only target.
    await fs.writeFile(
      path.join(stateDir, "openclaw.json"),
      JSON.stringify({ backup: { target: targetDir } }),
      "utf8",
    );

    // Listing should succeed even without encryption key.
    const listed = await backupListCommand(runtime, {});
    expect(listed.installationId).toBe(pushed.installationId);
    expect(listed.snapshots).toHaveLength(1);
    expect(listed.snapshots[0]?.snapshotId).toBe(pushed.snapshotId);
  });

  it("emits a single JSON payload when snapshot push runs with --json", async () => {
    await backupPushCommand(runtime, { json: true }, { nowMs: Date.UTC(2026, 2, 10) });

    expect(runtime.log).toHaveBeenCalledTimes(1);
    const message = vi.mocked(runtime.log).mock.calls[0]?.[0];
    expect(typeof message).toBe("string");
    expect(() => JSON.parse(String(message))).not.toThrow();
  });
});
