import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, assert, describe, expect, it, vi } from "vitest";
import { getApfsCloneId } from "../../../test/helpers/apfs.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { detectWorktreeFilesystemBackend } from "./filesystem-backend.js";
import { nativeWorktreeFilesystem } from "./filesystem-native.js";

describe.skipIf(process.platform !== "darwin")("APFS worktree filesystem", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);
  const options = { commitGuard: () => {} };
  afterEach(() => vi.restoreAllMocks());

  it("distinguishes empty, inheritable and unreadable directory ACLs", async () => {
    const root = tempDirs.make("openclaw-apfs-acl-");
    const { apfsFilesystem } = await import("./filesystem-apfs.native.js");
    expect(apfsFilesystem.readDirectoryAcl(root)).toBe("none");
    expect(apfsFilesystem.readDirectoryAcl(path.join(root, "missing"))).toBeUndefined();
    const cases = [
      ["everyone allow read", "non-inheritable"],
      ["everyone allow read,file_inherit", "inheritable"],
      ["everyone allow read,directory_inherit", "inheritable"],
    ] as const;
    for (const [entry, expected] of cases) {
      await promisify(execFile)("/bin/chmod", ["-N", root]);
      await promisify(execFile)("/bin/chmod", ["+a", entry, root]);
      expect(apfsFilesystem.readDirectoryAcl(root)).toBe(expected);
    }
  });

  it("shares file data while preserving modes, dotfiles, and literal symlinks", async () => {
    const root = tempDirs.make("openclaw-apfs-clone-");
    const source = path.join(root, "source");
    const destination = path.join(root, "destination");
    const backend = await detectWorktreeFilesystemBackend(root, options);
    assert(backend);
    expect(backend.id).toBe("apfs");
    await backend.createTemplate(source, options);
    expect((await fs.stat(source)).mode & 0o777).toBe(0o777 & ~process.umask());
    await fs.mkdir(path.join(source, "nested"));
    await fs.writeFile(path.join(source, "nested", ".payload"), Buffer.alloc(1024 * 1024, 0x5a));
    await fs.chmod(path.join(source, "nested", ".payload"), 0o751);
    await fs.chmod(path.join(source, "nested"), 0o750);
    await fs.symlink("nested/.payload", path.join(source, "link"));

    await backend.cloneTemplate(source, destination, options);
    const original = path.join(source, "nested", ".payload");
    const cloned = path.join(destination, "nested", ".payload");
    expect(getApfsCloneId(cloned)).toBe(getApfsCloneId(original));
    expect((await fs.stat(cloned)).ino).not.toBe((await fs.stat(original)).ino);
    expect((await fs.stat(cloned)).mode & 0o777).toBe(0o751);
    expect((await fs.stat(path.join(destination, "nested"))).mode & 0o777).toBe(0o750);
    expect(await fs.readlink(path.join(destination, "link"))).toBe("nested/.payload");
    const [metadata] = await nativeWorktreeFilesystem.readMetadata([cloned], options);
    assert(metadata);
    const stat = await fs.lstat(cloned, { bigint: true });
    expect(metadata.ino).toBe(stat.ino);
    expect(metadata.size).toBe(stat.size);
    expect(BigInt(metadata.mtimeSec) * 1_000_000_000n + BigInt(metadata.mtimeNs)).toBe(
      stat.mtimeNs,
    );
    expect(BigInt(metadata.ctimeSec) * 1_000_000_000n + BigInt(metadata.ctimeNs)).toBe(
      stat.ctimeNs,
    );
    expect([metadata.dev, metadata.mode, metadata.uid, metadata.gid]).toEqual(
      [stat.dev, stat.mode, stat.uid, stat.gid].map(Number),
    );
    expect(metadata.cloneId).toBe(getApfsCloneId(cloned));
    await fs.writeFile(cloned, "independent edit");
    expect(await fs.readFile(original)).toEqual(Buffer.alloc(1024 * 1024, 0x5a));
    expect(getApfsCloneId(cloned)).not.toBe(getApfsCloneId(original));

    await expect(backend.cloneTemplate(source, destination, options)).rejects.toMatchObject({
      code: "EEXIST",
    });
    await expect(backend.createTemplate(destination, options)).rejects.toMatchObject({
      code: "EEXIST",
    });
    expect(await fs.readFile(cloned, "utf8")).toBe("independent edit");
  });

  it("does not select APFS for another filesystem", async () => {
    const root = tempDirs.make("openclaw-apfs-detection-");
    vi.spyOn(nativeWorktreeFilesystem, "probe").mockResolvedValue(undefined);
    expect(await detectWorktreeFilesystemBackend(root, options)).toBeNull();
  });

  it.each(["abort", "authority"])(
    "joins an admitted clone before reporting %s loss",
    async (reason) => {
      const root = tempDirs.make("openclaw-apfs-cancellation-");
      const source = path.join(root, "source");
      const destination = path.join(root, "destination");
      const backend = await detectWorktreeFilesystemBackend(root, options);
      assert(backend);
      await backend.createTemplate(source, options);
      await fs.writeFile(path.join(source, "a"), "first");
      await fs.writeFile(path.join(source, "b"), "second");
      const copy = nativeWorktreeFilesystem.copy;
      let authorized = true;
      let finished = false;
      const abort = new AbortController();
      vi.spyOn(nativeWorktreeFilesystem, "copy").mockImplementation(async (from, to) => {
        // Model an admitted bulk operation that can no longer be interrupted.
        const pending = copy(from, to, { commitGuard: () => {} });
        authorized = false;
        if (reason === "abort") {
          abort.abort(new Error("allocation canceled"));
        }
        await pending;
        finished = true;
      });

      await expect(
        backend.cloneTemplate(source, destination, {
          signal: abort.signal,
          commitGuard: () => {
            if (!authorized) {
              throw new Error("allocation lease lost");
            }
          },
        }),
      ).rejects.toThrow(reason === "abort" ? "allocation canceled" : "allocation lease lost");
      expect(finished).toBe(true);
      expect(await fs.readdir(destination)).toHaveLength(2);
      expect(await fs.readdir(source)).toHaveLength(2);
    },
  );

  it("does not dispatch a clone after authority is revoked during ACL inspection", async () => {
    const root = tempDirs.make("openclaw-apfs-authority-");
    const source = path.join(root, "source");
    const destination = path.join(root, "destination");
    const backend = await detectWorktreeFilesystemBackend(root, options);
    assert(backend);
    await backend.createTemplate(source, options);
    const { apfsFilesystem } = await import("./filesystem-apfs.native.js");
    const readAcl = apfsFilesystem.readDirectoryAcl;
    let authorized = true;
    vi.spyOn(apfsFilesystem, "readDirectoryAcl").mockImplementationOnce((directory) => {
      authorized = false;
      return readAcl(directory);
    });
    await expect(
      backend.cloneTemplate(source, destination, {
        commitGuard() {
          if (!authorized) {
            throw new Error("allocation lease lost");
          }
        },
      }),
    ).rejects.toThrow("allocation lease lost");
    await expect(fs.access(destination)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
