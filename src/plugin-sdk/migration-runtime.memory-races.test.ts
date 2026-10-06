import fs from "node:fs/promises";
import path from "node:path";
import { __setFsSafeTestHooksForTest } from "@openclaw/fs-safe/test-hooks";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { copyMemoryMigrationFileItem } from "./migration-runtime.js";
import { createMigrationItem } from "./migration.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => __setFsSafeTestHooksForTest(undefined));

async function fixture() {
  const root = tempDirs.make("openclaw-memory-move-race-");
  const workspaceDir = path.join(root, "workspace");
  const source = path.join(root, "MEMORY.md");
  const target = path.join(workspaceDir, "MEMORY.md");
  await fs.mkdir(workspaceDir);
  await fs.writeFile(source, "new memory");
  await fs.writeFile(target, "old memory");
  return {
    target,
    apply: () =>
      copyMemoryMigrationFileItem(
        createMigrationItem({ id: "memory", kind: "memory", action: "copy", source, target }),
        path.join(root, "report"),
        { workspaceDir, overwrite: true },
      ),
  };
}

describe("memory migration file-only moves", () => {
  it("does not stage a destination replaced by a directory after backup", async () => {
    const { target, apply } = await fixture();
    let stagedPath = "";
    let movedDirectory = false;
    __setFsSafeTestHooksForTest({
      beforeRootFallbackMutation: async (operation, destination) => {
        if (operation !== "move") {
          return;
        }
        if (!stagedPath) {
          stagedPath = destination;
          await fs.rename(target, `${target}.retained`);
          await fs.mkdir(target);
          await fs.writeFile(path.join(target, "nested.md"), "user directory");
        } else {
          movedDirectory = (await fs.lstat(stagedPath)).isDirectory();
        }
      },
    });

    const result = await apply();

    expect(stagedPath).not.toBe("");
    expect(result.status).toBe("error");
    expect(movedDirectory).toBe(false);
    await expect(fs.readFile(path.join(target, "nested.md"), "utf8")).resolves.toBe(
      "user directory",
    );
    await expect(fs.readFile(`${target}.retained`, "utf8")).resolves.toBe("old memory");
    await expect(fs.access(stagedPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("retains a staged directory substitution for recovery instead of restoring it", async () => {
    const { target, apply } = await fixture();
    let stagedPath = "";
    let swapped = false;
    __setFsSafeTestHooksForTest({
      afterRootReadFinalPathIdentityCheck: (filePath) => {
        if (stagedPath && filePath === stagedPath) {
          throw new Error("injected staged memory read failure");
        }
      },
      beforeRootFallbackMutation: async (operation, destination) => {
        if (operation !== "move") {
          return;
        }
        if (!stagedPath) {
          stagedPath = destination;
        } else if (destination === target) {
          swapped = true;
          await fs.rename(stagedPath, `${stagedPath}.retained`);
          await fs.mkdir(stagedPath);
          await fs.writeFile(path.join(stagedPath, "nested.md"), "user directory");
        }
      },
    });

    const result = await apply();

    expect(swapped).toBe(true);
    expect(result.status).toBe("error");
    expect(result.details?.recoveryPath).toBe(stagedPath);
    await expect(fs.access(target)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.readFile(path.join(stagedPath, "nested.md"), "utf8")).resolves.toBe(
      "user directory",
    );
    await expect(fs.readFile(`${stagedPath}.retained`, "utf8")).resolves.toBe("old memory");
  });
});
