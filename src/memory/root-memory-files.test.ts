import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { exactWorkspaceEntryExists } from "./root-memory-files.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const canTestPermissions = process.platform !== "win32" && process.getuid?.() !== 0;

describe("exactWorkspaceEntryExists", () => {
  it("distinguishes exact entries, missing entries, and missing path components", async () => {
    const dir = tempDirs.make("root-memory-entries-");
    await fs.writeFile(path.join(dir, "MEMORY.md"), "memory");
    await expect(exactWorkspaceEntryExists(dir, "MEMORY.md")).resolves.toBe(true);
    await expect(exactWorkspaceEntryExists(dir, "memory.md")).resolves.toBe(false);
    await expect(exactWorkspaceEntryExists(path.join(dir, "absent"), "MEMORY.md")).resolves.toBe(
      false,
    );
    await expect(exactWorkspaceEntryExists(path.join(dir, "MEMORY.md"), "MEMORY.md")).resolves.toBe(
      false,
    );
  });

  it.runIf(canTestPermissions)("preserves EACCES from an unreadable directory", async () => {
    const dir = tempDirs.make("root-memory-eacces-");
    await fs.chmod(dir, 0o000);
    try {
      await expect(exactWorkspaceEntryExists(dir, "MEMORY.md")).rejects.toMatchObject({
        code: "EACCES",
      });
    } finally {
      await fs.chmod(dir, 0o700);
    }
  });
});
