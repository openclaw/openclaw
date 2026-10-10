import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, assert, describe, expect, it, vi } from "vitest";
import { getRefsFileExtents } from "../../../test/helpers/refs.js";
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
        [path.join("nested", ".payload"), Buffer.alloc(1024 * 1024, 0x5a)],
      ]);
      for (const [name, bytes] of contents) {
        await fs.writeFile(path.join(source, name), bytes);
      }
      await backend.cloneTemplate(source, destination, options);
      for (const [name, bytes] of contents) {
        expect(await fs.readFile(path.join(destination, name))).toEqual(bytes);
      }
      const original = path.join(source, "nested", ".payload");
      const cloned = path.join(destination, "nested", ".payload");
      const extents = getRefsFileExtents(original);
      expect(extents.some((extent) => extent.lcn >= 0n)).toBe(true);
      expect(getRefsFileExtents(cloned)).toEqual(extents);
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
      expect(getRefsFileExtents(cloned)).not.toEqual(getRefsFileExtents(original));
      await expect(backend.cloneTemplate(source, destination, options)).rejects.toThrow();
      expect((await fs.readFile(cloned))[0]).toBe(0x11);
    });

    it("preserves a literal file symlink when Windows permits creating one", async (context) => {
      const root = tempDirs.make("openclaw-refs-symlink-", refsRoot);
      const source = path.join(root, "source");
      const destination = path.join(root, "destination");
      const backend = await detectWorktreeFilesystemBackend(root, options);
      assert(backend);
      await backend.createTemplate(source, options);
      await fs.writeFile(path.join(source, "payload"), "data");
      try {
        await fs.symlink("payload", path.join(source, "link"), "file");
      } catch (error) {
        if (extractErrorCode(error) === "EPERM") {
          context.skip("Windows symlink creation requires Developer Mode or privilege");
        }
        throw error;
      }
      await backend.cloneTemplate(source, destination, options);
      expect(await fs.readlink(path.join(destination, "link"))).toBe("payload");
      await fs.writeFile(path.join(destination, "payload"), "cloned edit");
      expect(await fs.readFile(path.join(destination, "link"), "utf8")).toBe("cloned edit");
      expect(await fs.readFile(path.join(source, "payload"), "utf8")).toBe("data");
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
      const { refsFilesystem } = await import("./filesystem-refs.native.js");
      const clone = refsFilesystem.cloneFile;
      let authorized = true;
      vi.spyOn(refsFilesystem, "cloneFile").mockImplementation((from, to, clusterSize) => {
        clone(from, to, clusterSize);
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
