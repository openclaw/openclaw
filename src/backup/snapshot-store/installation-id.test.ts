import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveInstallationId } from "./installation-id.js";

describe("resolveInstallationId", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(
      tempDirs.map(async (dir) => await fs.rm(dir, { recursive: true, force: true })),
    );
    tempDirs.length = 0;
  });

  it("creates a new installation id when the record is missing", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-installation-id-"));
    tempDirs.push(stateDir);

    const installationId = await resolveInstallationId({
      stateDir,
      createIfMissing: true,
    });

    expect(installationId).toMatch(/^inst_[0-9a-f]{24}$/);
  });

  it("rejects malformed installation records instead of rotating ids", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-installation-id-"));
    tempDirs.push(stateDir);
    const backupDir = path.join(stateDir, "backup");
    await fs.mkdir(backupDir, { recursive: true });
    await fs.writeFile(path.join(backupDir, "installation.json"), "{", "utf8");

    await expect(
      resolveInstallationId({
        stateDir,
        createIfMissing: true,
      }),
    ).rejects.toThrow("Invalid backup installation record");
  });
});
