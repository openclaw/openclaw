import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFolderSnapshotStore } from "./provider-folder.js";
import type { BackupSnapshotEnvelope } from "./types.js";

const tempDirs: string[] = [];
const SNAPSHOT_LIST_READ_CONCURRENCY = 8;
const VALID_SALT = Buffer.alloc(16, 1).toString("base64url");
const VALID_NONCE = Buffer.alloc(12, 2).toString("base64url");
const VALID_AUTH_TAG = Buffer.alloc(16, 3).toString("base64url");

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
        saltBase64Url: VALID_SALT,
        cost: 1 << 15,
        blockSize: 8,
        parallelization: 1,
        maxMemoryBytes: 128 * 1024 * 1024,
      },
      nonceBase64Url: VALID_NONCE,
      authTagBase64Url: VALID_AUTH_TAG,
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
    if (process.platform === "win32") {
      return;
    }
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

  it("skips structurally invalid envelope files while listing healthy snapshots", async () => {
    const targetDir = await createTempDir("openclaw-snapshot-store-invalid-shape-");
    const snapshotRoot = path.join(targetDir, "snapshots", VALID_INSTALLATION_ID);
    const validEnvelope = createEnvelope(VALID_SNAPSHOT_ID, VALID_INSTALLATION_ID);
    await fs.mkdir(snapshotRoot, { recursive: true });
    await fs.writeFile(
      path.join(snapshotRoot, `${VALID_SNAPSHOT_ID}.envelope.json`),
      `${JSON.stringify(validEnvelope, null, 2)}\n`,
      "utf8",
    );
    await fs.writeFile(
      path.join(snapshotRoot, "snap_2026-03-10T00-00-02-000Z_deadbeef.envelope.json"),
      "{}\n",
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

  it("surfaces snapshot directory read failures other than ENOENT", async () => {
    const targetDir = await createTempDir("openclaw-snapshot-store-readdir-");
    const store = createFolderSnapshotStore({
      targetDir,
      encryptionKey: "secret",
    });
    const denied = Object.assign(new Error("permission denied"), { code: "EACCES" });
    vi.spyOn(fs, "readdir").mockRejectedValueOnce(denied);

    await expect(
      store.listSnapshots({
        installationId: VALID_INSTALLATION_ID,
      }),
    ).rejects.toThrow("permission denied");
  });

  it("rejects oversize payloads before storing snapshots", async () => {
    const targetDir = await createTempDir("openclaw-snapshot-store-oversize-");
    const payloadPath = path.join(targetDir, "source.payload");
    await fs.writeFile(payloadPath, "payload-data", "utf8");

    const store = createFolderSnapshotStore({
      targetDir,
      encryptionKey: "secret",
    });

    const originalLstat = fs.lstat.bind(fs);
    vi.spyOn(fs, "lstat").mockImplementation(async (filePath) => {
      const stat = await originalLstat(filePath);
      if (filePath === payloadPath) {
        return Object.assign(Object.create(Object.getPrototypeOf(stat)), stat, {
          size: 10 * 1024 * 1024 * 1024 + 1,
        });
      }
      return stat;
    });

    await expect(
      store.uploadSnapshot({
        installationId: VALID_INSTALLATION_ID,
        snapshotId: VALID_SNAPSHOT_ID,
        envelope: createEnvelope(VALID_SNAPSHOT_ID, VALID_INSTALLATION_ID),
        payloadPath,
      }),
    ).rejects.toThrow("Payload file exceeds maximum allowed size");

    await expect(
      fs.access(
        path.join(
          targetDir,
          "snapshots",
          VALID_INSTALLATION_ID,
          `${VALID_SNAPSHOT_ID}.payload.bin`,
        ),
      ),
    ).rejects.toThrow();
  });

  it("rejects oversize envelopes before storing snapshots", async () => {
    const targetDir = await createTempDir("openclaw-snapshot-store-envelope-oversize-");
    const payloadPath = path.join(targetDir, "source.payload");
    await fs.writeFile(payloadPath, "payload-data", "utf8");

    const store = createFolderSnapshotStore({
      targetDir,
      encryptionKey: "secret",
    });

    await expect(
      store.uploadSnapshot({
        installationId: VALID_INSTALLATION_ID,
        snapshotId: VALID_SNAPSHOT_ID,
        envelope: {
          ...createEnvelope(VALID_SNAPSHOT_ID, VALID_INSTALLATION_ID),
          snapshotName: "x".repeat(1024 * 1024),
        },
        payloadPath,
      }),
    ).rejects.toThrow("Envelope file exceeds maximum allowed size");

    const snapshotRoot = path.join(targetDir, "snapshots", VALID_INSTALLATION_ID);
    await expect(
      fs.access(path.join(snapshotRoot, `${VALID_SNAPSHOT_ID}.payload.bin`)),
    ).rejects.toThrow();
    await expect(
      fs.access(path.join(snapshotRoot, `${VALID_SNAPSHOT_ID}.envelope.json`)),
    ).rejects.toThrow();
  });

  it("surfaces envelope read failures other than ENOENT", async () => {
    const targetDir = await createTempDir("openclaw-snapshot-store-readfile-");
    const snapshotRoot = path.join(targetDir, "snapshots", VALID_INSTALLATION_ID);
    const validEnvelope = createEnvelope(VALID_SNAPSHOT_ID, VALID_INSTALLATION_ID);
    const validPath = path.join(snapshotRoot, `${VALID_SNAPSHOT_ID}.envelope.json`);
    const brokenPath = path.join(
      snapshotRoot,
      "snap_2026-03-10T00-00-02-000Z_deadbeef.envelope.json",
    );
    await fs.mkdir(snapshotRoot, { recursive: true });
    await fs.writeFile(validPath, `${JSON.stringify(validEnvelope, null, 2)}\n`, "utf8");
    await fs.writeFile(brokenPath, `${JSON.stringify(validEnvelope, null, 2)}\n`, "utf8");

    const readFileSpy = vi.spyOn(fs, "readFile");
    readFileSpy.mockImplementation(async (filePath, ...args) => {
      if (filePath === brokenPath) {
        throw Object.assign(new Error("i/o error"), { code: "EIO" });
      }
      return await vi
        .importActual<typeof import("node:fs/promises")>("node:fs/promises")
        .then((actual) => actual.readFile(filePath, ...args));
    });

    const store = createFolderSnapshotStore({
      targetDir,
      encryptionKey: "secret",
    });

    await expect(
      store.listSnapshots({
        installationId: VALID_INSTALLATION_ID,
      }),
    ).rejects.toThrow("i/o error");
  });

  it("bounds concurrent envelope reads while listing snapshots", async () => {
    const targetDir = await createTempDir("openclaw-snapshot-store-concurrency-");
    const snapshotRoot = path.join(targetDir, "snapshots", VALID_INSTALLATION_ID);
    const envelope = createEnvelope(VALID_SNAPSHOT_ID, VALID_INSTALLATION_ID);
    await fs.mkdir(snapshotRoot, { recursive: true });

    for (let index = 0; index < SNAPSHOT_LIST_READ_CONCURRENCY * 2 + 1; index += 1) {
      const snapshotId = `snap_2026-03-10T00-00-${String(index).padStart(2, "0")}-000Z_deadbeef`;
      await fs.writeFile(
        path.join(snapshotRoot, `${snapshotId}.envelope.json`),
        `${JSON.stringify({ ...envelope, snapshotId }, null, 2)}\n`,
        "utf8",
      );
    }

    const actualReadFile = fs.readFile.bind(fs);
    const pendingReads: Array<() => void> = [];
    let activeReads = 0;
    let maxActiveReads = 0;
    vi.spyOn(fs, "readFile").mockImplementation(async (filePath, ...args) => {
      if (typeof filePath !== "string" || !filePath.endsWith(".envelope.json")) {
        return actualReadFile(filePath, ...args);
      }
      activeReads += 1;
      maxActiveReads = Math.max(maxActiveReads, activeReads);
      await new Promise<void>((resolve) => pendingReads.push(resolve));
      try {
        return await actualReadFile(filePath, ...args);
      } finally {
        activeReads -= 1;
      }
    });

    const store = createFolderSnapshotStore({
      targetDir,
      encryptionKey: "secret",
    });
    const listPromise = store.listSnapshots({
      installationId: VALID_INSTALLATION_ID,
    });

    const expectedBatches = [SNAPSHOT_LIST_READ_CONCURRENCY, SNAPSHOT_LIST_READ_CONCURRENCY, 1];
    for (const batchSize of expectedBatches) {
      await vi.waitFor(() => {
        expect(pendingReads.length).toBe(batchSize);
      });
      expect(maxActiveReads).toBeLessThanOrEqual(SNAPSHOT_LIST_READ_CONCURRENCY);
      pendingReads.splice(0).forEach((resolve) => resolve());
    }

    const listed = await listPromise;
    expect(listed).toHaveLength(SNAPSHOT_LIST_READ_CONCURRENCY * 2 + 1);
    expect(maxActiveReads).toBe(SNAPSHOT_LIST_READ_CONCURRENCY);
  });
});
