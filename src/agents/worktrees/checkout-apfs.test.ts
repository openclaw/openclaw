import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { setImmediate } from "node:timers";
import timers from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { nativeWorktreeFilesystem as filesystem } from "./filesystem-native.js";
import { git, gitIdentity } from "./git-fixture.test-support.js";

const originalTime = 1_600_000_000;
async function writeStamped(directory: string, name: string, contents = "modified\n") {
  const file = path.join(directory, name);
  await fs.writeFile(file, contents);
  await fs.utimes(file, originalTime, originalTime);
}
const status = (cwd: string) => git(cwd, "status", "--porcelain");
const debug = (cwd: string) => git(cwd, "ls-files", "--debug", "clean");

describe.skipIf(process.platform !== "darwin")("APFS checkout index", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    syncBuiltinESMExports();
  });

  async function fixture(algorithm = "sha1", version = 2) {
    vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");
    vi.stubEnv("GIT_CONFIG_GLOBAL", "/dev/null");
    const root = tempDirs.make("openclaw-apfs-index-");
    const source = path.join(root, "source");
    const destination = path.join(root, "destination");
    await git(root, "init", "-q", `--object-format=${algorithm}`, source);
    await git(source, "config", "index.version", String(version));
    for (const name of ["clean", "dirty-destination", "dirty-source", "é space\nname"]) {
      await writeStamped(source, name, "original\n");
    }
    await fs.symlink("clean", path.join(source, "link"));
    await git(source, "add", ".");
    await git(source, ...gitIdentity, "commit", "-qm", "fixture");
    await git(source, "worktree", "add", "--detach", "--no-checkout", destination, "HEAD");
    const marker = await fs.readFile(path.join(destination, ".git"));
    const indexPath = await git(destination, "rev-parse", "--git-path", "index");
    const destinationIndex = path.resolve(destination, indexPath);
    await fs.rm(destination, { recursive: true });
    await filesystem.copy(source, destination, { commitGuard: () => {} });
    const cloneCompletedAtMs = Date.now();
    // This fixture's source owns .git; the managed service clones a linked template.
    await fs.rm(path.join(destination, ".git"), { recursive: true });
    await fs.writeFile(path.join(destination, ".git"), marker);
    const sourceIndex = path.join(source, ".git", "index");
    const { copyApfsCloneIndex: copyIndex } = await import("./checkout-apfs.js");
    const copy = (commitGuard = () => {}) => {
      const options = { commitGuard, cloneCompletedAtMs };
      return copyIndex(source, destination, sourceIndex, destinationIndex, options);
    };
    return { source, destination, sourceIndex, destinationIndex, cloneCompletedAtMs, copy };
  }

  it("does not wait past the clone timestamp boundary", async () => {
    const f = await fixture();
    const deadline = (Math.floor(f.cloneCompletedAtMs / 1_000) + 1) * 1_000;
    await timers.setTimeout(Math.max(0, deadline - Date.now()));
    // Reject an extra delay rather than relying on a machine-speed assertion.
    const schedule = vi
      .spyOn(timers, "setTimeout")
      .mockRejectedValue(new Error("clone timestamp boundary already passed"));
    syncBuiltinESMExports();
    expect(await f.copy()).toBe(true);
    expect(schedule).not.toHaveBeenCalled();
    schedule.mockRestore();
    syncBuiltinESMExports();
    expect(await status(f.destination)).toBe("");
    await writeStamped(f.destination, "clean");
    expect(await status(f.destination)).toBe("M clean");
  });

  it.each(["sha1", "sha256"])(
    "refreshes %s clone identities without hiding existing or later edits",
    async (algorithm) => {
      const f = await fixture(algorithm);
      const sourceIndex = await fs.readFile(f.sourceIndex);
      await writeStamped(f.destination, "dirty-destination");
      await writeStamped(f.source, "dirty-source");
      expect(await f.copy()).toBe(true);
      const debugBefore = await debug(f.destination);
      const stat = await fs.lstat(path.join(f.destination, "clean"), { bigint: true });
      expect(debugBefore).toContain(`ino: ${Number(stat.ino & 0xffffffffn)}`);
      expect(await status(f.destination)).toBe("M dirty-destination");
      expect(await debug(f.destination)).toBe(debugBefore);
      expect(await fs.readFile(f.sourceIndex)).toEqual(sourceIndex);
      expect(await git(f.destination, "diff", "--cached", "--name-only")).toBe("");

      await writeStamped(f.destination, "clean");
      const { mtimeNs } = await fs.stat(path.join(f.destination, "clean"), { bigint: true });
      expect(mtimeNs).toBe(BigInt(originalTime) * 1_000_000_000n);
      expect(await status(f.destination)).toBe("M clean\n M dirty-destination");
    },
  );

  it("leaves unsupported and damaged indexes to the existing Git fallback", async () => {
    const f = await fixture("sha1", 4);
    expect(await f.copy()).toBe(false);
    await git(f.source, "update-index", "--index-version", "2");
    const damaged = await fs.readFile(f.sourceIndex);
    damaged[12] = damaged[12]! ^ 1;
    await fs.writeFile(f.sourceIndex, damaged);
    expect(await f.copy()).toBe(false);
    await expect(fs.access(f.destinationIndex)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each(["immediate", "skipped-entry"])("fences %s authority loss", async (phase) => {
    const f = await fixture();
    let authorized = phase !== "immediate";
    await fs.utimes(f.sourceIndex, originalTime, originalTime);
    const guard = () => {
      if (!authorized) {
        throw new Error("allocation lease lost");
      }
      setImmediate(() => {
        authorized = false;
      });
    };
    await expect(f.copy(guard)).rejects.toThrow("allocation lease lost");
    await expect(fs.access(f.destinationIndex)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each(["source index", "metadata batch"])("validates %s races", async (race) => {
    const f = await fixture();
    const before = await debug(f.source);
    if (race === "source index") {
      await fs.utimes(f.sourceIndex, originalTime, originalTime);
    } else {
      const readMetadata = filesystem.readMetadata;
      const now = vi.spyOn(Date, "now");
      vi.spyOn(filesystem, "readMetadata").mockImplementation(async (files, options) => {
        const file = path.join(f.destination, "clean");
        await fs.chmod(file, (await fs.stat(file)).mode & 0o777);
        const values = await readMetadata(files, options);
        now.mockReturnValue(Date.now() + 2_000);
        return values;
      });
    }
    expect(await f.copy()).toBe(true);
    vi.restoreAllMocks();
    expect(await debug(f.destination)).toBe(before);
    await git(f.destination, "update-index", "--refresh");
    expect(await status(f.destination)).toBe("");
  });
});
