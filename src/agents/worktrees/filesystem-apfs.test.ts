import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { assert, describe, expect, it, vi } from "vitest";
import { getApfsCloneId } from "../../../test/helpers/apfs.js";
import {
  cloneOptions as options,
  revocableAuthority,
  useCloneFixture,
} from "./filesystem-clone.test-support.js";
import { nativeWorktreeFilesystem as filesystem } from "./filesystem-native.js";

describe.skipIf(process.platform !== "darwin")("APFS worktree filesystem", () => {
  const { create: template, makeRoot } = useCloneFixture("apfs");

  it("distinguishes empty, inheritable and unreadable directory ACLs", async () => {
    const root = makeRoot();
    const { apfsFilesystem } = await import("./filesystem-apfs.native.js");
    const { readDirectoryAcl } = apfsFilesystem;
    expect(await readDirectoryAcl(root, options)).toBe("none");
    expect(await readDirectoryAcl(path.join(root, "missing"), options)).toBeUndefined();
    const cases = [
      ["everyone allow read", "non-inheritable"],
      ["everyone allow read,file_inherit", "inheritable"],
      ["everyone allow read,directory_inherit", "inheritable"],
    ] as const;
    for (const [entry, expected] of cases) {
      await promisify(execFile)("/bin/chmod", ["-N", root]);
      await promisify(execFile)("/bin/chmod", ["+a", entry, root]);
      expect(await readDirectoryAcl(root, options)).toBe(expected);
    }
  });

  it("shares file data while preserving modes, dotfiles, and literal symlinks", async () => {
    const { source, destination, backend, from, to, clone } = await template();
    const original = from("nested/.payload");
    const cloned = to("nested/.payload");
    expect((await fs.stat(source)).mode & 0o777).toBe(0o777 & ~process.umask());
    await fs.mkdir(from("nested"));
    await fs.writeFile(original, Buffer.alloc(1024 * 1024, 0x5a));
    await fs.chmod(original, 0o751);
    await fs.chmod(from("nested"), 0o750);
    await fs.symlink("nested/.payload", from("link"));
    await clone();
    expect(await getApfsCloneId(cloned)).toBe(await getApfsCloneId(original));
    expect((await fs.stat(cloned)).ino).not.toBe((await fs.stat(original)).ino);
    expect((await fs.stat(cloned)).mode & 0o777).toBe(0o751);
    expect((await fs.stat(to("nested"))).mode & 0o777).toBe(0o750);
    expect(await fs.readlink(to("link"))).toBe("nested/.payload");
    const [metadata] = await filesystem.readMetadata([cloned], options);
    assert(metadata);
    const stat = await fs.lstat(cloned, { bigint: true });
    expect(metadata).toMatchObject({ ino: stat.ino, size: stat.size });
    for (const time of ["mtime", "ctime"] as const) {
      expect(BigInt(metadata[`${time}Sec`]) * 1_000_000_000n + BigInt(metadata[`${time}Ns`])).toBe(
        stat[`${time}Ns`],
      );
    }
    for (const key of ["dev", "mode", "uid", "gid"] as const) {
      expect(metadata[key]).toBe(Number(stat[key]));
    }
    expect(metadata.cloneId).toBe(await getApfsCloneId(cloned));
    await fs.writeFile(cloned, "independent edit");
    expect((await fs.readFile(original)).equals(Buffer.alloc(1024 * 1024, 0x5a))).toBe(true);
    expect(await getApfsCloneId(cloned)).not.toBe(await getApfsCloneId(original));

    await expect(clone()).rejects.toMatchObject({ code: "EEXIST" });
    await expect(backend.createTemplate(destination, options)).rejects.toMatchObject({
      code: "EEXIST",
    });
    expect(await fs.readFile(cloned, "utf8")).toBe("independent edit");
  });

  it.each(["abort", "authority"])(
    "joins an admitted clone before reporting %s loss",
    async (reason) => {
      const { source, destination, from, clone } = await template();
      await fs.writeFile(from("a"), "first");
      await fs.writeFile(from("b"), "second");
      const copy = filesystem.copy;
      const authority = revocableAuthority();
      let finished = false;
      const abort = new AbortController();
      vi.spyOn(filesystem, "copy").mockImplementation(async (sourcePath, targetPath) => {
        // Model an admitted bulk operation that can no longer be interrupted.
        const pending = copy(sourcePath, targetPath, { commitGuard: () => {} });
        authority.revoke();
        if (reason === "abort") {
          abort.abort(new Error("allocation canceled"));
        }
        await pending;
        finished = true;
      });

      const guarded = { signal: abort.signal, commitGuard: authority.commitGuard };
      await expect(clone(guarded)).rejects.toThrow(
        reason === "abort" ? "allocation canceled" : "allocation lease lost",
      );
      expect(finished).toBe(true);
      expect(await fs.readdir(destination)).toHaveLength(2);
      expect(await fs.readdir(source)).toHaveLength(2);
    },
  );

  it("does not dispatch a clone after authority is revoked during ACL inspection", async () => {
    const { destination, clone } = await template();
    const { apfsFilesystem } = await import("./filesystem-apfs.native.js");
    const readAcl = apfsFilesystem.readDirectoryAcl;
    const authority = revocableAuthority();
    vi.spyOn(apfsFilesystem, "readDirectoryAcl").mockImplementationOnce((directory, aclOptions) => {
      authority.revoke();
      return readAcl(directory, aclOptions);
    });
    await expect(clone(authority)).rejects.toThrow("allocation lease lost");
    await expect(fs.access(destination)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
