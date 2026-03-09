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
      secret: "test-secret",
    });
    encrypted.archive.archiveRoot = "fake-root";
    encrypted.archive.createdAt = "2026-03-09T00:00:00.000Z";

    await decryptPayloadToArchive({
      payloadPath,
      archivePath: restoredPath,
      secret: "test-secret",
      envelope: encrypted,
    });

    expect(await fs.readFile(restoredPath, "utf8")).toBe("backup archive test\n");
  });
});
