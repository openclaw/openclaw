import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { __setFsSafeTestHooksForTest } from "@openclaw/fs-safe/test-hooks";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { digestClawBytes } from "./digest.js";
import { removeClawWorkspaceFile } from "./lifecycle-delete-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => __setFsSafeTestHooksForTest(undefined));

async function fixture() {
  const workspace = tempDirs.make("openclaw-claw-remove-race-");
  const target = path.join(workspace, "MEMORY.md");
  await fs.writeFile(target, "owned memory");
  const record = {
    workspace,
    path: "MEMORY.md",
    state: "unchanged" as const,
    contentDigest: digestClawBytes(Buffer.from("owned memory")),
  };
  return { target, record };
}

describe("Claw workspace removal file-only moves", () => {
  it("does not stage an owned file replaced by a directory", async () => {
    const { target, record } = await fixture();
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

    const result = await removeClawWorkspaceFile(record, {
      assertCurrentFinal: () => undefined,
    });

    expect(stagedPath).not.toBe("");
    expect(result.action).toBe("error");
    expect(movedDirectory).toBe(false);
    await expect(fs.readFile(path.join(target, "nested.md"), "utf8")).resolves.toBe(
      "user directory",
    );
    await expect(fs.readFile(`${target}.retained`, "utf8")).resolves.toBe("owned memory");
    await expect(fs.access(stagedPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not restore a staged file replaced by a directory", async () => {
    const { target, record } = await fixture();
    await fs.writeFile(target, "changed memory");
    let stagedPath = "";
    let swapped = false;
    __setFsSafeTestHooksForTest({
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

    const result = await removeClawWorkspaceFile(record, {
      assertCurrentFinal: () => undefined,
    });

    expect(swapped).toBe(true);
    expect(result.action).toBe("error");
    expect(result.message).toContain("Could not restore MEMORY.md");
    await expect(fs.access(target)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.readFile(path.join(stagedPath, "nested.md"), "utf8")).resolves.toBe(
      "user directory",
    );
    await expect(fs.readFile(`${stagedPath}.retained`, "utf8")).resolves.toBe("changed memory");
  });

  it("still restores its staged file after removal authority is lost", async () => {
    const { target, record } = await fixture();
    const result = await removeClawWorkspaceFile(record, {
      assertCurrentFinal: () => {
        if (!existsSync(target)) {
          throw new Error("removal authority lost");
        }
      },
    });

    expect(result).toMatchObject({ action: "error", message: "Error: removal authority lost" });
    await expect(fs.readFile(target, "utf8")).resolves.toBe("owned memory");
    await expect(fs.readdir(record.workspace)).resolves.toEqual(["MEMORY.md"]);
  });
});
