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

const { fixture } = installFreshUpdateFixture();

it("refuses a package update before staging when only the candidate copy fits", async () => {
  const stateDir = process.env.OPENCLAW_STATE_DIR!;
  const file = path.join(stateDir, "agents/main/agent/openclaw-agent.sqlite");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  {
    using db = openNodeSqliteDatabase(file);
    db.exec("CREATE TABLE evidence(value BLOB); INSERT INTO evidence VALUES(zeroblob(16777216))");
  }
  const before = fs.readFileSync(file);
  const backupDirectory = path.dirname(fixture.root);
  vi.spyOn(diskSpace, "tryReadDiskSpace").mockImplementation((targetPath) => ({
    targetPath,
    checkedPath: targetPath,
    availableBytes: (targetPath === backupDirectory ? 100 : 160) * 1024 ** 2,
    totalBytes: 1024 ** 3,
  }));
  vi.mocked(packageMetadata.fetchNpmPackageTargetStatus).mockResolvedValue({
    ...targetMetadata,
    version: "9999.0.0",
  });
  vi.mocked(shared.resolveTargetVersion).mockResolvedValue({ version: "9999.0.0" });

  await expect(updateCommand({ tag: "9999.0.0", yes: true, json: true })).rejects.toMatchObject({
    code: 1,
  });

  const result = vi.mocked(defaultRuntime.writeJson).mock.lastCall?.[0];
  expect(result).toMatchObject({ reason: "snapshot-capacity-insufficient" });
  expect(JSON.stringify(result)).toContain("Update database backup");
  expect(JSON.stringify(result)).toContain(backupDirectory);
  expect(packageUpdate.stagePackageInstallUpdate).not.toHaveBeenCalled();
  expect(fs.readFileSync(file).equals(before)).toBe(true);
  expect(fs.existsSync(fixture.databasePath)).toBe(false);
});
