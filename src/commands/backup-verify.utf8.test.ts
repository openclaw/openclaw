import fs from "node:fs/promises";
import path from "node:path";
import * as tar from "tar";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { verifyBackupArchive } from "./backup-verify.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

async function createArchive(runtimeVersion: Buffer) {
  const root = tempDirs.make("openclaw-backup-manifest-utf8-");
  const archiveRoot = "2026-10-09T00-00-00.000Z-openclaw-backup";
  const payload = `${archiveRoot}/payload/posix/tmp/.openclaw/payload.txt`;
  await fs.mkdir(path.join(root, path.dirname(payload)), { recursive: true });
  await fs.writeFile(path.join(root, payload), "synthetic payload\n");
  const raw = JSON.stringify({
    schemaVersion: 1,
    createdAt: "2026-10-09T00:00:00.000Z",
    archiveRoot,
    runtimeVersion: "SENTINEL",
    platform: process.platform,
    nodeVersion: process.version,
    paths: { stateDir: "/tmp/.openclaw" },
    assets: [{ kind: "state", sourcePath: "/tmp/.openclaw", archivePath: payload }],
  });
  const at = raw.indexOf("SENTINEL");
  await fs.writeFile(
    path.join(root, archiveRoot, "manifest.json"),
    Buffer.concat([
      Buffer.from(raw.slice(0, at)),
      runtimeVersion,
      Buffer.from(raw.slice(at + "SENTINEL".length)),
    ]),
  );
  const archive = path.join(root, "backup.tar.gz");
  await tar.c({ file: archive, cwd: root, gzip: true, portable: true }, [archiveRoot]);
  return archive;
}

describe("backup manifest encoding", () => {
  it.each([{ bytes: [0xff] }, { bytes: [0xe2, 0x82] }])(
    "rejects malformed UTF-8 without certifying or changing the archive (%j)",
    async ({ bytes }) => {
      const archive = await createArchive(Buffer.from(bytes));
      const before = await fs.readFile(archive);
      await expect(verifyBackupArchive(archive)).rejects.toThrow("must be valid UTF-8");
      expect(await fs.readFile(archive)).toEqual(before);
    },
  );

  it("verifies valid Unicode including a literal replacement character", async () => {
    const runtimeVersion = "合法 � 😀";
    const archive = await createArchive(Buffer.from(runtimeVersion));
    const before = await fs.readFile(archive);
    expect(await verifyBackupArchive(archive)).toMatchObject({
      runtimeVersion,
      assetCount: 1,
      sqliteInventoryVerified: false,
    });
    expect(await fs.readFile(archive)).toEqual(before);
  });
});
