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

const manifest = JSON.stringify({
  schemaVersion: 1,
  createdAt: "2026-05-04T00:00:00.000Z",
  archiveRoot: ARCHIVE_ROOT,
  runtimeVersion: "2026.5.4",
  platform: "linux",
  nodeVersion: "v22.22.0",
  paths: { stateDir: "/home/operator/.openclaw" },
  assets: [{ kind: "state", sourcePath: "/home/operator/.openclaw", archivePath: ASSET_ROOT }],
});

const file = (name: string, contents = CONTENTS) => ({ path: `${ASSET_ROOT}/${name}`, contents });
const link = (linkpath = ".openclaw/state/a.bin") => ({
  path: `${ASSET_ROOT}/state/b.bin`,
  type: "Link" as const,
  linkpath,
});

async function writeArchive(entries: Parameters<typeof encodeEntry>[0][]): Promise<string> {
  const directory = tempDirs.make("backup-legacy-hardlinks-");
  const archivePath = path.join(directory, "backup.tar.gz");
  await fs.writeFile(
    archivePath,
    gzipSync(
      Buffer.concat([
        encodeEntry({ path: `${ARCHIVE_ROOT}/manifest.json`, contents: manifest }),
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
        const archivePath = await writeArchive([file("state/a.bin"), link()]);
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

  it.each([
    [
      "unrelated same-suffix file",
      [{ path: `${ARCHIVE_ROOT}/payload/posix/other/.openclaw/state/a.bin`, contents: "other" }],
      link(),
      "missing",
    ],
    [
      "ambiguous recovery bytes",
      [file("state/a.bin", "first recovery copy"), file("a.bin", "different recovery copy")],
      link("a.bin"),
      "ambiguous",
    ],
    ["directory", [{ path: `${ASSET_ROOT}/state/a.bin`, type: "Directory" }], link(), "missing"],
    ["self", [], link(".openclaw/state/b.bin"), "missing"],
    [
      "another hardlink",
      [{ ...link(".openclaw/state/present.bin"), path: `${ASSET_ROOT}/state/a.bin` }],
      link(),
      "missing",
    ],
  ] as const)("rejects a legacy target with %s", async (_target, entries, hardlink, failure) => {
    const archivePath = await writeArchive([file("state/present.bin"), ...entries, hardlink]);
    await expect(verifyBackupArchive(archivePath)).rejects.toThrow(`hardlink target is ${failure}`);
  });
});
