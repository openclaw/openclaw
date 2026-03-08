import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTempHomeEnv, type TempHomeEnv } from "../test-utils/temp-home.js";

const tarCreateMock = vi.hoisted(() => vi.fn());
const backupVerifyCommandMock = vi.hoisted(() => vi.fn());

vi.mock("tar", () => ({
  c: tarCreateMock,
}));

vi.mock("./backup-verify.js", () => ({
  backupVerifyCommand: backupVerifyCommandMock,
}));

const { backupCreateCommand } = await import("./backup.js");

describe("backupCreateCommand atomic archive write", () => {
  let tempHome: TempHomeEnv;

  beforeEach(async () => {
    tempHome = await createTempHomeEnv("openclaw-backup-atomic-test-");
    tarCreateMock.mockReset();
    backupVerifyCommandMock.mockReset();
  });

  afterEach(async () => {
    await tempHome.restore();
  });

  it("does not leave a partial final archive behind when tar creation fails", async () => {
    const stateDir = path.join(tempHome.home, ".openclaw");
    const archiveDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-backup-failure-"));
    try {
      await fs.writeFile(path.join(stateDir, "openclaw.json"), JSON.stringify({}), "utf8");
      await fs.writeFile(path.join(stateDir, "state.txt"), "state\n", "utf8");

      tarCreateMock.mockRejectedValueOnce(new Error("disk full"));

      const runtime = {
        log: vi.fn(),
        error: vi.fn(),
        exit: vi.fn(),
      };
      const outputPath = path.join(archiveDir, "backup.tar.gz");

      await expect(
        backupCreateCommand(runtime, {
          output: outputPath,
        }),
      ).rejects.toThrow(/disk full/i);

      await expect(fs.access(outputPath)).rejects.toThrow();
      const remaining = await fs.readdir(archiveDir);
      expect(remaining).toEqual([]);
    } finally {
      await fs.rm(archiveDir, { recursive: true, force: true });
    }
  });
});
