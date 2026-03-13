import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
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

  it("retries after create races until the winning installation record is complete", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-installation-id-"));
    tempDirs.push(stateDir);
    const backupDir = path.join(stateDir, "backup");
    const filePath = path.join(backupDir, "installation.json");
    const validRecord = `${JSON.stringify(
      {
        schemaVersion: 1,
        installationId: "inst_1234567890abcdef12345678",
        createdAt: "2026-03-13T00:00:00.000Z",
      },
      null,
      2,
    )}\n`;

    const readFileMock = vi.spyOn(fs, "readFile");
    readFileMock.mockRejectedValueOnce(Object.assign(new Error("missing"), { code: "ENOENT" }));
    readFileMock.mockResolvedValueOnce("{");
    readFileMock.mockResolvedValueOnce(validRecord);

    const writeFileMock = vi.spyOn(fs, "writeFile");
    writeFileMock.mockRejectedValueOnce(Object.assign(new Error("exists"), { code: "EEXIST" }));

    const mkdirMock = vi.spyOn(fs, "mkdir");

    try {
      await expect(
        resolveInstallationId({
          stateDir,
          createIfMissing: true,
        }),
      ).resolves.toBe("inst_1234567890abcdef12345678");

      expect(mkdirMock).toHaveBeenCalledWith(backupDir, { recursive: true });
      expect(writeFileMock).toHaveBeenCalledTimes(1);
      expect(readFileMock).toHaveBeenCalledWith(filePath, "utf8");
    } finally {
      readFileMock.mockRestore();
      writeFileMock.mockRestore();
      mkdirMock.mockRestore();
    }
  });
});
