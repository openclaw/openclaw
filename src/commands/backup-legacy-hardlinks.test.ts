import fs from "node:fs/promises";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { backupRestoreCommand } from "./backup-restore.js";
import { encodeTarEntry as encodeEntry } from "./backup-tar.test-support.js";
import { verifyBackupArchive } from "./backup-verify.js";
import { createTestRuntime } from "./test-runtime-config-helpers.js";

const ARCHIVE_ROOT = "2026-05-04T00-00-00.000Z-openclaw-backup";
const ASSET_ROOT = `${ARCHIVE_ROOT}/payload/posix/home/operator/.openclaw`;
const CONTENTS = "A retained recovery copy must restore both names to the same original bytes.\n";
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function manifest(): string {
  return JSON.stringify({
    schemaVersion: 1,
    createdAt: "2026-05-04T00:00:00.000Z",
    archiveRoot: ARCHIVE_ROOT,
    runtimeVersion: "2026.5.4",
    platform: "linux",
    nodeVersion: "v22.22.0",
    paths: { stateDir: "/home/operator/.openclaw" },
    assets: [{ kind: "state", sourcePath: "/home/operator/.openclaw", archivePath: ASSET_ROOT }],
  });
}

async function writeArchive(entries: Parameters<typeof encodeEntry>[0][]): Promise<string> {
  const directory = tempDirs.make("backup-legacy-hardlinks-");
  const archivePath = path.join(directory, "backup.tar.gz");
  await fs.writeFile(
    archivePath,
    gzipSync(
      Buffer.concat([
        encodeEntry({ path: `${ARCHIVE_ROOT}/manifest.json`, contents: manifest() }),
        ...entries.map(encodeEntry),
        Buffer.alloc(1024),
      ]),
    ),
  );
  return archivePath;
}

describe("legacy backup hardlinks", () => {
  it("verifies and restores cwd-relative hardlinks from older backups", async () => {
    await withOpenClawTestState(
      { layout: "state-only", prefix: "backup-native-legacy-link-", scenario: "minimal" },
      async (state) => {
        const archivePath = await writeArchive([
          { path: `${ASSET_ROOT}/state/a.bin`, contents: CONTENTS },
          { path: `${ASSET_ROOT}/state/b.bin`, type: "Link", linkpath: ".openclaw/state/a.bin" },
        ]);
        await expect(verifyBackupArchive(archivePath)).resolves.toMatchObject({ ok: true });
        const target = state.path("restored");
        await backupRestoreCommand(createTestRuntime(), { archive: archivePath, target });
        const original = path.join(target, ASSET_ROOT, "state", "a.bin");
        const alias = path.join(target, ASSET_ROOT, "state", "b.bin");
        expect(await fs.readFile(alias, "utf8")).toBe(CONTENTS);
        expect((await fs.stat(alias)).ino).toBe((await fs.stat(original)).ino);
      },
    );
  });

  it("does not substitute an unrelated same-suffix file for a missing target", async () => {
    const archivePath = await writeArchive([
      { path: `${ASSET_ROOT}/state/present.bin`, contents: CONTENTS },
      { path: `${ARCHIVE_ROOT}/payload/posix/other/.openclaw/state/a.bin`, contents: "other" },
      { path: `${ASSET_ROOT}/state/b.bin`, type: "Link", linkpath: ".openclaw/state/a.bin" },
    ]);
    await expect(verifyBackupArchive(archivePath)).rejects.toThrow(/hardlink target is missing/i);
  });

  it("rejects ambiguous legacy targets instead of selecting different recovery bytes", async () => {
    const archivePath = await writeArchive([
      { path: `${ASSET_ROOT}/state/a.bin`, contents: "first recovery copy" },
      { path: `${ASSET_ROOT}/a.bin`, contents: "different recovery copy" },
      { path: `${ASSET_ROOT}/state/b.bin`, type: "Link", linkpath: "a.bin" },
    ]);
    await expect(verifyBackupArchive(archivePath)).rejects.toThrow(/hardlink target is ambiguous/i);
  });

  it.each(["directory", "self", "another hardlink"] as const)(
    "rejects a legacy target that only resolves to %s",
    async (target) => {
      const archivePath = await writeArchive([
        { path: `${ASSET_ROOT}/state/present.bin`, contents: CONTENTS },
        ...(target === "self"
          ? []
          : [
              {
                path: `${ASSET_ROOT}/state/a.bin`,
                type: target === "directory" ? ("Directory" as const) : ("Link" as const),
                ...(target === "another hardlink"
                  ? { linkpath: ".openclaw/state/present.bin" }
                  : {}),
              },
            ]),
        {
          path: `${ASSET_ROOT}/state/b.bin`,
          type: "Link",
          linkpath: target === "self" ? ".openclaw/state/b.bin" : ".openclaw/state/a.bin",
        },
      ]);
      await expect(verifyBackupArchive(archivePath)).rejects.toThrow(/hardlink target is missing/i);
    },
  );
});
