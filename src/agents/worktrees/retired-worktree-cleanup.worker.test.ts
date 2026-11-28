import fsSync from "node:fs";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import timers from "node:timers/promises";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { runtimeProcessEntrypoints } from "../../infra/runtime-process-entrypoints.js";
import {
  resolveRuntimeWorkerArgv,
  resolveRuntimeWorkerUrl,
} from "../../infra/runtime-worker-url.js";
import { runCommandWithTimeout } from "../../process/exec.js";

const directories = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => {
  vi.restoreAllMocks();
  syncBuiltinESMExports();
});

it.each([
  ["btrfs", "7:0", [132, 132, 132, 4]],
  ["ext4", "7:0", [132, 4]],
  ["btrfs", "7:1", [132, 4]],
])("paces reservations only on the removal filesystem (%s, %s)", async (type, device, expected) => {
  vi.resetModules();
  const root = directories.make("retired-reservation-");
  const retired = path.join(root, "retired");
  const volume = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
  const sysfs = path.join(root, "sys/fs/btrfs", volume);
  await fs.mkdir(retired);
  await fs.mkdir(path.join(sysfs, "devices/loop0"), { recursive: true });
  await fs.mkdir(path.join(sysfs, "allocation/metadata"), { recursive: true });
  await fs.writeFile(path.join(sysfs, "devices/loop0/dev"), `${device}\n`);
  const counter = path.join(sysfs, "allocation/metadata/bytes_may_use");
  await fs.writeFile(counter, "0\n");
  for (let index = 0; index < 260; index++) {
    await fs.writeFile(path.join(retired, String(index)), "x");
  }
  const open = fs.open.bind(fs);
  const readFile = fs.readFile.bind(fs);
  const readdir = fs.readdir.bind(fs);
  const stat = fs.stat.bind(fs);
  vi.spyOn(process, "platform", "get").mockReturnValue("linux");
  vi.spyOn(fs, "open").mockImplementation((target, flags, mode) =>
    open(
      String(target).startsWith("/sys/") || String(target).startsWith("/proc/")
        ? path.join(root, String(target))
        : target,
      flags,
      mode,
    ),
  );
  vi.spyOn(fs, "readFile").mockImplementation((target, options) => {
    if (typeof target === "string" && target.startsWith("/proc/self/fdinfo/")) {
      return Promise.resolve("mnt_id:\t123\n");
    }
    if (target === "/proc/self/mountinfo") {
      return Promise.resolve(`123 1 0:42 / / rw - ${type} /dev/loop0 rw\n`);
    }
    return readFile(target, options);
  });
  vi.spyOn(fs, "readdir").mockImplementation((target, options) =>
    readdir(String(target).startsWith("/sys/") ? path.join(root, String(target)) : target, options),
  );
  vi.spyOn(fs, "stat").mockImplementation(async (target, options) => {
    if (target === "/dev/loop0") {
      return Object.assign(await stat(retired, { bigint: true }), { rdev: 1792n });
    }
    return stat(target, options);
  });
  const remaining: number[] = [];
  const values = [41, 30, 19, 0];
  vi.spyOn(timers, "setTimeout").mockImplementation(async () => {
    remaining.push(fsSync.readdirSync(retired).length);
    await fs.writeFile(counter, String((values.shift() ?? 0) * 1024 ** 3));
  });
  const argv = process.argv;
  const exitCode = process.exitCode;
  syncBuiltinESMExports();
  process.argv = [argv[0]!, argv[1]!, retired];
  try {
    for (let pass = 0; pass < 5; pass++) {
      vi.resetModules();
      process.exitCode = undefined;
      await import("./retired-worktree-cleanup.worker.js");
      if (process.exitCode !== 75) {
        break;
      }
      process.argv[3] = "resume";
      // Parent cooldown; the next worker rediscovers the same remaining tree.
      await timers.setTimeout(30_000);
    }
  } finally {
    process.argv = argv;
    process.exitCode = exitCode;
  }
  expect(remaining).toEqual(expected);
  expect(fsSync.existsSync(retired)).toBe(false);
});

it("yields the pass on pressure before issuing another unlink burst", async () => {
  vi.resetModules();
  const root = directories.make("retired-worktree-batches-");
  const retired = path.join(root, "retired");
  await fs.mkdir(retired);
  for (let index = 0; index < 260; index++) {
    await fs.writeFile(path.join(retired, String(index)), "x");
  }
  const probe = vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true);
  const probeModule = await import("../../infra/host-io-pressure.js");
  vi.spyOn(probeModule, "createHostIoPressureProbe").mockReturnValue(probe);
  vi.spyOn(timers, "setTimeout").mockResolvedValue(undefined);
  const argv = process.argv;
  const exitCode = process.exitCode;
  syncBuiltinESMExports();
  process.argv = [argv[0]!, argv[1]!, retired];
  try {
    await import("./retired-worktree-cleanup.worker.js");
    expect(process.exitCode).toBe(75);
    expect(fsSync.readdirSync(retired)).toHaveLength(132);
  } finally {
    process.argv = argv;
    process.exitCode = exitCode;
  }
});

it("paces large files separately and unlinks symlinks without visiting their targets", async () => {
  vi.resetModules();
  const root = directories.make("retired-worktree-bytes-");
  const retired = path.join(root, "retired");
  const outside = path.join(root, "preserved");
  await fs.mkdir(retired);
  await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, "keep"), "user data");
  await fs.symlink(outside, path.join(retired, "link"), "junction");
  for (const [name, size] of [
    ["a", 5],
    ["b", 5],
    ["large", 10],
  ] as const) {
    const file = await fs.open(path.join(retired, name), "w");
    await file.truncate(size * 1024 * 1024);
    await file.close();
  }
  const probeModule = await import("../../infra/host-io-pressure.js");
  vi.spyOn(probeModule, "createHostIoPressureProbe").mockReturnValue(async () => false);
  const batches: { entries: number; bytes: number }[] = [];
  let batch = { entries: 0, bytes: 0 };
  const unlink = fsSync.unlinkSync;
  const rmdir = fsSync.rmdirSync;
  vi.spyOn(fsSync, "unlinkSync").mockImplementation((target) => {
    const stat = fsSync.lstatSync(target);
    batch.entries++;
    batch.bytes += stat.isFile() ? stat.size : 0;
    unlink(target);
  });
  vi.spyOn(fsSync, "rmdirSync").mockImplementation((target) => {
    batch.entries++;
    rmdir(target);
  });
  vi.spyOn(timers, "setTimeout").mockImplementation(async () => {
    batches.push(batch);
    batch = { entries: 0, bytes: 0 };
  });
  syncBuiltinESMExports();
  const argv = process.argv;
  process.argv = [argv[0]!, argv[1]!, retired];
  try {
    await import("./retired-worktree-cleanup.worker.js");
  } finally {
    process.argv = argv;
  }
  batches.push(batch);
  expect(batches.length).toBeGreaterThanOrEqual(3);
  for (const observed of batches) {
    expect(observed.entries).toBeLessThanOrEqual(128);
    expect(observed.bytes <= 8 * 1024 * 1024 || observed.entries === 1).toBe(true);
  }
  expect(batches.reduce((sum, observed) => sum + observed.bytes, 0)).toBe(20 * 1024 * 1024);
  expect(await fs.readFile(path.join(outside, "keep"), "utf8")).toBe("user data");
  expect(fsSync.existsSync(retired)).toBe(false);
});

it("removes only the retired checkout and completes when it is already absent", async () => {
  const root = directories.make("retired-worktree-cleanup-");
  const retired = path.join(root, ".openclaw-removing-test");
  const preserved = path.join(root, "active.txt");
  await fs.mkdir(path.join(retired, "nested"), { recursive: true });
  await fs.writeFile(path.join(retired, "nested", "file.txt"), "retired bytes");
  await fs.writeFile(preserved, "active bytes");
  const argv = [
    process.execPath,
    ...resolveRuntimeWorkerArgv(
      resolveRuntimeWorkerUrl(runtimeProcessEntrypoints.retiredWorktreeCleanup),
    ),
    retired,
  ];
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const result = await runCommandWithTimeout(argv, { timeoutMs: 10_000 });
    expect(result).toMatchObject({ code: 0, termination: "exit" });
    await expect(fs.stat(retired)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await fs.readFile(preserved, "utf8")).toBe("active bytes");
  }
});

it("removes owned read-only directories such as a Go module cache", async () => {
  const root = directories.make("retired-worktree-readonly-");
  const retired = path.join(root, ".openclaw-removing-test");
  const module = path.join(retired, "mod", "filippo.io", "age@v1.3.2");
  await fs.mkdir(module, { recursive: true });
  await fs.writeFile(path.join(module, ".gitattributes"), "* text=auto");
  await fs.chmod(path.join(module, ".gitattributes"), 0o444);
  await fs.chmod(module, 0o555);
  await fs.chmod(path.dirname(module), 0o500);
  const argv = [
    process.execPath,
    ...resolveRuntimeWorkerArgv(
      resolveRuntimeWorkerUrl(runtimeProcessEntrypoints.retiredWorktreeCleanup),
    ),
    retired,
  ];
  const result = await runCommandWithTimeout(argv, { timeoutMs: 10_000 });
  expect(result).toMatchObject({ code: 0, termination: "exit" });
  await expect(fs.stat(retired)).rejects.toMatchObject({ code: "ENOENT" });
});

it("yields a large tree in bounded passes and resumes from the remaining files", async () => {
  const root = directories.make("retired-worktree-passes-");
  const retired = path.join(root, "retired");
  await fs.mkdir(retired);
  for (let index = 0; index < 65; index++) {
    await fs.writeFile(path.join(retired, String(index)), "x");
  }
  let now = 0;
  vi.spyOn(process, "platform", "get").mockReturnValue("linux");
  vi.spyOn(performance, "now").mockImplementation(() => now);
  const unlink = fsSync.unlinkSync;
  vi.spyOn(fsSync, "unlinkSync").mockImplementation((target) => {
    unlink(target);
    now += 1_000;
  });
  const argv = process.argv;
  const exitCode = process.exitCode;
  const remaining: number[] = [];
  syncBuiltinESMExports();
  process.argv = [argv[0]!, argv[1]!, retired];
  try {
    for (let pass = 0; pass < 3; pass++) {
      vi.resetModules();
      const probeModule = await import("../../infra/host-io-pressure.js");
      vi.spyOn(probeModule, "createHostIoPressureProbe").mockReturnValue(async () => false);
      process.exitCode = undefined;
      await import("./retired-worktree-cleanup.worker.js");
      remaining.push(fsSync.existsSync(retired) ? fsSync.readdirSync(retired).length : 0);
      expect(process.exitCode).toBe(pass < 2 ? 75 : undefined);
      now += 30_000;
    }
  } finally {
    process.argv = argv;
    process.exitCode = exitCode;
  }
  expect(remaining).toEqual([35, 5, 0]);
});
