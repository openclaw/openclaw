import { beforeEach, describe, expect, it, vi } from "vitest";
import { backupStatusCommand } from "./backup-status.js";

const VALID_SALT = Buffer.alloc(16, 1).toString("base64url");
const VALID_NONCE = Buffer.alloc(12, 2).toString("base64url");
const VALID_AUTH_TAG = Buffer.alloc(16, 3).toString("base64url");

const {
  readConfigFileSnapshot,
  getWorkspaceBackupStatus,
  loadResolvedSnapshotBackup,
  resolveSnapshotStore,
  resolveCurrentInstallationId,
} = vi.hoisted(() => ({
  readConfigFileSnapshot: vi.fn(),
  getWorkspaceBackupStatus: vi.fn(),
  loadResolvedSnapshotBackup: vi.fn(),
  resolveSnapshotStore: vi.fn(),
  resolveCurrentInstallationId: vi.fn(),
}));

vi.mock("../config/config.js", () => ({
  readConfigFileSnapshot,
}));

vi.mock("./workspace-backup.js", () => ({
  getWorkspaceBackupStatus,
}));

vi.mock("./backup-snapshot-shared.js", async () => {
  const actual = await vi.importActual<typeof import("./backup-snapshot-shared.js")>(
    "./backup-snapshot-shared.js",
  );
  return {
    ...actual,
    loadResolvedSnapshotBackup,
    resolveSnapshotStore,
    resolveCurrentInstallationId,
  };
});

describe("backupStatusCommand", () => {
  const runtime = {
    log: vi.fn(),
    error: vi.fn(),
    exit: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    getWorkspaceBackupStatus.mockResolvedValue({
      configured: false,
      workspaceCount: 0,
      detected: "iCloud Drive",
    });
  });

  it("reports workspace-only backup when full snapshots are not enabled", async () => {
    readConfigFileSnapshot.mockResolvedValue({
      valid: true,
      config: {
        backup: {
          target: "/tmp/backups",
        },
      },
    });

    const result = await backupStatusCommand(runtime, {});

    expect(result).toMatchObject({
      target: "/tmp/backups",
      snapshot: {
        enabled: false,
        snapshotCount: 0,
      },
    });
    expect(loadResolvedSnapshotBackup).not.toHaveBeenCalled();
  });

  it("includes the latest full snapshot when encryption is configured", async () => {
    readConfigFileSnapshot.mockResolvedValue({
      valid: true,
      config: {
        backup: {
          target: "/tmp/backups",
          encryption: {
            key: "secret",
          },
        },
      },
    });
    loadResolvedSnapshotBackup.mockResolvedValue({
      snapshotStore: {
        targetDir: "/tmp/backups",
      },
      stateDir: "/tmp/state",
    });
    resolveCurrentInstallationId.mockResolvedValue("inst_1");
    resolveSnapshotStore.mockResolvedValue({
      listSnapshots: vi.fn().mockResolvedValue([
        {
          snapshotId: "snap_1",
          installationId: "inst_1",
          createdAt: "2026-03-10T00:00:00.000Z",
          openclawVersion: "2026.3.10",
          archive: {
            mode: "full-host",
            includeWorkspace: true,
            verified: true,
            bytes: 128,
            format: "openclaw-backup-tar-gz",
            archiveRoot: "root",
            createdAt: "2026-03-10T00:00:00.000Z",
            sha256: "abc",
          },
          ciphertext: {
            bytes: 256,
            sha256: "def",
          },
          encryption: {
            cipher: "aes-256-gcm",
            keyDerivation: {
              name: "scrypt",
              saltBase64Url: VALID_SALT,
              cost: 1 << 15,
              blockSize: 8,
              parallelization: 1,
              maxMemoryBytes: 128 * 1024 * 1024,
            },
            nonceBase64Url: VALID_NONCE,
            authTagBase64Url: VALID_AUTH_TAG,
          },
        },
      ]),
    });

    const result = await backupStatusCommand(runtime, {});

    expect(result).toMatchObject({
      target: "/tmp/backups",
      snapshot: {
        enabled: true,
        installationId: "inst_1",
        snapshotCount: 1,
        latestSnapshotId: "snap_1",
      },
    });
  });
});
