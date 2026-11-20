import fs from "node:fs";
import path from "node:path";
import { expect, it, vi } from "vitest";
import * as diskSpace from "../../infra/disk-space.js";
import { openNodeSqliteDatabase } from "../../infra/node-sqlite.js";
import * as packageMetadata from "../../infra/update-check-package-target.js";
import { defaultRuntime } from "../../runtime.js";
import * as shared from "./shared.js";
import { installFreshUpdateFixture, targetMetadata } from "./update-command-fresh.test-support.js";
import * as packageUpdate from "./update-command-package.js";
import { updateCommand } from "./update-command.js";
import { writeSucceededUpdateCopies } from "./update-recovery-copies.test-support.js";

const { fixture } = installFreshUpdateFixture();

/** A 16 MiB agent database whose pre-migration image does not fit beside the package. */
function seedPackageShortfall({ stateVolumeMiB = 160 } = {}) {
  const file = path.join(
    process.env.OPENCLAW_STATE_DIR!,
    "agents/main/agent/openclaw-agent.sqlite",
  );
  fs.mkdirSync(path.dirname(file), { recursive: true });
  {
    using db = openNodeSqliteDatabase(file);
    db.exec("CREATE TABLE evidence(value BLOB); INSERT INTO evidence VALUES(zeroblob(16777216))");
  }
  const backupDirectory = path.dirname(fixture.root);
  // The image needs the agent plus the larger of its staging and the migration room: 96 MiB.
  vi.spyOn(diskSpace, "tryReadDiskSpace").mockImplementation((targetPath) => ({
    targetPath,
    checkedPath: targetPath,
    availableBytes: (targetPath === backupDirectory ? 90 : stateVolumeMiB) * 1024 ** 2,
    totalBytes: 1024 ** 3,
  }));
  vi.mocked(packageMetadata.fetchNpmPackageTargetStatus).mockResolvedValue({
    ...targetMetadata,
    version: "9999.0.0",
  });
  vi.mocked(shared.resolveTargetVersion).mockResolvedValue({ version: "9999.0.0" });
  return { file, backupDirectory };
}

function printedWarnings() {
  return vi
    .mocked(defaultRuntime.error)
    .mock.calls.map(([line]) => String(line))
    .filter((line) => line.startsWith("Warning: "));
}

it("continues a package update past a pre-migration image that does not fit", async () => {
  const { file, backupDirectory } = seedPackageShortfall();
  const before = fs.readFileSync(file);

  // The fixture's staging refuses, which proves the update went past the space check.
  await expect(updateCommand({ tag: "9999.0.0", yes: true, json: true })).rejects.toThrow(
    "Read-only update admission must not stage a package",
  );

  expect(packageUpdate.stagePackageInstallUpdate).toHaveBeenCalledTimes(1);
  expect(printedWarnings()).toContain(
    `Warning: No pre-migration database image: it needs 96 MiB near ${backupDirectory} and 90 MiB is free. Without it, the previous version cannot be restored once the new version's database migration commits; a failed update then stays on the new version and is fixed forward. The update continues and measures the image again before the migration.`,
  );
  const result = vi.mocked(defaultRuntime.writeJson).mock.lastCall?.[0];
  expect(result).not.toMatchObject({ reason: "snapshot-capacity-insufficient" });
  expect(fs.readFileSync(file).equals(before)).toBe(true);
});

it("reports retirable recovery copies before terminal cleanup", async () => {
  seedPackageShortfall();
  const copies = writeSucceededUpdateCopies(process.env.OPENCLAW_STATE_DIR!, [
    Date.UTC(2026, 9, 1),
    Date.UTC(2026, 9, 2),
  ]);

  await expect(updateCommand({ tag: "9999.0.0", yes: true, json: true })).rejects.toMatchObject({
    code: 1,
  });

  expect(printedWarnings()).toContainEqual(
    expect.stringMatching(
      /^Warning: 1 recovery copy from earlier updates use .+ and can be removed\. Run openclaw update in a terminal to be offered their removal, or stop the Gateway and run openclaw update cleanup to keep a pre-migration image on the next update\.$/u,
    ),
  );
  expect(copies.map(fs.existsSync)).toEqual([false, true]);
  expect(packageUpdate.stagePackageInstallUpdate).toHaveBeenCalledTimes(1);
});

it("refuses before staging only when the migration itself has no room", async () => {
  const { file } = seedPackageShortfall({ stateVolumeMiB: 50 });
  const before = fs.readFileSync(file);

  await expect(updateCommand({ tag: "9999.0.0", yes: true, json: true })).rejects.toMatchObject({
    code: 1,
  });

  const result = vi.mocked(defaultRuntime.writeJson).mock.lastCall?.[0];
  expect(result).toMatchObject({ reason: "snapshot-capacity-insufficient" });
  // The agent file is 16 MiB plus a few SQLite pages, so the exact byte count varies.
  expect(JSON.stringify(result)).toContain(
    `A database migration may need up to 80 MiB (${80 * 1024 ** 2 + fs.statSync(file).size - 16 * 1024 ** 2} bytes) of free space near ${path.dirname(file)} for its write-ahead log, but only 50 MiB (${50 * 1024 ** 2} bytes) is available. Free at least 30 MiB (${30 * 1024 ** 2 + fs.statSync(file).size - 16 * 1024 ** 2} bytes) on that volume, then run openclaw update again; nothing has changed.`,
  );
  expect(packageUpdate.stagePackageInstallUpdate).not.toHaveBeenCalled();
  expect(fs.readFileSync(file).equals(before)).toBe(true);
  expect(fs.existsSync(fixture.databasePath)).toBe(false);
});
