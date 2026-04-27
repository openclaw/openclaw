import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { copyMigrationFileItem } from "./migration-runtime.js";
import { createMigrationItem } from "./migration.js";

async function writeFile(filePath: string, contents: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, contents, "utf8");
}

describe("copyMigrationFileItem", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("uses unique backup paths for same-basename targets in the same millisecond", async () => {
    vi.spyOn(Date, "now").mockReturnValue(123);
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-migration-runtime-"));
    const reportDir = path.join(root, "report");
    const sourceOne = path.join(root, "source-one", "AGENTS.md");
    const sourceTwo = path.join(root, "source-two", "AGENTS.md");
    const targetOne = path.join(root, "target-one", "AGENTS.md");
    const targetTwo = path.join(root, "target-two", "AGENTS.md");

    await writeFile(sourceOne, "new one");
    await writeFile(sourceTwo, "new two");
    await writeFile(targetOne, "old one");
    await writeFile(targetTwo, "old two");

    const first = await copyMigrationFileItem(
      createMigrationItem({
        id: "first",
        kind: "file",
        action: "copy",
        source: sourceOne,
        target: targetOne,
      }),
      reportDir,
      { overwrite: true },
    );
    const second = await copyMigrationFileItem(
      createMigrationItem({
        id: "second",
        kind: "file",
        action: "copy",
        source: sourceTwo,
        target: targetTwo,
      }),
      reportDir,
      { overwrite: true },
    );

    expect(first.status).toBe("migrated");
    expect(second.status).toBe("migrated");
    const firstBackup = first.details?.backupPath;
    const secondBackup = second.details?.backupPath;
    expect(firstBackup).toEqual(expect.stringContaining("AGENTS.md"));
    expect(secondBackup).toEqual(expect.stringContaining("AGENTS.md"));
    expect(firstBackup).not.toBe(secondBackup);
    await expect(fs.readFile(firstBackup as string, "utf8")).resolves.toBe("old one");
    await expect(fs.readFile(secondBackup as string, "utf8")).resolves.toBe("old two");
  });
});
