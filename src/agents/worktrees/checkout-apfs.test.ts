import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { setImmediate } from "node:timers";
import timers from "node:timers/promises";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { nativeWorktreeFilesystem } from "./filesystem-native.js";

const exec = promisify(execFile);
const originalTime = 1_600_000_000;
async function git(cwd: string, ...args: string[]) {
  return (await exec("git", ["-C", cwd, ...args])).stdout.trim();
}
async function modify(directory: string, name: string) {
  const file = path.join(directory, name);
  await fs.writeFile(file, "modified\n");
  await fs.utimes(file, originalTime, originalTime);
}
const status = (cwd: string) => git(cwd, "status", "--porcelain");
const debug = (cwd: string) => git(cwd, "ls-files", "--debug", "clean");

describe.skipIf(process.platform !== "darwin")("APFS checkout index", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);
  afterEach(() => vi.unstubAllEnvs());

  async function fixture(algorithm = "sha1", version = 2) {
    vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");
    vi.stubEnv("GIT_CONFIG_GLOBAL", "/dev/null");
    const root = tempDirs.make("openclaw-apfs-index-");
    const source = path.join(root, "source");
    const destination = path.join(root, "destination");
    await fs.mkdir(source);
    await git(source, "init", "-q", `--object-format=${algorithm}`);
    await git(source, "config", "index.version", String(version));
    for (const name of ["clean", "dirty-destination", "dirty-source", "é space\nname"]) {
      await fs.writeFile(path.join(source, name), "original\n");
      await fs.utimes(path.join(source, name), originalTime, originalTime);
    }
    await fs.symlink("clean", path.join(source, "link"));
    await git(source, "add", ".");
    await git(
      source,
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "-qm",
      "fixture",
    );
    await git(
      source,
      "worktree",
      "add",
      "--quiet",
      "--detach",
      "--no-checkout",
      destination,
      "HEAD",
    );
    const marker = await fs.readFile(path.join(destination, ".git"));
    const destinationIndex = path.resolve(
      destination,
      await git(destination, "rev-parse", "--git-path", "index"),
    );
    await fs.rm(destination, { recursive: true });
    await nativeWorktreeFilesystem.copy(source, destination, { commitGuard: () => {} });
    const cloneCompletedAtMs = Date.now();
    // This fixture's source owns .git; the managed service clones a linked template.
    await fs.rm(path.join(destination, ".git"), { recursive: true });
    await fs.writeFile(path.join(destination, ".git"), marker);
    const sourceIndex = path.join(source, ".git", "index");
    const { copyApfsCloneIndex } = await import("./checkout-apfs.js");
    const copy = (commitGuard = () => {}) =>
      copyApfsCloneIndex(source, destination, sourceIndex, destinationIndex, {
        commitGuard,
        cloneCompletedAtMs,
      });
    return { source, destination, sourceIndex, destinationIndex, cloneCompletedAtMs, copy };
  }

  async function expectRefusedCopy(f: Awaited<ReturnType<typeof fixture>>, guard: () => void) {
    await expect(f.copy(guard)).rejects.toThrow("allocation lease lost");
    await expect(fs.access(f.destinationIndex)).rejects.toMatchObject({ code: "ENOENT" });
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
    try {
      expect(await f.copy()).toBe(true);
      expect(schedule).not.toHaveBeenCalled();
    } finally {
      schedule.mockRestore();
      syncBuiltinESMExports();
    }
    expect(await status(f.destination)).toBe("");
    await modify(f.destination, "clean");
    expect(await status(f.destination)).toBe("M clean");
  });

  it.each(["sha1", "sha256"])(
    "refreshes %s clone identities without hiding existing or later edits",
    async (algorithm) => {
      const f = await fixture(algorithm);
      const sourceIndex = await fs.readFile(f.sourceIndex);
      await modify(f.destination, "dirty-destination");
      await modify(f.source, "dirty-source");
      expect(await f.copy()).toBe(true);
      const debugBefore = await debug(f.destination);
      const stat = await fs.lstat(path.join(f.destination, "clean"), { bigint: true });
      expect(debugBefore).toContain(`ino: ${Number(stat.ino & 0xffffffffn)}`);
      expect(await status(f.destination)).toBe("M dirty-destination");
      expect(await debug(f.destination)).toBe(debugBefore);
      expect(await fs.readFile(f.sourceIndex)).toEqual(sourceIndex);
      expect(await git(f.destination, "diff", "--cached", "--name-only")).toBe("");

      await modify(f.destination, "clean");
      expect((await fs.stat(path.join(f.destination, "clean"), { bigint: true })).mtimeNs).toBe(
        BigInt(originalTime) * 1_000_000_000n,
      );
      expect(await status(f.destination)).toBe("M clean\n M dirty-destination");
    },
  );

  it("leaves racy source entries for Git to verify", async () => {
    const f = await fixture();
    await fs.utimes(f.sourceIndex, originalTime, originalTime);
    expect(await f.copy()).toBe(true);
    expect(await debug(f.destination)).toBe(await debug(f.source));
    await git(f.destination, "update-index", "--refresh");
    expect(await status(f.destination)).toBe("");
  });

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

  it("does not publish an index after allocation authority is lost", async () => {
    const f = await fixture();
    await expectRefusedCopy(f, () => {
      throw new Error("allocation lease lost");
    });
  });

  it("observes allocation authority loss while skipping ineligible entries", async () => {
    const f = await fixture();
    await fs.utimes(f.sourceIndex, originalTime, originalTime);
    let authorized = true;
    await expectRefusedCopy(f, () => {
      if (!authorized) {
        throw new Error("allocation lease lost");
      }
      setImmediate(() => {
        authorized = false;
      });
    });
  });

  it("leaves files changed during a metadata batch for Git to validate", async () => {
    const f = await fixture();
    const before = await debug(f.source);
    const readMetadata = nativeWorktreeFilesystem.readMetadata;
    const now = vi.spyOn(Date, "now");
    const metadata = vi
      .spyOn(nativeWorktreeFilesystem, "readMetadata")
      .mockImplementation(async (files, options) => {
        const file = path.join(f.destination, "clean");
        await fs.chmod(file, (await fs.stat(file)).mode & 0o777);
        const values = await readMetadata(files, options);
        now.mockReturnValue(Date.now() + 2_000);
        return values;
      });
    try {
      expect(await f.copy()).toBe(true);
    } finally {
      metadata.mockRestore();
      now.mockRestore();
    }
    expect(await debug(f.destination)).toBe(before);
    await git(f.destination, "update-index", "--refresh");
    expect(await status(f.destination)).toBe("");
  });
});
