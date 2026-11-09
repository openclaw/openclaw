import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, assert, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { copyProvisionedPaths } from "./provisioned-copy.js";

const { copiedOptions } = vi.hoisted(() => ({ copiedOptions: vi.fn() }));
// Observe policy at the safe-copy boundary without replacing filesystem behavior.
vi.mock("../../infra/fs-safe.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../infra/fs-safe.js")>();
  return {
    ...actual,
    root: async (...args: Parameters<typeof actual.root>) => {
      const root = await actual.root(...args);
      const copyIn = root.copyIn.bind(root);
      root.copyIn = async (...copyArgs: Parameters<typeof copyIn>) => {
        await copiedOptions(copyArgs[2]);
        return copyIn(...copyArgs);
      };
      return root;
    },
  };
});
beforeEach(() => copiedOptions.mockReset());
afterEach(() => vi.restoreAllMocks());
const directories = useAutoCleanupTempDirTracker(afterEach);

function fixture(destinationParent?: string) {
  return {
    source: directories.make("provisioned-copy-source-"),
    destination: directories.make("provisioned-copy-dest-", destinationParent),
  };
}

it.for(["authority", "copy", "cross-filesystem", "revoked", "aborted"])(
  "attributes %s while preserving copy, skip and authority contracts",
  async (blocked, context) => {
    const crossFilesystem = blocked === "cross-filesystem";
    if (crossFilesystem) {
      try {
        await fs.access("/dev/shm", fsConstants.W_OK);
        if (
          process.platform !== "linux" ||
          os.tmpdir() === "/dev/shm" ||
          (await fs.stat(os.tmpdir())).dev === (await fs.stat("/dev/shm")).dev
        ) {
          context.skip();
        }
      } catch {
        context.skip();
      }
    }
    let clock = 0;
    vi.spyOn(performance, "now").mockImplementation(() => clock);
    copiedOptions.mockImplementation(async () => {
      clock += blocked === "copy" ? 80 : 0;
    });
    const diagnostics: Record<string, number> = {};
    const controller = new AbortController();
    const failure = new Error("copy no longer authorized");
    if (blocked === "aborted") {
      controller.abort(failure);
    }
    const assertCurrent = () => {
      if (blocked === "revoked") {
        clock += 80;
        throw failure;
      }
      clock += blocked === "authority" ? 80 : 0;
    };
    const { source, destination } = fixture(crossFilesystem ? "/dev/shm" : undefined);
    const sourceFile = path.join(source, "file");
    const content = "*".repeat(64 * 1024);
    await fs.writeFile(sourceFile, content, { mode: 0o640 });
    if (crossFilesystem) {
      await expect(
        fs.copyFile(
          sourceFile,
          path.join(destination, "clone-probe"),
          fsConstants.COPYFILE_FICLONE_FORCE,
        ),
      ).rejects.toMatchObject({ code: "EXDEV" });
    }
    const modified = new Date("2020-01-02T03:04:05Z");
    await fs.utimes(sourceFile, modified, modified);
    await fs.link(sourceFile, path.join(source, "hardlink"));
    await fs.symlink("file", path.join(source, "symlink"));
    await fs.writeFile(path.join(source, "existing"), "not copied");
    await fs.writeFile(path.join(destination, "existing"), "user owned");
    await fs.mkdir(path.join(source, "nested"));
    await fs.writeFile(path.join(source, "nested", "file"), "not followed");
    await fs.symlink(source, path.join(destination, "nested"), "dir");

    const candidates = ["file", "hardlink", "symlink", "existing", "nested/file", "../escape"];
    const pending = copyProvisionedPaths(source, destination, candidates, {
      diagnostics,
      assertCurrent,
      signal: controller.signal,
    });
    if (blocked === "revoked" || blocked === "aborted") {
      await expect(pending).rejects.toThrow(failure);
      expect(diagnostics).toHaveProperty("authorityWaitMs", blocked === "revoked" ? 80 : 0);
      await expect(fs.lstat(path.join(destination, "file"))).rejects.toMatchObject({
        code: "ENOENT",
      });
      return;
    }
    await expect(pending).resolves.toEqual(["file", "hardlink"]);
    expect(diagnostics).toMatchObject({
      attemptedFiles: 2,
      copiedFiles: 2,
      sourceBytes: 128 * 1024,
      preflightMs: 0,
    });
    assert.isDefined(diagnostics.authorityWaitMs);
    expect(diagnostics.authorityWaitMs).toEqual(blocked === "authority" ? expect.any(Number) : 0);
    expect(diagnostics.copyAwaitMs).toBe(
      blocked === "authority" ? diagnostics.authorityWaitMs - 160 : blocked === "copy" ? 160 : 0,
    );
    expect(copiedOptions.mock.calls[0]?.[0]).toMatchObject({
      clone: "auto",
      overwrite: false,
      preserveSourceMode: true,
      preserveMetadata: true,
      sourceHardlinks: "allow",
      mutationSymlinks: "reject",
      durable: false,
    });
    const copied = path.join(destination, "file");
    const [before, after] = await Promise.all([fs.stat(sourceFile), fs.stat(copied)]);
    expect(after.ino).not.toBe(before.ino);
    expect(after.mode & 0o777).toBe(before.mode & 0o777);
    expect(after.mtimeMs).toBe(before.mtimeMs);
    expect(await fs.readFile(copied, "utf8")).toBe(content);
    await fs.writeFile(copied, "destination only");
    expect(await fs.readFile(sourceFile, "utf8")).toBe(content);
    expect(await fs.readFile(path.join(destination, "existing"), "utf8")).toBe("user owned");
  },
);
