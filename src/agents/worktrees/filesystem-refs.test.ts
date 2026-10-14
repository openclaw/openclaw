import fs from "node:fs/promises";
import path from "node:path";
import { root as fsRoot, type Root } from "@openclaw/fs-safe/root";
import { afterEach, assert, describe, expect, it, vi } from "vitest";
import { getRefsFullClusterLcns } from "../../../test/helpers/refs.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { extractErrorCode } from "../../infra/errors.js";
import { detectWorktreeFilesystemBackend } from "./filesystem-backend.js";

const refsRoot = process.env.OPENCLAW_TEST_REFS_ROOT;
const options = { commitGuard: () => {} };

describe.skipIf(process.platform !== "win32")("ReFS worktree filesystem", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);
  afterEach(() => vi.restoreAllMocks());

  it("keeps the Windows system volume on native Git checkout", async () => {
    const systemRoot = Object.entries(process.env).find(
      ([key]) => key.toLowerCase() === "systemroot",
    )?.[1];
    assert(systemRoot);
    expect(await detectWorktreeFilesystemBackend(systemRoot, options)).toBeNull();
  });

  describe.skipIf(!refsRoot)("native ReFS (requires OPENCLAW_TEST_REFS_ROOT)", () => {
    it("clones fresh bytes and physical extents with independent writes and exclusive destinations", async () => {
      const root = tempDirs.make("openclaw-refs-clone-", refsRoot);
      const source = path.join(root, "source");
      const destination = path.join(root, "destination");
      const backend = await detectWorktreeFilesystemBackend(root, options);
      assert(backend);
      expect(backend.id).toBe("refs");
      await backend.createTemplate(source, options);
      await fs.mkdir(path.join(source, "nested"));
      const contents = new Map([
        ["empty", Buffer.alloc(0)],
        ["short", Buffer.from("fresh data")],
        ["日本語-🦀", Buffer.alloc(4097, 0x37)],
        ["partial-tail", Buffer.alloc(4 * 1024 * 1024 + 1, 0x37)],
        [path.join("nested", ".payload"), Buffer.alloc(1024 * 1024, 0x5a)],
      ]);
      const atime = new Date("2001-02-03T04:05:06.000Z");
      const mtime = new Date("2002-03-04T05:06:07.000Z");
      const sourceBirthtimes = new Map<string, number>();
      for (const [name, bytes] of contents) {
        await fs.writeFile(path.join(source, name), bytes);
        await fs.utimes(path.join(source, name), atime, mtime);
        sourceBirthtimes.set(name, (await fs.stat(path.join(source, name))).birthtimeMs);
      }
      await backend.cloneTemplate(source, destination, options);
      for (const [name, bytes] of contents) {
        const copied = await fs.stat(path.join(destination, name));
        expect(copied.atimeMs).toBe(atime.getTime());
        expect(copied.mtimeMs).toBe(mtime.getTime());
        expect(copied.birthtimeMs).toBe(sourceBirthtimes.get(name));
        expect(await fs.readFile(path.join(destination, name))).toEqual(bytes);
        expect(copied.size).toBe(bytes.length);
        expect(getRefsFullClusterLcns(path.join(destination, name))).toEqual(
          getRefsFullClusterLcns(path.join(source, name)),
        );
      }
      const original = path.join(source, "nested", ".payload");
      const cloned = path.join(destination, "nested", ".payload");
      const extents = getRefsFullClusterLcns(original);
      expect(extents.some((lcn) => lcn >= 0n)).toBe(true);
      expect(getRefsFullClusterLcns(cloned)).toEqual(extents);
      expect((await fs.stat(cloned, { bigint: true })).ino).not.toBe(
        (await fs.stat(original, { bigint: true })).ino,
      );
      const handle = await fs.open(cloned, "r+");
      try {
        await handle.write(Buffer.from([0x11]), 0, 1, 0);
        await handle.sync();
      } finally {
        await handle.close();
      }
      expect(await fs.readFile(original)).toEqual(contents.get(path.join("nested", ".payload")));
      expect((await fs.readFile(cloned))[0]).toBe(0x11);
      expect(getRefsFullClusterLcns(cloned)).not.toEqual(getRefsFullClusterLcns(original));
      await expect(backend.cloneTemplate(source, destination, options)).rejects.toThrow();
      expect((await fs.readFile(cloned))[0]).toBe(0x11);
    });

    it("preserves literal and dangling file and directory symlinks", async (context) => {
      const root = tempDirs.make("openclaw-refs-symlink-", refsRoot);
      const source = path.join(root, "source");
      const destination = path.join(root, "destination");
      const backend = await detectWorktreeFilesystemBackend(root, options);
      assert(backend);
      await backend.createTemplate(source, options);
      await fs.writeFile(path.join(source, "payload"), "data");
      const links = [
        ["link", "payload", "file"],
        ["dangling-file", "missing-file", "file"],
        ["dangling-directory", "missing-directory", "dir"],
      ] as const;
      try {
        for (const [name, target, type] of links) {
          await fs.symlink(target, path.join(source, name), type);
        }
      } catch (error) {
        if (extractErrorCode(error) === "EPERM") {
          context.skip("Windows symlink creation requires Developer Mode or privilege");
        }
        throw error;
      }
      await backend.cloneTemplate(source, destination, options);
      for (const [name, target] of links) {
        expect(await fs.readlink(path.join(destination, name))).toBe(target);
      }
      await fs.writeFile(path.join(destination, "payload"), "cloned edit");
      expect(await fs.readFile(path.join(destination, "link"), "utf8")).toBe("cloned edit");
      expect(await fs.readFile(path.join(source, "payload"), "utf8")).toBe("data");
      await fs.writeFile(path.join(destination, "missing-file"), "new file");
      await fs.mkdir(path.join(destination, "missing-directory"));
      expect(await fs.readFile(path.join(destination, "dangling-file"), "utf8")).toBe("new file");
      expect((await fs.stat(path.join(destination, "dangling-directory"))).isDirectory()).toBe(
        true,
      );
    });

    it("stops before the next file when allocation authority is revoked", async () => {
      const root = tempDirs.make("openclaw-refs-cancellation-", refsRoot);
      const source = path.join(root, "source");
      const destination = path.join(root, "destination");
      const backend = await detectWorktreeFilesystemBackend(root, options);
      assert(backend);
      await backend.createTemplate(source, options);
      await fs.writeFile(path.join(source, "a"), "first");
      await fs.writeFile(path.join(source, "b"), "second");
      const prototype = Object.getPrototypeOf(await fsRoot(source)) as Root;
      // oxlint-disable-next-line typescript/unbound-method -- Replayed with the intercepted Root receiver.
      const copyIn = prototype.copyIn;
      let authorized = true;
      vi.spyOn(prototype, "copyIn").mockImplementation(async function (this: Root, ...args) {
        await copyIn.apply(this, args);
        authorized = false;
      });
      await expect(
        backend.cloneTemplate(source, destination, {
          commitGuard: () => {
            if (!authorized) {
              throw new Error("allocation lease lost");
            }
          },
        }),
      ).rejects.toThrow("allocation lease lost");
      expect(await fs.readdir(destination)).toHaveLength(1);
      expect(await fs.readdir(source)).toHaveLength(2);
    });
  });
});
