import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { FsSafeError, root } from "../infra/fs-safe.js";
import { moveClawWorkspaceFileNoReplace } from "./workspace-file-move.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function unavailableNoReplaceMove() {
  return new FsSafeError("helper-unavailable", "native no-replace move is unavailable", {
    cause: Object.assign(new Error("unsupported rename flags"), { code: "EINVAL" }),
  });
}

describe("moveClawWorkspaceFileNoReplace", () => {
  it("moves the exact file through the hardlink fallback", async () => {
    const rootDir = tempDirs.make("openclaw-claw-file-move-");
    const sourcePath = path.join(rootDir, "source.md");
    const targetPath = path.join(rootDir, "target.md");
    fs.writeFileSync(sourcePath, "owned\n");
    const workspace = await root(rootDir, { hardlinks: "reject", symlinks: "reject" });
    vi.spyOn(workspace, "move").mockRejectedValue(unavailableNoReplaceMove());

    await moveClawWorkspaceFileNoReplace(workspace, "source.md", "target.md", () => undefined);

    expect(fs.existsSync(sourcePath)).toBe(false);
    expect(fs.readFileSync(targetPath, "utf8")).toBe("owned\n");
    expect(fs.statSync(targetPath).nlink).toBe(1);
  });

  it("preserves its published copy when authority expires", async () => {
    const rootDir = tempDirs.make("openclaw-claw-file-move-expired-");
    const sourcePath = path.join(rootDir, "source.md");
    const targetPath = path.join(rootDir, "target.md");
    fs.writeFileSync(sourcePath, "owned\n");
    const workspace = await root(rootDir, { hardlinks: "reject", symlinks: "reject" });
    vi.spyOn(workspace, "move").mockRejectedValue(unavailableNoReplaceMove());
    const copyIn = workspace.copyIn.bind(workspace);
    let authorityExpired = false;
    vi.spyOn(workspace, "copyIn").mockImplementation(async (to, source, options) => {
      await copyIn(to, source, {
        ...options,
        onDestinationPublished: (receipt) => {
          options?.onDestinationPublished?.(receipt);
          authorityExpired = true;
        },
      });
    });

    await expect(
      moveClawWorkspaceFileNoReplace(workspace, "source.md", "target.md", () => {
        if (authorityExpired) {
          throw new Error("lease expired");
        }
      }),
    ).rejects.toMatchObject({
      name: "AggregateError",
      errors: expect.arrayContaining([expect.objectContaining({ message: "lease expired" })]),
    });

    expect(fs.readFileSync(sourcePath, "utf8")).toBe("owned\n");
    expect(fs.readFileSync(targetPath, "utf8")).toBe("owned\n");
    expect(fs.statSync(sourcePath).nlink).toBe(1);
  });

  it("preserves a published copy edited in place before source removal", async () => {
    const rootDir = tempDirs.make("openclaw-claw-file-move-edited-");
    const sourcePath = path.join(rootDir, "source.md");
    const targetPath = path.join(rootDir, "target.md");
    fs.writeFileSync(sourcePath, "owned\n");
    const workspace = await root(rootDir, { hardlinks: "reject", symlinks: "reject" });
    vi.spyOn(workspace, "move").mockRejectedValue(unavailableNoReplaceMove());
    const copyIn = workspace.copyIn.bind(workspace);
    vi.spyOn(workspace, "copyIn").mockImplementation(async (to, source, options) => {
      await copyIn(to, source, {
        ...options,
        onDestinationPublished: (receipt) => {
          options?.onDestinationPublished?.(receipt);
          fs.writeFileSync(receipt.path, "operator edit\n");
        },
      });
    });

    await expect(
      moveClawWorkspaceFileNoReplace(workspace, "source.md", "target.md", () => undefined),
    ).rejects.toMatchObject({ name: "AggregateError" });

    expect(fs.readFileSync(sourcePath, "utf8")).toBe("owned\n");
    expect(fs.readFileSync(targetPath, "utf8")).toBe("operator edit\n");
  });

  it("rejects a destination parent replaced before fallback publication", async () => {
    const rootDir = tempDirs.make("openclaw-claw-file-move-parent-race-");
    const outsideDir = tempDirs.make("openclaw-claw-file-move-outside-");
    const targetDir = path.join(rootDir, "target");
    const sourcePath = path.join(rootDir, "source.md");
    fs.mkdirSync(targetDir);
    fs.writeFileSync(sourcePath, "owned\n");
    const workspace = await root(rootDir, { hardlinks: "reject", symlinks: "reject" });
    vi.spyOn(workspace, "move").mockRejectedValue(unavailableNoReplaceMove());
    const copyIn = workspace.copyIn.bind(workspace);
    vi.spyOn(workspace, "copyIn").mockImplementation(async (...args) => {
      fs.rmSync(targetDir, { recursive: true });
      fs.symlinkSync(outsideDir, targetDir, process.platform === "win32" ? "junction" : "dir");
      await copyIn(...args);
    });

    await expect(
      moveClawWorkspaceFileNoReplace(workspace, "source.md", "target/moved.md", () => undefined),
    ).rejects.toThrow();

    expect(fs.readFileSync(sourcePath, "utf8")).toBe("owned\n");
    expect(fs.existsSync(path.join(outsideDir, "moved.md"))).toBe(false);
  });
});
