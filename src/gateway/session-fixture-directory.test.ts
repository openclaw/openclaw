import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { removeSessionFixtureDirectory } from "./session-fixture-directory.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());

it("reports leftover paths without reading file contents when removal fails", async () => {
  const dir = tempDirs.make("session-fixture-removal-");
  await fs.mkdir(path.join(dir, "nested"));
  await fs.writeFile(path.join(dir, "nested", "transcript.jsonl"), "private fixture contents");
  const outside = tempDirs.make("session-fixture-sibling-");
  await fs.writeFile(path.join(outside, "unrelated.txt"), "outside the fixture");
  await fs.symlink(outside, path.join(dir, "linked"), "junction");
  const cause = Object.assign(new Error("ENOTEMPTY: directory not empty"), { code: "ENOTEMPTY" });
  vi.spyOn(fs, "rm").mockRejectedValueOnce(cause);

  await expect(removeSessionFixtureDirectory(dir)).rejects.toMatchObject({
    cause,
    message: `Failed to remove session fixture ${JSON.stringify(dir)}: ${String(cause)}; remaining entries: ${JSON.stringify(["linked", "nested", path.join("nested", "transcript.jsonl")])}`,
  });
});

it("preserves the removal error when leftover enumeration also fails", async () => {
  const dir = tempDirs.make("session-fixture-removal-");
  const cause = Object.assign(new Error("EBUSY: resource busy"), { code: "EBUSY" });
  vi.spyOn(fs, "rm").mockRejectedValueOnce(cause);
  vi.spyOn(fs, "readdir").mockRejectedValueOnce(new Error("EACCES: permission denied"));

  await expect(removeSessionFixtureDirectory(dir)).rejects.toMatchObject({
    cause,
    message: expect.stringContaining(
      "remaining entries: unavailable (Error: EACCES: permission denied)",
    ),
  });
});
