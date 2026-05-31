import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createKeyFile,
  decryptFile,
  encryptFile,
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
