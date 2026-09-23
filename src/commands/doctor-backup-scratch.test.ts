import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createBackupScratchDirectory, finishBackupScratch } from "../infra/backup-scratch.js";
import * as fsSafe from "../infra/fs-safe.js";
import { noteBackupScratchHealth } from "./doctor-backup-scratch.js";

const mocks = vi.hoisted(() => ({ note: vi.fn(), directories: vi.fn<() => string[]>() }));
vi.mock("../../packages/terminal-core/src/note.js", () => ({ note: mocks.note }));
vi.mock("../state/backup-run-records.js", () => ({
  readBackupArchiveDirectories: mocks.directories,
}));
const dirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());

it("reports without mutation and fixes abandoned scratch at recorded archive locations", async () => {
  const root = dirs.make("doctor-backup-scratch-");
  const fallback = path.join(root, "archive-parent");
  await fs.mkdir(fallback);
  vi.spyOn(os, "tmpdir").mockReturnValue(root);
  mocks.directories.mockReturnValue([fallback]);
  const stale = await createBackupScratchDirectory(fallback);
  const live = await createBackupScratchDirectory(root);
  stale.release();
  const token = path.join(stale.directory, "owner.sqlite");
  const before = await fs.stat(token);
  try {
    await noteBackupScratchHealth({}, false);
    expect((await fs.stat(token)).mtimeMs).toBe(before.mtimeMs);
    expect(mocks.note).toHaveBeenCalledWith(
      expect.stringContaining(stale.directory),
      "Backup scratch",
    );
    mocks.note.mockClear();
    const reclaimed = path.join(root, "openclaw-backup-retired-Gone01");
    await fs.mkdir(reclaimed);
    const createRoot = fsSafe.root;
    vi.spyOn(fsSafe, "root").mockImplementation(async (...args) => {
      if (args[0] === reclaimed) {
        await fs.rmdir(reclaimed);
      }
      return createRoot(...args);
    });
    await noteBackupScratchHealth({}, true);
    await expect(fs.stat(stale.directory)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.stat(live.directory)).resolves.toBeDefined();
    expect(mocks.note).toHaveBeenCalledWith(
      expect.stringContaining(`Removed abandoned backup scratch: ${stale.directory}`),
      "Backup scratch",
    );
    expect(mocks.note).toHaveBeenCalledWith(
      expect.stringContaining(`Kept active backup scratch: ${live.directory}`),
      "Backup scratch",
    );
    expect(mocks.note).toHaveBeenCalledWith(
      expect.stringContaining(`Backup scratch already reclaimed: ${reclaimed}`),
      "Backup scratch",
    );
  } finally {
    await finishBackupScratch(live);
  }
});
