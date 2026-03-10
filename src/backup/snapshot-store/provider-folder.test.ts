import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFolderSnapshotStore } from "./provider-folder.js";
import type { BackupSnapshotEnvelope } from "./types.js";

const tempDirs: string[] = [];

async function createTempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function createEnvelope(snapshotId: string, installationId: string): BackupSnapshotEnvelope {
  return {
    schemaVersion: 1,
    snapshotId,
    installationId,
    createdAt: "2026-03-09T00:00:00.000Z",
    openclawVersion: "2026.3.9",
    archive: {
      format: "openclaw-backup-tar-gz",
      archiveRoot: "openclaw-backup",
      createdAt: "2026-03-09T00:00:00.000Z",
      mode: "full-host",
      includeWorkspace: true,
      verified: true,
      sha256: "sha256",
      bytes: 1,
    },
    encryption: {
      cipher: "aes-256-gcm",
      keyDerivation: {
        name: "scrypt",
        saltBase64Url: "salt",
        cost: 1,
        blockSize: 8,
        parallelization: 1,
        maxMemoryBytes: 1024,
      },
      nonceBase64Url: "nonce",
      authTagBase64Url: "tag",
    },
    ciphertext: {
      sha256: "ciphertext",
      bytes: 1,
    },
  };
}

afterEach(async () => {
  vi.restoreAllMocks();
  for (const dir of tempDirs.splice(0)) {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

describe("folder snapshot store", () => {
  it("writes payload before envelope so envelope remains the visibility marker", async () => {
    const targetDir = await createTempDir("openclaw-snapshot-store-");
    const payloadPath = path.join(targetDir, "source.payload");
    await fs.writeFile(payloadPath, "payload-data", "utf8");

    const renameSpy = vi.spyOn(fs, "rename");
    const store = createFolderSnapshotStore({
      targetDir,
      encryptionKey: "secret",
    });

    await store.uploadSnapshot({
      installationId: "inst_1",
      snapshotId: "snap_1",
      envelope: createEnvelope("snap_1", "inst_1"),
      payloadPath,
    });

    const uploadRenames = renameSpy.mock.calls
      .map((call) => call[0])
      .filter(
        (filePath): filePath is string => typeof filePath === "string" && filePath.includes(".tmp"),
      );
    const renameTargets = renameSpy.mock.calls
      .map((call) => call[1])
      .filter((filePath): filePath is string => typeof filePath === "string");
    expect(uploadRenames[0]).toContain(".payload.bin.");
    expect(uploadRenames[1]).toContain(".envelope.json.");
    expect(renameTargets[0]).toContain(".payload.bin");
    expect(renameTargets[1]).toContain(".envelope.json");
  });

  it("writes snapshot files with restrictive mode", async () => {
    const targetDir = await createTempDir("openclaw-snapshot-store-mode-");
    const payloadPath = path.join(targetDir, "source.payload");
    await fs.writeFile(payloadPath, "payload-data", "utf8");

    const store = createFolderSnapshotStore({
      targetDir,
      encryptionKey: "secret",
    });

    await store.uploadSnapshot({
      installationId: "inst_1",
      snapshotId: "snap_1",
      envelope: createEnvelope("snap_1", "inst_1"),
      payloadPath,
    });

    const snapshotRoot = path.join(targetDir, "snapshots", "inst_1");
    const envelopeStat = await fs.stat(path.join(snapshotRoot, "snap_1.envelope.json"));
    const payloadStat = await fs.stat(path.join(snapshotRoot, "snap_1.payload.bin"));
    expect(envelopeStat.mode & 0o777).toBe(0o600);
    expect(payloadStat.mode & 0o777).toBe(0o600);
  });
});
