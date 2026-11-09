import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
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
      root.copyIn = (...copyArgs: Parameters<typeof copyIn>) => {
        copiedOptions(copyArgs[2]);
        return copyIn(...copyArgs);
      };
      return root;
    },
  };
});
beforeEach(() => copiedOptions.mockClear());
const directories = useAutoCleanupTempDirTracker(afterEach);

async function fixture(destinationParent?: string) {
  const source = directories.make("provisioned-copy-source-");
  const destination = directories.make("provisioned-copy-dest-", destinationParent);
  return { source, destination };
}

it("copies independent files with metadata while preserving existing paths and rejecting symlinks", async () => {
  const { source, destination } = await fixture();
  const sourceFile = path.join(source, "file");
  await fs.writeFile(sourceFile, "source bytes", { mode: 0o640 });
  const modified = new Date("2020-01-02T03:04:05Z");
  await fs.utimes(sourceFile, modified, modified);
  await fs.link(sourceFile, path.join(source, "hardlink"));
  await fs.symlink("file", path.join(source, "symlink"));
  await fs.writeFile(path.join(source, "existing"), "not copied");
  await fs.writeFile(path.join(destination, "existing"), "user owned");
  await fs.mkdir(path.join(source, "nested"));
  await fs.writeFile(path.join(source, "nested", "file"), "not followed");
  await fs.symlink(source, path.join(destination, "nested"), "dir");

  expect(
    await copyProvisionedPaths(
      source,
      destination,
      ["file", "hardlink", "symlink", "existing", "nested/file", "../escape"],
      {},
    ),
  ).toEqual(["file", "hardlink"]);
  expect(copiedOptions).toHaveBeenCalledWith(
    expect.objectContaining({
      clone: "auto",
      overwrite: false,
      preserveSourceMode: true,
      preserveMetadata: true,
      sourceHardlinks: "allow",
      mutationSymlinks: "reject",
      durable: false,
    }),
  );
  const copied = path.join(destination, "file");
  const [before, after] = await Promise.all([fs.stat(sourceFile), fs.stat(copied)]);
  expect(after.ino).not.toBe(before.ino);
  expect(after.mode & 0o777).toBe(before.mode & 0o777);
  expect(after.mtimeMs).toBe(before.mtimeMs);
  expect(await fs.readFile(copied, "utf8")).toBe("source bytes");
  await fs.writeFile(copied, "destination only");
  expect(await fs.readFile(sourceFile, "utf8")).toBe("source bytes");
  expect(await fs.readFile(path.join(destination, "existing"), "utf8")).toBe("user owned");
});

it.each(["revoked", "aborted"] as const)(
  "does not publish a copy when authority is %s",
  async (kind) => {
    const { source, destination } = await fixture();
    await fs.writeFile(path.join(source, "file"), "source bytes");
    const controller = new AbortController();
    const error = new Error("copy no longer authorized");
    if (kind === "aborted") {
      controller.abort(error);
    }
    await expect(
      copyProvisionedPaths(source, destination, ["file"], {
        signal: controller.signal,
        assertCurrent() {
          if (kind === "revoked") {
            throw error;
          }
        },
      }),
    ).rejects.toThrow(error);
    await expect(fs.lstat(path.join(destination, "file"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  },
);

it("falls back to ordinary copying when cloning across filesystems is unsupported", async (context) => {
  // Linux tmpfs provides a real, deterministic EXDEV boundary without mocking fs-safe.
  if (process.platform !== "linux" || os.tmpdir() === "/dev/shm") {
    context.skip();
    return;
  }
  try {
    await fs.access("/dev/shm", fsConstants.W_OK);
    if ((await fs.stat(os.tmpdir())).dev === (await fs.stat("/dev/shm")).dev) {
      context.skip();
      return;
    }
  } catch {
    context.skip();
    return;
  }
  const { source, destination } = await fixture("/dev/shm");
  const sourceFile = path.join(source, "file");
  await fs.writeFile(sourceFile, Buffer.alloc(64 * 1024, 42), { mode: 0o640 });
  await expect(
    fs.copyFile(
      sourceFile,
      path.join(destination, "clone-probe"),
      fsConstants.COPYFILE_FICLONE_FORCE,
    ),
  ).rejects.toMatchObject({ code: "EXDEV" });
  expect(await copyProvisionedPaths(source, destination, ["file"], {})).toEqual(["file"]);
  const copied = path.join(destination, "file");
  expect(await fs.readFile(copied)).toEqual(await fs.readFile(sourceFile));
  expect((await fs.stat(copied)).mode & 0o777).toBe((await fs.stat(sourceFile)).mode & 0o777);
  await fs.writeFile(copied, "destination only");
  expect((await fs.stat(sourceFile)).size).toBe(64 * 1024);
});
