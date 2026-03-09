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

    const writeSpy = vi.spyOn(fs, "writeFile");
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

    const uploadWrites = writeSpy.mock.calls
      .map((call) => call[0])
      .filter(
        (filePath): filePath is string => typeof filePath === "string" && filePath.endsWith(".tmp"),
      );
    expect(uploadWrites[0]).toContain(".payload.bin.tmp");
    expect(uploadWrites[1]).toContain(".envelope.json.tmp");
  });

  it("writes snapshot files with restrictive mode", async () => {
    const targetDir = await createTempDir("openclaw-snapshot-store-mode-");
    const payloadPath = path.join(targetDir, "source.payload");
    await fs.writeFile(payloadPath, "payload-data", "utf8");

    const writeSpy = vi.spyOn(fs, "writeFile");
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

    const uploadWrites = writeSpy.mock.calls.filter((call) => {
      const filePath = call[0];
      return typeof filePath === "string" && filePath.includes(path.join("snapshots", "inst_1"));
    });
    expect(uploadWrites.length).toBeGreaterThanOrEqual(2);
    for (const call of uploadWrites) {
      expect(call[2]).toMatchObject({ mode: 0o600 });
    }
  });
});
