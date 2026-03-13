import { beforeEach, describe, expect, it, vi } from "vitest";
import { backupRunCommand } from "./backup-run.js";

const { readConfigFileSnapshot, backupPushCommand, workspaceBackupRunCommand } = vi.hoisted(() => ({
  readConfigFileSnapshot: vi.fn(),
  backupPushCommand: vi.fn(),
  workspaceBackupRunCommand: vi.fn(),
}));

vi.mock("../config/config.js", () => ({
  readConfigFileSnapshot,
}));

vi.mock("./backup-push.js", () => ({
  backupPushCommand,
}));

vi.mock("./workspace-backup.js", () => ({
  workspaceBackupRunCommand,
}));

describe("backupRunCommand", () => {
  const runtime = {
    log: vi.fn(),
    error: vi.fn(),
    exit: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    backupPushCommand.mockResolvedValue({ snapshotId: "snap_1" });
    workspaceBackupRunCommand.mockResolvedValue({ workspaceCount: 1 });
  });

  it("uses workspace mirroring when full backup is not configured", async () => {
    readConfigFileSnapshot.mockResolvedValue({
      valid: true,
      config: {
        backup: {
          target: "/tmp/backups",
        },
      },
    });

    const result = await backupRunCommand(runtime, {});

    expect(workspaceBackupRunCommand).toHaveBeenCalledWith(
      runtime,
      expect.objectContaining({ json: undefined }),
    );
    expect(backupPushCommand).not.toHaveBeenCalled();
    expect(result).toEqual({
      kind: "workspace",
      workspace: { workspaceCount: 1 },
    });
  });

  it("keeps workspace fallback when only the encryption key is configured", async () => {
    readConfigFileSnapshot.mockResolvedValue({
      valid: true,
      config: {
        backup: {
          encryption: { key: "secret" },
        },
      },
    });

    const result = await backupRunCommand(runtime, {});

    expect(workspaceBackupRunCommand).toHaveBeenCalled();
    expect(backupPushCommand).not.toHaveBeenCalled();
    expect(result).toEqual({
      kind: "workspace",
      workspace: { workspaceCount: 1 },
    });
  });

  it("uses snapshot backup when encryption is configured", async () => {
    readConfigFileSnapshot.mockResolvedValue({
      valid: true,
      config: {
        backup: {
          target: "/tmp/backups",
          encryption: { key: "secret" },
        },
      },
    });

    const result = await backupRunCommand(runtime, {
      output: "/tmp/archive.tar.gz",
      verify: true,
      snapshotName: "nightly",
    });

    expect(backupPushCommand).toHaveBeenCalledWith(
      runtime,
      expect.objectContaining({
        output: "/tmp/archive.tar.gz",
        verify: true,
        snapshotName: "nightly",
      }),
      undefined,
    );
    expect(result).toEqual({
      kind: "snapshot",
      snapshot: { snapshotId: "snap_1" },
    });
  });

  it("rejects snapshot-only options when auto mode falls back to workspace mirroring", async () => {
    readConfigFileSnapshot.mockResolvedValue({
      valid: true,
      config: {
        backup: {
          target: "/tmp/backups",
        },
      },
    });

    await expect(
      backupRunCommand(runtime, {
        snapshotName: "nightly",
      }),
    ).rejects.toThrow(
      "Snapshot-only options are not supported when backup run falls back to workspace mirroring.",
    );
  });

  it("allows forcing snapshot mode for the legacy push alias", async () => {
    const result = await backupRunCommand(runtime, { mode: "snapshot" });

    expect(backupPushCommand).toHaveBeenCalled();
    expect(result).toEqual({
      kind: "snapshot",
      snapshot: { snapshotId: "snap_1" },
    });
  });
});
