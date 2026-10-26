import fs from "node:fs/promises";
import path from "node:path";
import { __setFsSafeTestHooksForTest } from "@openclaw/fs-safe/test-hooks";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { copyMemoryMigrationFileItem } from "./migration-runtime.js";
import { createMigrationItem } from "./migration.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => __setFsSafeTestHooksForTest(undefined));
async function substituteDirectory(file: string) {
  await fs.rename(file, `${file}.retained`);
  await fs.mkdir(file);
  await fs.writeFile(path.join(file, "nested.md"), "user directory");
}

it.each(["destination", "staged"] as const)(
  "preserves a %s directory substitution",
  async (stage) => {
    const root = tempDirs.make("openclaw-memory-move-race-");
    const workspaceDir = path.join(root, "workspace");
    const source = path.join(root, "MEMORY.md");
    const target = path.join(workspaceDir, "MEMORY.md");
    await fs.mkdir(workspaceDir);
    await fs.writeFile(source, "new memory");
    await fs.writeFile(target, "old memory");
    let stagedPath = "";
    let swapped = false;
    let movedDirectory = false;
    __setFsSafeTestHooksForTest({
      afterRootReadFinalPathIdentityCheck: (filePath) => {
        if (stage === "staged" && stagedPath && filePath === stagedPath) {
          throw new Error("injected staged memory read failure");
        }
      },
      beforeRootFallbackMutation: async (operation, destination) => {
        if (operation !== "move") {
          return;
        }
        if (!stagedPath) {
          stagedPath = destination;
          if (stage === "destination") {
            await substituteDirectory(target);
          }
        } else if (stage === "destination") {
          movedDirectory = (await fs.lstat(stagedPath)).isDirectory();
        } else if (destination === target) {
          swapped = true;
          await substituteDirectory(stagedPath);
        }
      },
    });
    const result = await copyMemoryMigrationFileItem(
      createMigrationItem({ id: "memory", kind: "memory", action: "copy", source, target }),
      path.join(root, "report"),
      { workspaceDir, overwrite: true },
    );
    expect(stagedPath).not.toBe("");
    expect(result.status).toBe("error");
    if (stage === "staged") {
      expect(swapped).toBe(true);
      expect(result.details?.recoveryPath).toBe(stagedPath);
    } else {
      expect(movedDirectory).toBe(false);
    }
    const retained = stage === "staged" ? stagedPath : target;
    await expect(fs.access(stage === "staged" ? target : stagedPath)).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(fs.readFile(path.join(retained, "nested.md"), "utf8")).resolves.toBe(
      "user directory",
    );
    await expect(fs.readFile(`${retained}.retained`, "utf8")).resolves.toBe("old memory");
  },
);
