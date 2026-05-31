import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  auditDrBackupDestinations,
  classifyBackupDestinationPath,
  createKeyFile,
  decryptFile,
  encryptFile,
  evaluateDestinationIndependence,
  hashFile,
  pruneEncryptedBackups,
  readEncryptedBackupHeader,
  readKeyFile,
  replicateEncryptedBackup,
} from "../../scripts/openclaw-dr-backup.mjs";

const tempDirs: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

describe("openclaw-dr-backup encryption", () => {
  it("encrypts and decrypts a backup payload without changing bytes", async () => {
    const root = await makeTempDir("openclaw-dr-backup-test-");
    const keyPath = path.join(root, "key.json");
    const plainPath = path.join(root, "backup.tar.gz");
    const encryptedPath = path.join(root, "backup.tar.gz.ocbackup.enc");
    const restoredPath = path.join(root, "restored.tar.gz");

    await createKeyFile(keyPath, new Date("2026-05-31T00:00:00.000Z"));
    const key = await readKeyFile(keyPath);
    await fs.writeFile(plainPath, Buffer.from("durable transcript backup\n", "utf8"));

    const encrypted = await encryptFile({
      inputPath: plainPath,
      outputPath: encryptedPath,
      key,
      now: new Date("2026-05-31T01:00:00.000Z"),
    });
    const header = await readEncryptedBackupHeader(encryptedPath);
    const decrypted = await decryptFile({
      inputPath: encryptedPath,
      outputPath: restoredPath,
      key,
    });

    expect(header.header).toMatchObject({
      schemaVersion: 1,
      cipher: "aes-256-gcm",
      plaintextName: "backup.tar.gz",
      createdAt: "2026-05-31T01:00:00.000Z",
    });
    expect(decrypted.plaintextSha256).toBe(encrypted.plaintextSha256);
    await expect(fs.readFile(restoredPath, "utf8")).resolves.toBe("durable transcript backup\n");
  });

  it("rejects decrypting with the wrong key", async () => {
    const root = await makeTempDir("openclaw-dr-backup-wrong-key-");
    const keyPath = path.join(root, "key.json");
    const wrongKeyPath = path.join(root, "wrong-key.json");
    const plainPath = path.join(root, "backup.tar.gz");
    const encryptedPath = path.join(root, "backup.tar.gz.ocbackup.enc");
    const restoredPath = path.join(root, "restored.tar.gz");

    await createKeyFile(keyPath);
    await createKeyFile(wrongKeyPath);
    await fs.writeFile(plainPath, "secret transcript\n", "utf8");
    await encryptFile({
      inputPath: plainPath,
      outputPath: encryptedPath,
      key: await readKeyFile(keyPath),
    });

    await expect(
      decryptFile({
        inputPath: encryptedPath,
        outputPath: restoredPath,
        key: await readKeyFile(wrongKeyPath),
      }),
    ).rejects.toThrow();
  });

  it("copies encrypted backup artifacts to replica destinations with hash verification", async () => {
    const root = await makeTempDir("openclaw-dr-backup-replica-");
    const sourceDir = path.join(root, "primary");
    const replicaDir = path.join(root, "replica");
    const tmpDir = path.join(root, "tmp");
    const encryptedPath = path.join(sourceDir, "backup.tar.gz.abc.ocbackup.enc");
    const sidecarPath = `${encryptedPath}.json`;

    await fs.mkdir(sourceDir, { recursive: true });
    await fs.writeFile(encryptedPath, "encrypted bytes\n", "utf8");
    await fs.writeFile(sidecarPath, '{"ok":true}\n', "utf8");

    const replicas = await replicateEncryptedBackup({
      encryptedPath,
      sidecarPath,
      encryptedSha256: await hashFile(encryptedPath),
      replicaDirs: [replicaDir],
      tmpDir,
    });

    expect(replicas).toHaveLength(1);
    await expect(
      fs.readFile(path.join(replicaDir, path.basename(encryptedPath)), "utf8"),
    ).resolves.toBe("encrypted bytes\n");
    await expect(
      fs.readFile(path.join(replicaDir, `${path.basename(encryptedPath)}.json`), "utf8"),
    ).resolves.toBe('{"ok":true}\n');
  });

  it("prunes encrypted backups and matching sidecars by retention count", async () => {
    const root = await makeTempDir("openclaw-dr-backup-prune-");
    const names = ["oldest", "middle", "newest"];
    const createdAts = [
      "2026-05-01T00:00:00.000Z",
      "2026-05-02T00:00:00.000Z",
      "2026-05-03T00:00:00.000Z",
    ];

    for (let index = 0; index < names.length; index += 1) {
      const filePath = path.join(root, `${names[index]}.ocbackup.enc`);
      await fs.writeFile(filePath, `${names[index]}\n`, "utf8");
      await fs.writeFile(
        `${filePath}.json`,
        `${JSON.stringify({ createdAt: createdAts[index] })}\n`,
        "utf8",
      );
    }

    const result = await pruneEncryptedBackups({
      outputDirs: [root],
      retentionCount: 2,
      nowMs: Date.parse("2026-05-04T00:00:00.000Z"),
    });

    expect(result).toEqual([
      {
        outputDir: root,
        scanned: 3,
        retained: 2,
        deleted: ["oldest.ocbackup.enc"],
      },
    ]);
    await expect(fs.access(path.join(root, "oldest.ocbackup.enc"))).rejects.toThrow();
    await expect(fs.access(path.join(root, "oldest.ocbackup.enc.json"))).rejects.toThrow();
    await expect(fs.access(path.join(root, "middle.ocbackup.enc"))).resolves.toBeUndefined();
    await expect(fs.access(path.join(root, "newest.ocbackup.enc"))).resolves.toBeUndefined();
  });
});

describe("openclaw-dr-backup destination audit", () => {
  it("classifies iCloud, CloudStorage providers, and external volumes independently", () => {
    const homeDir = "/Users/example";

    expect(
      classifyBackupDestinationPath(
        "/Users/example/Library/Mobile Documents/com~apple~CloudDocs/OpenClaw Backups",
        { homeDir, platform: "darwin" },
      ),
    ).toMatchObject({
      storageClass: "cloud-sync",
      provider: "icloud",
      independenceGroup: "cloud-sync:icloud",
    });
    expect(
      classifyBackupDestinationPath(
        "/Users/example/Library/CloudStorage/GoogleDrive-example/OpenClaw Backups",
        { homeDir, platform: "darwin" },
      ),
    ).toMatchObject({
      storageClass: "cloud-sync",
      provider: "GoogleDrive-example",
      independenceGroup: "cloud-sync:GoogleDrive-example",
    });
    expect(
      classifyBackupDestinationPath("/Volumes/BackupDisk/OpenClaw Backups", {
        homeDir,
        platform: "darwin",
      }),
    ).toMatchObject({
      storageClass: "external-volume",
      provider: "BackupDisk",
      independenceGroup: "volume:BackupDisk",
    });
  });

  it("detects when a replica is independent from the primary destination", () => {
    const homeDir = "/Users/example";
    const result = evaluateDestinationIndependence(
      "/Users/example/Library/Mobile Documents/com~apple~CloudDocs/OpenClaw Backups",
      [
        "/Users/example/Library/Mobile Documents/com~apple~CloudDocs/OpenClaw Backups Replica",
        "/Users/example/Library/CloudStorage/Dropbox-Example/OpenClaw Backups",
      ],
      { homeDir, platform: "darwin" },
    );

    expect(result.hasReplica).toBe(true);
    expect(result.hasIndependentReplica).toBe(true);
    expect(result.independentReplicas).toHaveLength(1);
    expect(result.independentReplicas[0]?.provider).toBe("Dropbox-Example");
  });

  it("audits encrypted backup replicas and fails when independent storage is required but absent", async () => {
    const root = await makeTempDir("openclaw-dr-backup-audit-");
    const primaryDir = path.join(root, "primary");
    const replicaDir = path.join(root, "replica");
    const fileName = "2026-05-31T00-00-00.000Z-openclaw-backup.tar.gz.abc.ocbackup.enc";

    await fs.mkdir(primaryDir, { recursive: true });
    await fs.mkdir(replicaDir, { recursive: true });
    const encryptedBytes = "encrypted bytes\n";
    for (const dir of [primaryDir, replicaDir]) {
      const backupPath = path.join(dir, fileName);
      await fs.writeFile(backupPath, encryptedBytes, "utf8");
      await fs.writeFile(
        `${backupPath}.json`,
        `${JSON.stringify({
          createdAt: "2026-05-31T00:00:00.000Z",
          encryptedSha256: await hashFile(backupPath),
        })}\n`,
        "utf8",
      );
    }

    const result = await auditDrBackupDestinations({
      outputDir: primaryDir,
      replicaDirs: [replicaDir],
      requireIndependent: true,
    });

    expect(result.ok).toBe(false);
    expect(result.requirements.primaryHasBackup).toBe(true);
    expect(result.requirements.replicaConfigured).toBe(true);
    expect(result.requirements.independentReplicaMet).toBe(false);
    expect(result.errors.map((entry) => entry.code)).toContain("independent_replica_missing");
  });
});
