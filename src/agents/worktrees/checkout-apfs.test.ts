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

  it("does not wait again when Git preparation outlasts the clone timestamp boundary", async () => {
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
    expect(await git(f.destination, "status", "--porcelain")).toBe("");
    await fs.writeFile(path.join(f.destination, "clean"), "modified\n");
    await fs.utimes(path.join(f.destination, "clean"), originalTime, originalTime);
    expect(await git(f.destination, "status", "--porcelain")).toBe("M clean");
  });

  it.each(["sha1", "sha256"])(
    "refreshes %s clone identities without hiding existing or later edits",
    async (algorithm) => {
      const f = await fixture(algorithm);
      const sourceIndex = await fs.readFile(f.sourceIndex);
      await fs.writeFile(path.join(f.destination, "dirty-destination"), "modified\n");
      await fs.utimes(path.join(f.destination, "dirty-destination"), originalTime, originalTime);
      await fs.writeFile(path.join(f.source, "dirty-source"), "modified\n");
      await fs.utimes(path.join(f.source, "dirty-source"), originalTime, originalTime);
      expect(await f.copy()).toBe(true);
      const debugBefore = await git(f.destination, "ls-files", "--debug", "clean");
      const stat = await fs.lstat(path.join(f.destination, "clean"), { bigint: true });
      expect(debugBefore).toContain(`ino: ${Number(stat.ino & 0xffffffffn)}`);
      expect(await git(f.destination, "status", "--porcelain")).toBe("M dirty-destination");
      expect(await git(f.destination, "ls-files", "--debug", "clean")).toBe(debugBefore);
      expect(await fs.readFile(f.sourceIndex)).toEqual(sourceIndex);
      expect(await git(f.destination, "diff", "--cached", "--name-only")).toBe("");

      await fs.writeFile(path.join(f.destination, "clean"), "modified\n");
      await fs.utimes(path.join(f.destination, "clean"), originalTime, originalTime);
      expect((await fs.stat(path.join(f.destination, "clean"), { bigint: true })).mtimeNs).toBe(
        BigInt(originalTime) * 1_000_000_000n,
      );
      expect(await git(f.destination, "status", "--porcelain")).toBe(
        "M clean\n M dirty-destination",
      );
    },
  );

  it("leaves racy source entries for Git to verify", async () => {
    const f = await fixture();
    await fs.utimes(f.sourceIndex, originalTime, originalTime);
    expect(await f.copy()).toBe(true);
    expect(await git(f.destination, "ls-files", "--debug", "clean")).toBe(
      await git(f.source, "ls-files", "--debug", "clean"),
    );
    await git(f.destination, "update-index", "--refresh");
    expect(await git(f.destination, "status", "--porcelain")).toBe("");
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
    await expect(
      f.copy(() => {
        throw new Error("allocation lease lost");
      }),
    ).rejects.toThrow("allocation lease lost");
    await expect(fs.access(f.destinationIndex)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("observes allocation authority loss while skipping ineligible entries", async () => {
    const f = await fixture();
    await fs.utimes(f.sourceIndex, originalTime, originalTime);
    let authorized = true;
    await expect(
      f.copy(() => {
        if (!authorized) {
          throw new Error("allocation lease lost");
        }
        setImmediate(() => {
          authorized = false;
        });
      }),
    ).rejects.toThrow("allocation lease lost");
    await expect(fs.access(f.destinationIndex)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("leaves files changed during a metadata batch for Git to validate", async () => {
    const f = await fixture();
    const before = await git(f.source, "ls-files", "--debug", "clean");
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
    expect(await git(f.destination, "ls-files", "--debug", "clean")).toBe(before);
    await git(f.destination, "update-index", "--refresh");
    expect(await git(f.destination, "status", "--porcelain")).toBe("");
  });
});
