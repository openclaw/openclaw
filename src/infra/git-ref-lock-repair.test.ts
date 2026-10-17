import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { acquireFileLock } from "./file-lock.js";
import { clearStaleGitRemoteRefLocks } from "./git-ref-lock-repair.js";

const itLinux = it.runIf(process.platform === "linux");
const directories = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());

async function fixture() {
  const root = await fs.realpath(directories.make("openclaw-ref-lock-repair-"));
  const commonDirectory = path.join(root, "git");
  const origin = path.join(commonDirectory, "refs/remotes/origin");
  await fs.mkdir(origin, { recursive: true });
  const disk = await fs.statfs(commonDirectory);
  disk.type = 0xef53;
  vi.spyOn(fs, "statfs").mockResolvedValue(disk);
  vi.spyOn(os, "uptime").mockReturnValue(3_600);
  // The fixture's unchanged inodes precede a simulated reboot by two hours.
  const now = Date.now() + 3 * 60 * 60_000;
  vi.spyOn(Date, "now").mockReturnValue(now);
  const repair = (refs: string[], assertCurrent = () => {}) =>
    clearStaleGitRemoteRefLocks({ commonDirectory, refs, assertCurrent });
  return { root, commonDirectory, origin, now, disk, repair };
}

itLinux(
  "clears abandoned pre-boot tracking locks while preserving uncertain and local refs",
  async () => {
    const f = await fixture();
    const files = ["abandoned", "same-boot", "nonempty", "hardlinked"];
    for (const name of files) {
      await fs.writeFile(path.join(f.origin, `${name}.lock`), name === "nonempty" ? "pending" : "");
    }
    const sameBoot = path.join(f.origin, "same-boot.lock");
    await fs.utimes(sameBoot, new Date(f.now), new Date(f.now));
    await fs.link(path.join(f.origin, "hardlinked.lock"), path.join(f.root, "other-owner"));
    await fs.mkdir(path.join(f.commonDirectory, "refs/heads"));
    const local = path.join(f.commonDirectory, "refs/heads/local.lock");
    await fs.writeFile(local, "");
    await expect(
      f.repair([...files.map((name) => `refs/remotes/origin/${name}`), "refs/heads/local"]),
    ).resolves.toBe(1);
    await expect(fs.lstat(path.join(f.origin, "abandoned.lock"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    for (const name of files.slice(1)) {
      await expect(fs.lstat(path.join(f.origin, `${name}.lock`))).resolves.toBeDefined();
    }
    await expect(fs.lstat(local)).resolves.toBeDefined();
  },
);

itLinux(
  "preserves locks reached through symlinks and paths outside the tracking namespace",
  async () => {
    const f = await fixture();
    const outside = path.join(f.root, "outside");
    await fs.mkdir(outside);
    await fs.writeFile(path.join(outside, "tip.lock"), "");
    await fs.symlink(outside, path.join(f.origin, "linked"), "dir");
    await fs.symlink(path.join(outside, "tip.lock"), path.join(f.origin, "tip.lock"));
    await expect(
      f.repair([
        "refs/remotes/origin/linked/tip",
        "refs/remotes/origin/tip",
        "refs/remotes/origin/../../../../outside/tip",
      ]),
    ).resolves.toBe(0);
    await expect(fs.lstat(path.join(outside, "tip.lock"))).resolves.toBeDefined();
    expect((await fs.lstat(path.join(f.origin, "tip.lock"))).isSymbolicLink()).toBe(true);
  },
);

itLinux.each(["network filesystem", "unavailable filesystem", "same boot"])(
  "preserves empty locks with %s evidence",
  async (reason) => {
    const f = await fixture();
    const target = path.join(f.origin, "tip.lock");
    await fs.writeFile(target, "");
    if (reason === "network filesystem") {
      f.disk.type = 0x6969;
    } else if (reason === "unavailable filesystem") {
      vi.mocked(fs.statfs).mockRejectedValue(new Error("unavailable"));
    } else {
      vi.mocked(os.uptime).mockReturnValue(24 * 3_600);
    }
    await expect(f.repair(["refs/remotes/origin/tip"])).resolves.toBe(0);
    await expect(fs.lstat(target)).resolves.toBeDefined();
  },
);

itLinux("preserves a lock replaced during inspection", async () => {
  const f = await fixture();
  const target = path.join(f.origin, "tip.lock");
  const replacement = path.join(f.origin, "replacement.lock");
  await fs.writeFile(target, "");
  await fs.writeFile(replacement, "replacement owner");
  const lstat = fs.lstat;
  let observations = 0;
  vi.spyOn(fs, "lstat").mockImplementation(async (...args) => {
    if (args[0] === target && ++observations === 2) {
      await fs.rename(replacement, target);
    }
    return await lstat(...args);
  });
  await expect(f.repair(["refs/remotes/origin/tip"])).resolves.toBe(0);
  await expect(fs.readFile(target, "utf8")).resolves.toBe("replacement owner");
});

itLinux("preserves native locks while another repair owns reclamation", async () => {
  const f = await fixture();
  const target = path.join(f.origin, "tip.lock");
  await fs.writeFile(target, "");
  const owner = await acquireFileLock(path.join(f.commonDirectory, "openclaw-ref-lock-repair"), {
    retries: { retries: 0, factor: 1, minTimeout: 0, maxTimeout: 0 },
    stale: 0,
    staleRecovery: "remove-if-definitely-stale",
  });
  try {
    await expect(f.repair(["refs/remotes/origin/tip"])).resolves.toBe(0);
    await expect(fs.lstat(target)).resolves.toBeDefined();
  } finally {
    await owner.release();
  }
  await expect(f.repair(["refs/remotes/origin/tip"])).resolves.toBe(1);
});

itLinux("revalidates authority after inspecting the candidate lock", async () => {
  const f = await fixture();
  const target = path.join(f.origin, "tip.lock");
  await fs.writeFile(target, "");
  const open = fs.open;
  let revoked = false;
  vi.spyOn(fs, "open").mockImplementation(async (...args) => {
    const handle = await open(...args);
    revoked = true;
    return handle;
  });
  await expect(
    f.repair(["refs/remotes/origin/tip"], () => {
      if (revoked) {
        throw new Error("lease revoked");
      }
    }),
  ).rejects.toThrow("lease revoked");
  await expect(fs.lstat(target)).resolves.toBeDefined();
});
