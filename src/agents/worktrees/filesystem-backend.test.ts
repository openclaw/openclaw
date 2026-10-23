import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, assert, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { drainGlobalSingletonLifecycleState } from "../../shared/global-singleton.js";
import { detectWorktreeFilesystemBackend } from "./filesystem-backend.js";
import { nativeWorktreeFilesystem } from "./filesystem-native.js";

const { readDirectoryAcl } = vi.hoisted(() => ({
  readDirectoryAcl: vi.fn(() => "none"),
}));
// mock-isolation: isolate ACL policy from the host filesystem.
vi.mock("./filesystem-apfs.native.js", () => ({ apfsFilesystem: { readDirectoryAcl } }));

describe.skipIf(process.platform === "win32")("worktree filesystem backend", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);
  const options = { commitGuard: () => {} };
  afterEach(async () => {
    await drainGlobalSingletonLifecycleState();
    vi.restoreAllMocks();
  });

  it("falls back when native cloning is unavailable", async () => {
    const root = tempDirs.make("openclaw-filesystem-backend-");
    vi.spyOn(nativeWorktreeFilesystem, "probe").mockResolvedValue(undefined);
    await expect(detectWorktreeFilesystemBackend(root, options)).resolves.toBeNull();
  });

  it("admits XFS with room for independently allocated directory and file metadata", async () => {
    const root = tempDirs.make("openclaw-filesystem-backend-");
    vi.spyOn(nativeWorktreeFilesystem, "probe").mockResolvedValue("xfs");
    const backend = await detectWorktreeFilesystemBackend(root, options);
    assert(backend);
    expect(backend.id).toBe("xfs");
    expect(backend.estimateCloneBytes(10, 1024)).toBe(16 * 1024 ** 2 + 2 * 1024 + 10 * 8192);
  });

  it.skipIf(process.platform !== "linux" || !process.env.OPENCLAW_TEST_XFS_ROOT)(
    "clones independent XFS contents, executable modes, and literal symlinks",
    async () => {
      const root = tempDirs.make("openclaw-xfs-clone-", process.env.OPENCLAW_TEST_XFS_ROOT);
      const source = path.join(root, "source");
      const destination = path.join(root, "destination");
      const backend = await detectWorktreeFilesystemBackend(root, options);
      assert(backend);
      expect(backend.id).toBe("xfs");
      await backend.createTemplate(source, options);
      await fs.mkdir(path.join(source, "nested"));
      await fs.writeFile(path.join(source, "nested", "run"), "#!/bin/sh\necho fixture\n", {
        mode: 0o755,
      });
      await fs.writeFile(path.join(source, "payload"), Buffer.alloc(64 * 1024, 0x5a));
      await fs.symlink("nested/run", path.join(source, "link"));
      await fs.symlink("missing", path.join(source, "dangling"));
      await backend.cloneTemplate(source, destination, options);
      expect(await fs.readFile(path.join(destination, "nested", "run"), "utf8")).toBe(
        "#!/bin/sh\necho fixture\n",
      );
      expect((await fs.stat(path.join(destination, "nested", "run"))).mode & 0o777).toBe(0o755);
      expect(await fs.readFile(path.join(destination, "payload"))).toEqual(
        Buffer.alloc(64 * 1024, 0x5a),
      );
      expect(await fs.readlink(path.join(destination, "link"))).toBe("nested/run");
      expect(await fs.readlink(path.join(destination, "dangling"))).toBe("missing");
      await fs.writeFile(path.join(destination, "payload"), "clone edit");
      expect(await fs.readFile(path.join(source, "payload"))).toEqual(
        Buffer.alloc(64 * 1024, 0x5a),
      );
      await expect(backend.cloneTemplate(source, destination, options)).rejects.toThrow();
      expect(await fs.readFile(path.join(destination, "payload"), "utf8")).toBe("clone edit");
    },
  );

  it.each(["abort", "authority"])(
    "does not hide %s loss behind an unavailable filesystem probe",
    async (reason) => {
      const root = tempDirs.make("openclaw-filesystem-backend-");
      const controller = new AbortController();
      let authorized = true;
      vi.spyOn(nativeWorktreeFilesystem, "probe").mockImplementation(async () => {
        authorized = false;
        if (reason === "abort") {
          controller.abort(new Error("allocation canceled"));
        }
        return undefined;
      });
      await expect(
        detectWorktreeFilesystemBackend(root, {
          signal: controller.signal,
          commitGuard() {
            if (!authorized) {
              throw new Error("allocation lease lost");
            }
          },
        }),
      ).rejects.toThrow(reason === "abort" ? "allocation canceled" : "allocation lease lost");
    },
  );
});
