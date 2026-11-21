import fs from "node:fs/promises";
import { root as fsRoot, type Root } from "@openclaw/fs-safe/root";
import { assert, describe, expect, it, vi } from "vitest";
import { getRefsFullClusterLcns } from "../../../test/helpers/refs.js";
import { extractErrorCode } from "../../infra/errors.js";
import { detectWorktreeFilesystemBackend } from "./filesystem-backend.js";
import {
  cloneOptions as options,
  revocableAuthority,
  useCloneFixture,
} from "./filesystem-clone.test-support.js";

const refsRoot = process.env.OPENCLAW_TEST_REFS_ROOT;

describe.skipIf(process.platform !== "win32")("ReFS worktree filesystem", () => {
  const { create: template } = useCloneFixture("refs", refsRoot);

  it("keeps the Windows system volume on native Git checkout", async () => {
    const systemRoot = Object.entries(process.env).find(
      ([key]) => key.toLowerCase() === "systemroot",
    )?.[1];
    assert(systemRoot);
    expect(await detectWorktreeFilesystemBackend(systemRoot, options)).toBeNull();
  });

  describe.skipIf(!refsRoot)("native ReFS (requires OPENCLAW_TEST_REFS_ROOT)", () => {
    it("clones fresh bytes and physical extents with independent writes and exclusive destinations", async () => {
      const { from, to, clone } = await template();
      await fs.mkdir(from("nested"));
      const contents = new Map([
        ["empty", Buffer.alloc(0)],
        ["short", Buffer.from("fresh data")],
        ["日本語-🦀", Buffer.alloc(4097, 0x37)],
        ["partial-tail", Buffer.alloc(4 * 1024 * 1024 + 1, 0x37)],
        ["nested/.payload", Buffer.alloc(1024 * 1024, 0x5a)],
      ]);
      const atime = new Date("2001-02-03T04:05:06.000Z");
      const mtime = new Date("2002-03-04T05:06:07.000Z");
      const sourceBirthtimes = new Map<string, number>();
      for (const [name, bytes] of contents) {
        await fs.writeFile(from(name), bytes);
        await fs.utimes(from(name), atime, mtime);
        sourceBirthtimes.set(name, (await fs.stat(from(name))).birthtimeMs);
      }
      await clone();
      for (const [name, bytes] of contents) {
        const copied = await fs.stat(to(name));
        expect(copied).toMatchObject({
          atimeMs: atime.getTime(),
          mtimeMs: mtime.getTime(),
          birthtimeMs: sourceBirthtimes.get(name),
          size: bytes.length,
        });
        expect(await fs.readFile(to(name))).toEqual(bytes);
        expect(getRefsFullClusterLcns(to(name))).toEqual(getRefsFullClusterLcns(from(name)));
      }
      const original = from("nested/.payload");
      const cloned = to("nested/.payload");
      const extents = getRefsFullClusterLcns(original);
      expect(extents.some((lcn) => lcn >= 0n)).toBe(true);
      expect((await fs.stat(cloned, { bigint: true })).ino).not.toBe(
        (await fs.stat(original, { bigint: true })).ino,
      );
      await fs.writeFile(cloned, Buffer.from([0x11]), { flag: "r+", flush: true });
      expect(await fs.readFile(original)).toEqual(contents.get("nested/.payload"));
      expect((await fs.readFile(cloned))[0]).toBe(0x11);
      expect(getRefsFullClusterLcns(cloned)).not.toEqual(getRefsFullClusterLcns(original));
      await expect(clone()).rejects.toThrow();
      expect((await fs.readFile(cloned))[0]).toBe(0x11);
    });

    it("preserves literal and dangling file and directory symlinks", async (context) => {
      const { from, to, clone } = await template();
      await fs.writeFile(from("payload"), "data");
      const links = [
        ["link", "payload", "file"],
        ["dangling-file", "missing-file", "file"],
        ["dangling-directory", "missing-directory", "dir"],
      ] as const;
      try {
        for (const [name, target, type] of links) {
          await fs.symlink(target, from(name), type);
        }
      } catch (error) {
        if (extractErrorCode(error) === "EPERM") {
          context.skip("Windows symlink creation requires Developer Mode or privilege");
        }
        throw error;
      }
      await clone();
      for (const [name, target] of links) {
        expect(await fs.readlink(to(name))).toBe(target);
      }
      await fs.writeFile(to("payload"), "cloned edit");
      expect(await fs.readFile(to("link"), "utf8")).toBe("cloned edit");
      expect(await fs.readFile(from("payload"), "utf8")).toBe("data");
      await fs.writeFile(to("missing-file"), "new file");
      await fs.mkdir(to("missing-directory"));
      expect(await fs.readFile(to("dangling-file"), "utf8")).toBe("new file");
      expect((await fs.stat(to("dangling-directory"))).isDirectory()).toBe(true);
    });

    it("stops before the next file when allocation authority is revoked", async () => {
      const { source, destination, from, clone } = await template();
      await fs.writeFile(from("a"), "first");
      await fs.writeFile(from("b"), "second");
      const prototype = Object.getPrototypeOf(await fsRoot(source)) as Root;
      // oxlint-disable-next-line typescript/unbound-method -- Replayed with the intercepted Root receiver.
      const copyIn = prototype.copyIn;
      const authority = revocableAuthority();
      vi.spyOn(prototype, "copyIn").mockImplementation(async function (this: Root, ...args) {
        await copyIn.apply(this, args);
        authority.revoke();
      });
      await expect(clone(authority)).rejects.toThrow("allocation lease lost");
      expect(await fs.readdir(destination)).toHaveLength(1);
      expect(await fs.readdir(source)).toHaveLength(2);
    });
  });
});
