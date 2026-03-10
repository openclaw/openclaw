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

const VALID_INSTALLATION_ID = "inst_1234567890abcdef12345678";
const VALID_SNAPSHOT_ID = "snap_2026-03-10T00-00-00-000Z_deadbeef";

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
      installationId: VALID_INSTALLATION_ID,
      snapshotId: VALID_SNAPSHOT_ID,
      envelope: createEnvelope(VALID_SNAPSHOT_ID, VALID_INSTALLATION_ID),
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
      installationId: VALID_INSTALLATION_ID,
      snapshotId: VALID_SNAPSHOT_ID,
      envelope: createEnvelope(VALID_SNAPSHOT_ID, VALID_INSTALLATION_ID),
      payloadPath,
    });

    const snapshotRoot = path.join(targetDir, "snapshots", VALID_INSTALLATION_ID);
    const envelopeStat = await fs.stat(
      path.join(snapshotRoot, `${VALID_SNAPSHOT_ID}.envelope.json`),
    );
    const payloadStat = await fs.stat(path.join(snapshotRoot, `${VALID_SNAPSHOT_ID}.payload.bin`));
    expect(envelopeStat.mode & 0o777).toBe(0o600);
    expect(payloadStat.mode & 0o777).toBe(0o600);
  });

  it("rejects invalid storage identifiers before touching the filesystem", async () => {
    const targetDir = await createTempDir("openclaw-snapshot-store-invalid-");
    const payloadPath = path.join(targetDir, "source.payload");
    await fs.writeFile(payloadPath, "payload-data", "utf8");

    const store = createFolderSnapshotStore({
      targetDir,
      encryptionKey: "secret",
    });

    await expect(
      store.uploadSnapshot({
        installationId: "../bad",
        snapshotId: VALID_SNAPSHOT_ID,
        envelope: createEnvelope(VALID_SNAPSHOT_ID, VALID_INSTALLATION_ID),
        payloadPath,
      }),
    ).rejects.toThrow("Invalid installationId");
  });

  it("skips malformed envelope files while listing healthy snapshots", async () => {
    const targetDir = await createTempDir("openclaw-snapshot-store-list-");
    const snapshotRoot = path.join(targetDir, "snapshots", VALID_INSTALLATION_ID);
    const validEnvelope = createEnvelope(VALID_SNAPSHOT_ID, VALID_INSTALLATION_ID);
    await fs.mkdir(snapshotRoot, { recursive: true });
    await fs.writeFile(
      path.join(snapshotRoot, `${VALID_SNAPSHOT_ID}.envelope.json`),
      `${JSON.stringify(validEnvelope, null, 2)}\n`,
      "utf8",
    );
    await fs.writeFile(
      path.join(snapshotRoot, "snap_2026-03-10T00-00-01-000Z_deadbeef.envelope.json"),
      "{not-json",
      "utf8",
    );

    const store = createFolderSnapshotStore({
      targetDir,
      encryptionKey: "secret",
    });

    await expect(
      store.listSnapshots({
        installationId: VALID_INSTALLATION_ID,
      }),
    ).resolves.toEqual([validEnvelope]);
  });
});
