import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { decryptPayloadToArchive, encryptArchiveToPayload } from "./encryption.js";

const tempDirs: string[] = [];

async function createTempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("snapshot backup encryption", () => {
  it("round trips a local archive through encrypt and decrypt", async () => {
    const tempDir = await createTempDir("openclaw-snapshot-encryption-");
    const archivePath = path.join(tempDir, "archive.tar.gz");
    const payloadPath = path.join(tempDir, "payload.bin");
    const restoredPath = path.join(tempDir, "restored.tar.gz");
    await fs.writeFile(archivePath, "backup archive test\n", "utf8");

    const encrypted = await encryptArchiveToPayload({
      archivePath,
      payloadPath,
      secret: "test-secret", // pragma: allowlist secret
    });

    await decryptPayloadToArchive({
      payloadPath,
      archivePath: restoredPath,
      secret: "test-secret", // pragma: allowlist secret
      envelope: {
        archive: {
          format: "openclaw-backup-tar-gz",
          archiveRoot: "fake-root",
          createdAt: "2026-03-09T00:00:00.000Z",
          mode: "full-host",
          includeWorkspace: true,
          verified: false,
          sha256: encrypted.archiveSha256,
          bytes: encrypted.archiveBytes,
        },
        ciphertext: encrypted.ciphertext,
        encryption: encrypted.encryption,
      },
    });

    expect(await fs.readFile(restoredPath, "utf8")).toBe("backup archive test\n");
  });

  it("removes temporary plaintext archives when integrity validation fails", async () => {
    const tempDir = await createTempDir("openclaw-snapshot-encryption-fail-");
    const archivePath = path.join(tempDir, "archive.tar.gz");
    const payloadPath = path.join(tempDir, "payload.bin");
    const restoredPath = path.join(tempDir, "restored.tar.gz");
    await fs.writeFile(archivePath, "backup archive test\n", "utf8");

    const encrypted = await encryptArchiveToPayload({
      archivePath,
      payloadPath,
      secret: "test-secret", // pragma: allowlist secret
    });

    await expect(
      decryptPayloadToArchive({
        payloadPath,
        archivePath: restoredPath,
        secret: "test-secret", // pragma: allowlist secret
        envelope: {
          archive: {
            format: "openclaw-backup-tar-gz",
            archiveRoot: "fake-root",
            createdAt: "2026-03-09T00:00:00.000Z",
            mode: "full-host",
            includeWorkspace: true,
            verified: false,
            sha256: "bad-sha",
            bytes: encrypted.archiveBytes,
          },
          ciphertext: encrypted.ciphertext,
          encryption: encrypted.encryption,
        },
      }),
    ).rejects.toThrow("Decrypted archive checksum mismatch.");
    await expect(fs.access(restoredPath)).rejects.toThrow();
    await expect(fs.access(`${restoredPath}.${process.pid}.tmp`)).rejects.toThrow();
  });

  it("uses envelope key-derivation parameters when deriving the restore key", async () => {
    const tempDir = await createTempDir("openclaw-snapshot-encryption-kdf-");
    const archivePath = path.join(tempDir, "archive.tar.gz");
    const payloadPath = path.join(tempDir, "payload.bin");
    const restoredPath = path.join(tempDir, "restored.tar.gz");
    await fs.writeFile(archivePath, "backup archive test\n", "utf8");

    const encrypted = await encryptArchiveToPayload({
      archivePath,
      payloadPath,
      secret: "test-secret", // pragma: allowlist secret
    });
    const envelope = {
      archive: {
        format: "openclaw-backup-tar-gz" as const,
        archiveRoot: "fake-root",
        createdAt: "2026-03-09T00:00:00.000Z",
        mode: "full-host" as const,
        includeWorkspace: true,
        verified: false,
        sha256: encrypted.archiveSha256,
        bytes: encrypted.archiveBytes,
      },
      ciphertext: encrypted.ciphertext,
      encryption: {
        ...encrypted.encryption,
        keyDerivation: {
          ...encrypted.encryption.keyDerivation,
          cost: encrypted.encryption.keyDerivation.cost + 1,
        },
      },
    };

    await expect(
      decryptPayloadToArchive({
        payloadPath,
        archivePath: restoredPath,
        secret: "test-secret", // pragma: allowlist secret
        envelope,
      }),
    ).rejects.toThrow("Invalid snapshot envelope: unsupported encryption.keyDerivation.cost.");
  });

  it("rejects malformed envelope crypto metadata before decrypting", async () => {
    const tempDir = await createTempDir("openclaw-snapshot-encryption-metadata-");
    const archivePath = path.join(tempDir, "archive.tar.gz");
    const payloadPath = path.join(tempDir, "payload.bin");
    const restoredPath = path.join(tempDir, "restored.tar.gz");
    await fs.writeFile(archivePath, "backup archive test\n", "utf8");

    const encrypted = await encryptArchiveToPayload({
      archivePath,
      payloadPath,
      secret: "test-secret", // pragma: allowlist secret
    });
    const envelope = {
      archive: {
        format: "openclaw-backup-tar-gz" as const,
        archiveRoot: "fake-root",
        createdAt: "2026-03-09T00:00:00.000Z",
        mode: "full-host" as const,
        includeWorkspace: true,
        verified: false,
        sha256: encrypted.archiveSha256,
        bytes: encrypted.archiveBytes,
      },
      ciphertext: encrypted.ciphertext,
      encryption: {
        ...encrypted.encryption,
        authTagBase64Url: Buffer.alloc(8).toString("base64url"),
      },
    };

    await expect(
      decryptPayloadToArchive({
        payloadPath,
        archivePath: restoredPath,
        secret: "test-secret", // pragma: allowlist secret
        envelope,
      }),
    ).rejects.toThrow(
      "Invalid snapshot envelope: encryption.authTagBase64Url must decode to 16 bytes.",
    );
  });
});
